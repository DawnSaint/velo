<script setup lang="ts">
// 源代码模式 —— CodeMirror 6 编辑器 + shiki 高亮 + 行号。
//
// 从 pre+textarea overlay 换成 CM6。软换行 + 行号让 overlay 必须手搓
// 像素测量层(textarea 拿不到第 N 行折到哪个像素 Y),CM6 的 lineNumbers 免费
// 覆盖。shiki 高亮走 shikiCmPlugin(ViewPlugin → Decoration.mark),与 WYSIWYG
// 的 CodeHighlightWidget 同形(token hex 写局部 CSS 变量 --shiki-light/dark)。
//
// 保留旧版行为:Tab 插 2 空格、Esc 退出源码模式、外部 modelValue 同步、
// documentStore.content 唯一数据源、自动保存/草稿/fs:watch 透明穿透。
//
// 主题镜像 + ensureTheme 串行 + 不全黑:机制等价于旧版(见 shikiCmPlugin.ts
// 文件头),dispatch target 从 Vue ref 改 CM6 state effect(setShikiTheme)。

import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { EditorView, keymap, lineNumbers, drawSelection, highlightSpecialChars } from '@codemirror/view'
import { EditorState, EditorSelection } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  ensureTheme,
  ensureMarkdownGrammar,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
} from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import {
  shikiExtensions,
  setShikiTheme,
} from '@/components/ProseMirrorEditor/nodes/shikiCmPlugin'
import FindReplace from '@/components/ProseMirrorEditor/findreplace/FindReplace.vue'
import { createCmBackend } from '@/components/ProseMirrorEditor/findreplace/backend'
import { cmFindHighlightField } from '@/components/ProseMirrorEditor/findreplace/cmFindHighlight'

const props = withDefaults(defineProps<{
  modelValue: string
  darkMode?: boolean
  /** 查找面板开关。v-model:find-open 双绑,App.vue 持有(与 ProseMirrorEditor 对仗)。 */
  findOpen?: boolean
}>(), {
  modelValue: '',
  darkMode: false,
  findOpen: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** v-model:find-open 的 update 端。FindReplace 关闭时触发,父级翻成 false。 */
  'update:findOpen': [open: boolean]
}>()

const documentStore = useDocumentStore()
const editorStore = useEditorStore()

const hostRef = ref<HTMLDivElement | null>(null)
const viewRef = shallowRef<EditorView | null>(null)

// ============================================================
//  主题镜像 —— 初值取自 store(App.vue codeBlockReady 已 ensure 过 bootstrap
//  主题,等价于已装)。watch 只管"用户在 settings 面板后续改"。
// ============================================================
const lightTheme = ref(editorStore.codeLightTheme || DEFAULT_LIGHT_THEME)
const darkTheme = ref(editorStore.codeDarkTheme || DEFAULT_DARK_THEME)

// shiki extensions 初值用本地镜像;后续主题切换走 setShikiTheme effect。
const shikiExts = shikiExtensions({
  lightTheme: lightTheme.value,
  darkTheme: darkTheme.value,
})

// echo 哨兵:自身 emit 的回写不要再当外部 modelValue 处理(对照 documentStore
// 的 lastSelfEmitted 语义)。CM6 docChanged 时记下本次发出去的串,外部 watch
// 拿到 modelValue 若等于它,跳过同步。
let lastSelfEmitted = ''

// ============================================================
//  Tab → 插 2 空格(保留旧 textarea 行为),覆盖 indentWithTab
// ============================================================
const tabKeymap = keymap.of([{
  key: 'Tab',
  preventDefault: true,
  run(view: EditorView): boolean {
    const { from, to } = view.state.selection.main
    // 有选区时不插空格,返回 false 让 indentWithTab 接管;无选区插 2 空格
    if (from !== to) return false
    view.dispatch(view.state.changeByRange((range) => {
      const insert = '  '
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      }
    }))
    return true
  },
}])

// Escape → 退出源码模式(保留旧 textarea 行为)
const escKeymap = keymap.of([{
  key: 'Escape',
  preventDefault: true,
  run(): boolean {
    documentStore.toggleSourceMode()
    return true
  },
}])

// 源代码模式禁止拖入 / 粘贴图片(对齐 Typora 源码模式设计)。
// 两件事:
//   1. 文件型 drop 必须 preventDefault —— 否则 webview(dragDropEnabled:false
//      下拿到原生 drag 事件)把拖入的文件当"打开"导航掉,整页跳走。PM 模式由
//      imageUploadPlugin.handleDOMEvents.drop 兜这个 preventDefault,源码模式
//      没有等价 PM 插件,这里补上。
//   2. image/* paste 吞掉 —— CM6 默认 paste 不处理 File,但浏览器可能把图片
//      当 HTML <img data:...> 塞进来产生垃圾文本。源码模式不插图,直接拦。
// 非图片的纯文本 drop/paste 放行给 CM6 默认处理(返回 false)。
const forbidFileDropPaste = EditorView.domEventHandlers({
  drop(event: DragEvent) {
    const dt = event.dataTransfer
    const isFileDrop = dt?.types && Array.from(dt.types).includes('Files')
    if (!isFileDrop) return false
    event.preventDefault()
    return true
  },
  paste(event: ClipboardEvent) {
    const files = event.clipboardData?.files
    if (!files || files.length === 0) return false
    for (let i = 0; i < files.length; i++) {
      if (files[i]?.type.startsWith('image/')) {
        event.preventDefault()
        return true
      }
    }
    return false
  },
})

// ============================================================
//  mount CM6
// ============================================================
function createView(): EditorView {
  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      lineNumbers(),
      EditorView.lineWrapping,
      drawSelection(),
      highlightSpecialChars(),
      history(),
      tabKeymap,
      escKeymap,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      forbidFileDropPaste,
      shikiExts,
      // 查找替换高亮 StateField(与 PM 侧 findHighlight 对仗,FindReplace 经
      // CM6 后端 dispatch cmFindHighlightEffect 驱动)。必须装在 state 里,
      // 后端 setHighlight 才有 effect 接收方。
      cmFindHighlightField,
      // docChanged → 回写 documentStore.content
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return
        const next = u.state.doc.toString()
        lastSelfEmitted = next
        emit('update:modelValue', next)
      }),
    ],
  })
  const view = new EditorView({ state, parent: hostRef.value! })
  return view
}

// ============================================================
//  外部 modelValue 变化 → 同步进 CM6(非自身 emit)
// ============================================================
watch(
  () => props.modelValue,
  (next) => {
    const view = viewRef.value
    if (!view) return
    // 自身刚 emit 的回写,跳过(避免光标被重置)
    if (next === lastSelfEmitted) return
    if (next === view.state.doc.toString()) return
    // 替换 doc,尽量保留光标(若越界则夹到末尾)
    const oldSel = view.state.selection.main
    const docLen = next.length
    const head = Math.min(oldSel.head, docLen)
    const anchor = Math.min(oldSel.anchor, docLen)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: EditorSelection.range(anchor, head),
    })
  },
)

// ============================================================
//  代码块主题切换 → ensureTheme 串行 → dispatch setShikiTheme 触发 rebuild
// ============================================================
//
// 跟 App.vue 第 4.5 段 PM 路径对仗:主题变了先把 theme hex 装进 hl
// (ensureTheme 是 async,主题未装时 shiki 会让 token.variants.light.color
// 静默返回 undefined → 全黑),resolve 后才 dispatch setShikiTheme effect
// 让 ViewPlugin 用新主题名 rebuild。store mutate 本身不触发 rebuild,只有
// effect dispatch 后(= ensureTheme 已完成 = shiki 已拿到真 hex)才 rebuild。
watch(
  () => [editorStore.codeLightTheme, editorStore.codeDarkTheme] as const,
  async ([light, dark]) => {
    await ensureTheme(light)
    await ensureTheme(dark)
    lightTheme.value = light
    darkTheme.value = dark
    const view = viewRef.value
    if (!view) return
    view.dispatch({
      effects: setShikiTheme.of({ lightTheme: light, darkTheme: dark }),
    })
  },
)

// ============================================================
//  挂载 / 销毁
// ============================================================
onMounted(async () => {
  if (!hostRef.value) return
  const view = createView()
  viewRef.value = view
  view.focus()
  void ensureMarkdownGrammar()
})

onBeforeUnmount(() => {
  viewRef.value?.destroy()
  viewRef.value = null
})

// ============================================================
//  对外暴露 view(后续阶段 FindReplace / 跨模式同步要用)
// ============================================================
defineExpose({
  get view() { return viewRef.value },
})
</script>

<template>
  <div class="velo-editor-card relative flex-1 rounded-2xl mx-6 mb-6 shadow-xl bg-white dark:bg-[#1e1e1e]">
    <!-- CM6 自身 .cm-scroller 负责滚动(保证光标 auto-scroll 跟随),故外层不
         再 overflow-auto,避免双层滚动条。**不加 px**:px 会把 scroller 从卡片
         右边缘往里推 → 垂直滚动条不靠边。左右透气由 .cm-content 的 64vw 居中
         列 auto margin 提供,垂直透气保留 py-6。 -->
    <div class="flex h-full w-full">
      <div
        class="velo-cm-source w-full h-full"
        :class="{ 'dark': props.darkMode }"
      >
        <div ref="hostRef" class="velo-cm-host" />
      </div>
    </div>
    <!-- 查找替换面板:与 ProseMirrorEditor 共用同一份 FindReplace.vue,
         仅后端不同(CM6)。findOpen 由 App.vue 透传;用户意图(query / 选项)经
         App.vue provide → FindReplace inject 共享,切模式时面板保持打开、query 保留。 -->
    <FindReplace
      :open="props.findOpen"
      :backend-getter="() => viewRef ? createCmBackend(viewRef) : null"
      @close="emit('update:findOpen', false)"
    />
  </div>
</template>

<style>
/* 源代码模式 CodeMirror 6 —— 跟 ProseMirror 编辑器同套排版。
   细节配色(行号 / token / 选区 / 暗色翻面)走 _editor-code.scss 的
   .velo-cm-source 规则,这里只放 CM6 容器占满高度的骨架。 */

.velo-cm-host {
  height: 100%;
}

.velo-cm-host .cm-editor {
  height: 100%;
}

.velo-cm-host .cm-scroller {
  overflow: auto;
}
</style>

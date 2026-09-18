<script setup lang="ts">
// WysiwygDiffView(#diff-wysiwyg):WYSIWYG diff 视图。
//
// 在 ProseMirror 只读渲染上叠加 Decoration 标记增删:
// - 绿色背景 = 新增文本(Decoration.inline)
// - 红色背景 = 删除文本(Decoration.widget,不占文档 pos,只视觉呈现)
//
// 与源码 diff(DiffView.vue 的行级列表)共用同一 diff 算法结果(Myers),
// 切换模式不重算 diff。
//
// 只读 PM 渲染:复用项目 schema + fromMarkdown,装最小化插件集
// (仅视觉渲染需要的 NodeView / Decoration,不含编辑类插件)。
//
// 增量渲染(#diff-incremental):
// - 选中版本条目变化时**不销毁重建 EditorView**
//   - newContent 变 → 换成新 doc 的新 state(view.updateState),复用同一批插件实例
//   - oldContent 变 → 只 dispatch setMeta(diffDecorationKey,{ oldDoc }),
//     decoration 由插件增量重建
// - 挂载 viewportPlugin 让 diffDecoration 视口感知:长文档只为可见 block 构建装饰,
//   滚动时按需追加(player-common sticky 范式)

import { onMounted, onBeforeUnmount, ref, watch, shallowRef } from 'vue'
import { EditorState, Plugin, PluginKey } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { convertFileSrc } from '@tauri-apps/api/core'
import { baseKeymap } from 'prosemirror-commands'
import { schema as veloSchema, type VeloSchema } from './editor/schema'
import { fromMarkdown } from './editor/markdownIO'
import { setDiffOldDoc, diffDecorationPlugin } from './plugins/diffDecoration'
import { viewportPlugin, setInitialViewportHint, refreshViewport } from './nodes/viewportPlugin'
import { createImageNodeView } from './editor/imageNodeView'
import { createHrNodeView } from './nodes/HrNodeView'
import { createEmojiNodeView } from './nodes/EmojiNodeView'
import { frontmatterNodeViewPlugin } from './nodes/FrontmatterNodeView'
import { createHtmlNodeViewPlugin } from './nodes/HtmlNodeView'
import { mathEditPlugin } from './nodes/MathNodeViews'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin } from './nodes/FootnoteNodeViews'
import { tocDecoration } from './nodes/TocDecoration'
import { codeHighlightPlugin } from './nodes/CodeHighlightWidget'
import { codeWrapPlugin } from './nodes/CodeWrapPlugin'
import { codeLineNumberPlugin } from './nodes/CodeLineNumberWidget'
import { findHighlight } from './findreplace/findHighlight'
import type { Node as PMNode } from 'prosemirror-model'

const props = defineProps<{
  /** 新版本 markdown(当前选中条目的 content) */
  newContent: string
  /** 旧版本 markdown(前一版本的 content) */
  oldContent: string
}>()

const containerRef = ref<HTMLElement | null>(null)
const viewRef = shallowRef<EditorView | null>(null)
const error = ref<string | null>(null)
/** 插件实例数组:updateState 换新 doc 时必须复用同一批实例(否则 plugin state 全丢) */
let pluginInstances: Plugin[] | null = null

// 图片 src 解析:与 EditorInner.vue 的 resolveImageSrc 同逻辑
function resolveImageSrc(url: string): string {
  if (!url) return url
  // http(s) / data: 直接用
  if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url
  // 绝对路径 / 相对路径 → Tauri asset:// 代理
  try {
    return convertFileSrc(url)
  } catch {
    return url
  }
}

const imageNodeView = createImageNodeView({ proxyDomURL: resolveImageSrc })
const htmlNodeViewPlugin = createHtmlNodeViewPlugin({ proxyDomURL: resolveImageSrc })

// 最小化插件集:只保留视觉渲染需要的插件,不含编辑类(keymap/inputrules/history/paste 等)
function buildPlugins(): Plugin[] {
  return [
    // 只读模式仍需 baseKeymap 支持选区导航(方向键 / Cmd+A 等)
    keymap(baseKeymap),
    // ── Viewport(须先于读取 viewport state 的 decoration 插件)──
    viewportPlugin,
    // ── Code Decorations ──
    codeHighlightPlugin,
    codeWrapPlugin,
    codeLineNumberPlugin,
    // ── NodeView ──
    new Plugin({ key: new PluginKey('imageInlineView'), props: { nodeViews: { image: imageNodeView } } }),
    new Plugin({ key: new PluginKey('hrNodeView'), props: { nodeViews: { hr: createHrNodeView() } } }),
    new Plugin({ key: new PluginKey('emojiNodeView'), props: { nodeViews: { emoji: createEmojiNodeView() } } }),
    frontmatterNodeViewPlugin,
    htmlNodeViewPlugin,
    // ── Math & Mermaid ──
    mathEditPlugin,
    mermaidDecoration,
    // ── Misc Decorations ──
    taskListPlugin,
    footnoteEditPlugin,
    tocDecoration,
    findHighlight,
    // ── Diff 装饰(核心) ──
    diffDecorationPlugin,
  ]
}

function parseMarkdown(md: string): PMNode | null {
  try {
    return fromMarkdown(md, veloSchema as VeloSchema)
  } catch {
    return null
  }
}

/** 首屏优化的窄 viewport hint:让 decoration 插件先只为首屏构建,随后 rAF 刷真值 */
const FIRST_SCREEN_HINT = { from: 0, to: 5000 }

function makeState(doc: PMNode): EditorState {
  if (!pluginInstances) pluginInstances = buildPlugins()
  setInitialViewportHint(FIRST_SCREEN_HINT)
  try {
    return EditorState.create({ schema: veloSchema, doc, plugins: pluginInstances })
  } finally {
    setInitialViewportHint(null) // 防止泄漏到后续 state 创建
  }
}

/** 注入 diff 基准(oldDoc),由插件增量重建 decoration —— 不重建 view */
function applyOldDoc(view: EditorView) {
  setDiffOldDoc(view, parseMarkdown(props.oldContent))
}

function createView() {
  if (!containerRef.value) return
  error.value = null

  try {
    const newDoc = parseMarkdown(props.newContent)
    if (!newDoc) throw new Error('无法解析新版本内容')

    const view = new EditorView(containerRef.value, {
      state: makeState(newDoc),
      editable: () => false,
      // 只读模式:apply transaction 更新 state(让 diffDecoration plugin 的 setMeta 生效),
      // 但不触发 onChange 回写 —— 只读视图不需要序列化 markdown。
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr))
      },
    })

    viewRef.value = view
    applyOldDoc(view)
    // DOM 布局就绪后按真实视口补装饰(FIRST_SCREEN_HINT 只覆盖首屏)
    requestAnimationFrame(() => refreshViewport(view))
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 换新 doc:复用同一批插件实例 updateState,避免销毁重建 EditorView */
function replaceDoc(doc: PMNode) {
  const view = viewRef.value
  if (!view) return
  view.updateState(makeState(doc))
  requestAnimationFrame(() => refreshViewport(view))
}

onMounted(() => {
  createView()
})

onBeforeUnmount(() => {
  if (viewRef.value) {
    viewRef.value.destroy()
    viewRef.value = null
    pluginInstances = null
  }
})

// 选中条目变化时增量更新(#diff-incremental):
// newContent 变 → 换 doc;oldContent 变 → 只换 diff 基准
watch(() => props.newContent, (newVal, oldVal) => {
  const view = viewRef.value
  if (!view || newVal === oldVal) return
  const doc = parseMarkdown(newVal)
  if (!doc) return
  replaceDoc(doc)
  applyOldDoc(view)
})

watch(() => props.oldContent, (newVal, oldVal) => {
  if (newVal === oldVal) return
  if (viewRef.value) applyOldDoc(viewRef.value)
})
</script>

<template>
  <div class="velo-wysiwyg-diff-container h-full overflow-y-auto">
    <div v-if="error" class="p-4 text-sm text-red-500">
      diff 渲染失败:{{ error }}
    </div>
    <div ref="containerRef" class="velo-editor velo-diff-editor" />
  </div>
</template>

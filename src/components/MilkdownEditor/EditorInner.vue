<script setup lang="ts">
// Milkdown 编辑器（kit 风格）作为 @milkdown/vue 的 <Milkdown /> 内部。

import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  commonmark,
  emphasisSchema,
  emphasisUnderscoreInputRule,
} from '@milkdown/kit/preset/commonmark'
import {
  gfm,
  strikethroughSchema,
  strikethroughInputRule,
} from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { dropCursor } from '@milkdown/kit/prose/dropcursor'
import {
  imageInlineComponent,
  inlineImageConfig,
  defaultInlineImageConfig,
} from '@milkdown/kit/component/image-inline'
import { clipboard } from '@milkdown/plugin-clipboard'
import { math } from '@milkdown/plugin-math'
import { keymap } from '@milkdown/prose/keymap'
import { sinkListItem, liftListItem } from '@milkdown/prose/schema-list'
import { markRule } from '@milkdown/prose'
import type { EditorView } from '@milkdown/prose/view'
import { $inputRule, $prose } from '@milkdown/utils'
import { Milkdown, useEditor } from '@milkdown/vue'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from './nodes/MathNodeViews'
import { mermaidSyntax } from './nodes/MermaidSyntax'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin, footnoteReferenceInputRule } from './nodes/FootnoteNodeViews'
import { preserveEmptyLinePlugin } from './plugins/preserveEmptyLine'
import { findHighlight } from './findreplace/findHighlight'
import { imageKeymapPlugin } from './image/imageKeymap'
import { imageUploadPlugin } from './image/imageUploadPlugin'
import { saveImageAsset } from '@/services/imageStorage'
import { useDocumentStore } from '@/stores/document'
import { resolveImageAssetAbsPath } from '@/utils/imagePath'
import 'katex/dist/katex.min.css'

// 覆盖 Milkdown 内置行为：在标题前按退格 / 删除 → 直接转为正文，而非降级（h2→h1）
function headingToParagraph(state: any, dispatch?: any): boolean {
  const { $from } = state.selection
  const node = $from.node()
  if (
    node.type.name === 'heading'
    && state.selection.empty
    && $from.parentOffset === 0
  ) {
    if (dispatch) {
      const paragraphType = state.schema.nodes.paragraph
      dispatch(
        state.tr.setBlockType(
          $from.before(),
          $from.after(),
          paragraphType,
        ),
      )
    }
    return true
  }
  return false
}

const headingBackspaceToParagraph = $prose(() =>
  keymap({
    Backspace: headingToParagraph,
    Delete: headingToParagraph,
  }),
)

// 修 @milkdown/preset-commonmark / -gfm 里两条 markRule 的 bug：
//
//   commonmark/mark/emphasis.ts ：  /\b_(?![_\s])(.*?[^_\s])_\b/
//   gfm/mark/strike-through.ts ：   /(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/
//
// 这两条**正则结尾都没有 `$` 锚点**,会扫到段落里任意位置的 `_x_` / `~~x~~`,
// 包括 inline code 内部的(因为 textBetween 不带 mark 信息,code 里的字面字符
// 同样会被 regex 看到)。而 prosemirror-inputrules 调 handler 时按"匹配紧贴
// 光标"算 start:handler(state, m, from - (m[0].length - text.length), to) —
// 一旦匹配命中段落中间的某段 inline code,算出来的 start 落在光标附近,
// tr.delete / tr.addMark 跑到完全不相关的位置上,把 inline code 里的字吞掉,
// 还顺带把光标附近的字符乱加 emphasis。同时 handler 不插入用户当次键入,所以
// 这次输入也会丢。
//
// 别的几条 markRule(emphasisStarInputRule、strongInputRule、inlineCodeInputRule)
// 末尾都已经有 `$`,是安全的。所以我们只需要:
//   1) 从 commonmark / gfm 的 bundle 里过滤掉这两条
//   2) 注册一对带 `$` 锚点的修复版顶上
const fixedEmphasisUnderscoreInputRule = $inputRule(ctx =>
  markRule(/\b_(?![_\s])(.*?[^_\s])_\b$/, emphasisSchema.type(ctx), {
    getAttr: () => ({ marker: '_' }),
    updateCaptured: ({ fullMatch, start }) =>
      !fullMatch.startsWith('_')
        ? { fullMatch: fullMatch.slice(1), start: start + 1 }
        : {},
  }),
)

const fixedStrikethroughInputRule = $inputRule(ctx =>
  markRule(/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)$/, strikethroughSchema.type(ctx)),
)

const safeCommonmark = commonmark.filter(
  p =>
    // 上游 markRule bug 修复
    // image 不再 filter:commonmark 的 image schema 直接用,NodeView 由
    // @milkdown/kit/component/image-inline(imageInlineComponent) 接管
    p !== emphasisUnderscoreInputRule,
)
const safeGfm = gfm.filter(p => p !== strikethroughInputRule)

// 列表项里的 Tab/Shift-Tab 完全交给 Milkdown 自带的 listItemKeymap(来自 commonmark preset)。
// 本 keymap 只管列表以外的"代码类 / 段落 / 标题":在光标处插 4 空格。
const CODE_LIKE = new Set(['code_block', 'math_inline', 'math_block', 'mermaid'])

const tabIndent = $prose(() => {
  const itemType = (state: any) => state.schema.nodes.list_item

  function isInListItem($from: any): boolean {
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'list_item') return true
    }
    return false
  }

  return keymap({
    Tab: (state, dispatch) => {
      const { $from } = state.selection

      if (isInListItem($from)) {
        // 列表项:先尝试 sink;sink 失败(最内层嵌套)→ 退化为段落 Tab
        if (sinkListItem(itemType(state))(state, dispatch)) return true
        if (dispatch) dispatch(state.tr.insertText('    '))
        return true
      }

      // 代码块 / 公式 / mermaid 等代码类上下文
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name
        if (CODE_LIKE.has(name)) {
          if (dispatch) dispatch(state.tr.insertText('    '))
          return true
        }
      }

      // 段落 / 标题
      const node = $from.node()
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        if (dispatch) dispatch(state.tr.insertText('    '))
        return true
      }

      return false
    },

    'Shift-Tab': (state, dispatch) => {
      const { $from } = state.selection
      if (isInListItem($from)) {
        return liftListItem(itemType(state))(state, dispatch)
      }
      return false
    },
  })
})

// 行首 `$$` + Enter → 插入空 math_block 并进入编辑态
const dollarEnterToMathBlock = $prose(() =>
  keymap({
    Enter: (state, dispatch) => {
      const { $from } = state.selection
      const lineStart = $from.start()
      const before = state.doc.textBetween(lineStart, $from.pos, '\n', '\n')
      if (before !== '$$') return false

      const mathBlockType = state.schema.nodes.math_block
      if (!mathBlockType) return false

      // 先 trigger(node) 再 dispatch —— NodeView 工厂在 dispatch 引发的 view update
      // 同步阶段被调用,has(node) 命中就 setTimeout(0) startEdit()。等 setTimeout
      // 触发时 DOM 已 attach 完,textarea focus 不会被 ProseMirror 重入抢掉。
      // 用节点引用(WeakSet)而不是 bool 槽 —— 极快连按两次 Enter 也能各自进 edit。
      const newMathBlock = mathBlockType.create({ value: '' })
      triggerNextMathBlockAutoEdit(newMathBlock)
      const tr = state.tr
      tr.replaceWith(lineStart, $from.pos, newMathBlock)
      if (dispatch) dispatch(tr)
      return true
    },
  }),
)

const props = defineProps<{
  modelValue: string
  /** 切文件后要 focus;首次 mount 不需要 */
  focusOnCreate?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** modelValue 从外部（不是本组件的 echo）变了,需要父级 bump :key 重建 */
  rebuildRequest: []
}>()

// 用来区分"自己 emit 触发的 echo" vs "外部变化":
// 工厂里 markdownUpdated 触发 emit 前把当前值存这里;
// watch(props.modelValue) 时如果新值 === lastSelfEmitted 就是 echo,跳过;
// 否则就是父级真正从外部改了 modelValue(切文件 / 新建 / 外部同步),需要重建。
//
// 比 isInternalChange + nextTick 那种时序标志位更稳:不依赖 nextTick 窗口,
// 不依赖先后顺序,值对了就对了。
let lastSelfEmitted: string | null = null

watch(() => props.modelValue, (newVal) => {
  if (newVal === lastSelfEmitted) return
  emit('rebuildRequest')
})

const { get, loading } = useEditor((container) => {
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, container)
      ctx.set(defaultValueCtx, props.modelValue)
      // 监听 Markdown 内容变化 → emit 给父组件
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        lastSelfEmitted = markdown
        emit('update:modelValue', markdown)
        // markdown 变 → 重打 hljs class(highlight.js CSS 已通过 <link> 加载)
        // 走 editor view 而不是 ref,免得在没 ref 拿不到的场景下挂掉
        try {
          const view = ctx.get(editorViewCtx)
          view.dom.querySelectorAll('.ProseMirror pre').forEach((pre: Element) => {
            pre.classList.add('hljs')
          })
        }
        catch { /* 销毁期 editorViewCtx 已 remove,忽略 */ }
      })
    })
    .use(headingBackspaceToParagraph)
    .use(tabIndent)
    .use(dollarEnterToMathBlock)
    .use(safeCommonmark)
    .config((ctx) => {
      // Tauri 环境下 src 必须从磁盘绝对路径 → asset:// 协议
      // 浏览器下直接返回 src(Vite dev 从源目录 serve)
      function isTauriEnv(): boolean {
        return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      }
      ctx.set(inlineImageConfig.key, {
        ...defaultInlineImageConfig,
        // uploadPlaceholderText 留默认 '/Paste' 即可
        onUpload: async (file: File) => {
          const result = await saveImageAsset({
            currentFilePath: useDocumentStore().currentFilePath,
            file,
          })
          return result.srcForMarkdown
        },
        proxyDomURL: (url: string) => {
          if (!isTauriEnv()) return url
          // 已 web-recognizable 的 URL(http/https/data/asset/tauri)原样 —— 不当磁盘路径处理
          if (/^(https?:|data:|asset:|tauri:)/.test(url)) return url
          const currentFilePath = useDocumentStore().currentFilePath
          const absPath = resolveImageAssetAbsPath(url, currentFilePath)
          // 无 currentFilePath(untitled)时相对路径无法解析为绝对路径 → 原样,浏览器会断开
          if (!absPath.startsWith('/') && !/^[A-Z]:/i.test(absPath)) return absPath
          return convertFileSrc(absPath)
        },
      })
    })
    .use(imageInlineComponent)
    .use(imageKeymapPlugin)
    // 拖动时显示蓝色光标线指示落点(类似 Typora)
    .use($prose(() => dropCursor({ color: false, class: 'velo-drop-cursor' })))
    .use(imageUploadPlugin)
    .use(preserveEmptyLinePlugin)
    .use(fixedEmphasisUnderscoreInputRule)
    .use(safeGfm)
    .use(fixedStrikethroughInputRule)
    .use(history)
    .use(clipboard)
    .use(math)
    .use(mathEditPlugin)
    .use(mermaidSyntax)
    .use(mermaidDecoration)
    .use(taskListPlugin)
    .use(footnoteEditPlugin)
    .use(footnoteReferenceInputRule)
    .use(findHighlight)
    .use(listener)

  return editor
})

// 等 <Milkdown /> 调完 create() → loading 翻 false → 这时拿 editor
let stopLoadingWatch: (() => void) | null = null

onMounted(() => {
  stopLoadingWatch = watch(loading, (isLoading) => {
    if (isLoading) return  // 还在 create 中
    // 触发一次后立即停 watch
    stopLoadingWatch?.()
    stopLoadingWatch = null
    const editor = get()
    if (!editor) return
    // 初次 hljs 注入(覆盖整个编辑器里的 <pre>)
    nextTick(() => {
      stampHljsInto(editor)
    })
    // 切文件场景:把光标 focus 进去
    if (props.focusOnCreate) {
      nextTick(() => {
        try {
          editor.action((ctx: any) => ctx.get(editorViewCtx).focus())
        }
        catch { /* 销毁期 editorViewCtx 已 remove,忽略 */ }
      })
    }
  }, { immediate: true })
})

onBeforeUnmount(() => {
  stopLoadingWatch?.()
  stopLoadingWatch = null
})

function stampHljsInto(editor: NonNullable<ReturnType<typeof get>>) {
  try {
    editor.action((ctx: any) => {
      const view = ctx.get(editorViewCtx)
      view.dom.querySelectorAll('.ProseMirror pre').forEach((pre: Element) => {
        pre.classList.add('hljs')
      })
    })
  }
  catch { /* 销毁期 editorViewCtx 已 remove,忽略 */ }
}

// 点卡片(非 ProseMirror 子元素)时把焦点拉回编辑器。
// 注意:click 事件是向上冒泡的,点 .milkdown-editor 的 padding 时 target 是
// .milkdown-editor 自己,不会冒泡到作为子级的 <EditorInner>。所以这里把
// focus 逻辑暴露给外层,让外层在 .milkdown-editor 上挂 @click 调过来。
function focusEditor() {
  const editor = get()
  if (!editor) return
  try {
    editor.action((ctx: any) => {
      const view = ctx.get(editorViewCtx)
      if (!view.hasFocus()) view.focus()
    })
  }
  catch { /* 销毁期 editorViewCtx 已 remove,忽略 */ }
}

/**
 * 把当前 ProseMirror EditorView 暴露给父级,供 find/replace 等外部组件
 * 拿到 view 后调 view.state / view.dispatch。
 *
 * 切文件时整个 inner 被 :key 重建,所以这个 view 永远跟当前编辑器实例对齐;
 * 父级只需要每次调用都重新拿,不需要维护"view 是否已变"的缓存。
 *
 * 销毁期 editorViewCtx 已 remove —— 返回 null,调用方自己处理。
 */
function getEditorView(): EditorView | null {
  const editor = get()
  if (!editor) return null
  try {
    let view: EditorView | null = null
    editor.action((ctx: any) => {
      view = ctx.get(editorViewCtx) as EditorView
    })
    return view
  }
  catch {
    return null
  }
}

defineExpose({ focusEditor, getEditorView })
</script>

<template>
  <!-- 无样式的纯挂载 div,只为给 Milkdown 一个稳定父级 -->
  <div class="velo-editor-mount h-full w-full">
    <Milkdown />
  </div>
</template>

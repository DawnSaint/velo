<script setup lang="ts">
// 装配策略:
// - schema / markdownIO 来自 ./editor/
// - 历史 / dropCursor / gapCursor 走 prosemirror-* 官方插件
// - 修上游 markRule bug 的 fixedXxx 规则保留(markRule 仍来自 prosemirror-inputrules)
// - 各自定义 NodeView / Decoration / InputRule 走本地 nodes/* + image/* + findreplace/*
// - 写入时 toMarkdown(doc) → emit update:modelValue(走 markdownIO)
// - modelValue 外部变化时(切文件 / CLI 打开 / fs:watch 同步)→ 直接 view.updateState
//   重置 EditorState,无需销毁重建整个 EditorView(等价语义,plugin state 自然清零)

import { onBeforeUnmount, watch } from 'vue'
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { inputRules, ellipsis } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { sinkListItem, liftListItem, splitListItem } from 'prosemirror-schema-list'
import { baseKeymap, chainCommands, selectAll, splitBlock } from 'prosemirror-commands'
import { convertFileSrc } from '@tauri-apps/api/core'
import { schema, type VeloSchema } from './editor/schema'
import { fromMarkdown, toMarkdown } from './editor/markdownIO'
import { createImageNodeView } from './editor/imageNodeView'
import { useProseMirror } from './composables/useProseMirror'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from './nodes/MathNodeViews'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin } from './nodes/FootnoteNodeViews'
import { tocDecoration } from './nodes/TocDecoration'
import { htmlNodeViewPlugin } from './nodes/HtmlNodeView'
import { findHighlight } from './findreplace/findHighlight'
import { imageKeymapPlugin } from './image/imageKeymap'
import { imageUploadPlugin } from './image/imageUploadPlugin'
import { linkClickPlugin, linkEditEscapeKeymap } from './plugins/linkClick'
import { syntaxAutoFormatPlugin } from './plugins/syntaxAutoFormat'
import { markdownPastePlugin } from './plugins/markdownPastePlugin'
import { codeHighlightPlugin } from './nodes/CodeHighlightWidget'
import { codeBlockEnterCommand, codeBlockBackspaceCommand } from './syntax/block/codeBlock'
import { hrEnterCommand } from './syntax/block/hr'
import './syntax' // 触发 syntax registry 注册副作用(block + inline 全套语法)
import './editor/shortcuts' // 触发 shortcut registry 注册副作用(Mod-b/i/h/k/0~6/t 等)
import { buildShortcutKeymap } from './editor/shortcuts'
import { useDocumentStore } from '@/stores/document'
import { resolveImageAssetAbsPath } from '@/utils/imagePath'
import { cursorFromTextBefore, type CursorPosition } from '@/utils/editorCursor'
// katex.min.css 不再静态 import —— katex 包整体懒加载(见 MathNodeViews.ts
// 的 getKatex),CSS 也跟着第一次 render 时动态 import,避免首屏加载 ~80KB CSS。

// ============================================================
//  标题前 Backspace / Delete → 转段落(旧 EditorInner 行为保留)
// ============================================================

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

// ============================================================
//  列表项 + 代码类节点的 Tab 缩进(对齐旧 tabIndent)
// ============================================================

const CODE_LIKE = new Set(['code_block', 'math_inline', 'math_block'])

// ============================================================
//  code_block 内 Mod-a(全选)只选 block 范围,而不是整个 doc
//  (baseKeymap 的 selectAll 用 AllSelection(state.doc)→ 选全部,
//   对代码块用户期望是"选 block 内的代码",贴近普通编辑器行为)。
//  其他位置(段落 / heading / list_item / ...)放行走 baseKeymap 默认全选。
// ============================================================

const selectInsideCodeBlock: import('prosemirror-state').Command = (state, dispatch) => {
  const { $from } = state.selection
  // $from.parent 是直接父节点;在 code_block 内时,父节点就是 code_block 本身
  if ($from.parent.type.name !== 'code_block') return false
  const blockStart = $from.start() // code_block 起点(含 opening token)
  const blockEnd = $from.end() // code_block 终点(含 closing token)
  if (blockStart === blockEnd) {
    // 空 block:dispatch 一个 collapsed selection 让光标落在 block 内,
    // 而不是 return false 走 baseKeymap 全选
    if (dispatch) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, blockStart)))
    }
    return true
  }
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, blockStart, blockEnd)))
  }
  return true
}

const tabIndent = keymap({
  Tab: (state, dispatch) => {
    const { $from } = state.selection

    // 列表项:先 sink,失败退化为段落 Tab
    const isInListItem = (() => {
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'list_item') return true
      }
      return false
    })()
    if (isInListItem) {
      if (sinkListItem(state.schema.nodes.list_item)(state, dispatch)) return true
      if (dispatch) dispatch(state.tr.insertText('    '))
      return true
    }

    // 代码类上下文
    for (let d = $from.depth; d > 0; d--) {
      const name = $from.node(d).type.name
      if (CODE_LIKE.has(name)) {
        if (dispatch) dispatch(state.tr.insertText('    '))
        return true
      }
    }

    const node = $from.node()
    if (node.type.name === 'paragraph' || node.type.name === 'heading') {
      if (dispatch) dispatch(state.tr.insertText('    '))
      return true
    }
    return false
  },
  'Shift-Tab': (state, dispatch) => {
    const { $from } = state.selection
    const isInListItem = (() => {
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'list_item') return true
      }
      return false
    })()
    if (isInListItem) {
      return liftListItem(state.schema.nodes.list_item)(state, dispatch)
    }
    // 非列表上下文:仍返回 true 消费掉 Shift-Tab,阻止浏览器默认行为
    // (把焦点移出 contentEditable)。doc 不动,光标位置不变,只是把焦点
    // 留在编辑器里。
    //
    // 之前返回 false → keymap 不消费 → 浏览器接管 → 焦点逃离编辑器,
    // 用户感知"光标丢失"。
    return true
  },
})

// ============================================================
//  `$$` + Enter → math_block 进入编辑态
// ============================================================

// 代码块内 Enter:baseKeymap 的 splitBlock 在 code_block 里会把剩余内容
// 拆成 paragraph(用户感知"代码块被拆成两块")。这里显式在 Enter 链最前
// 拦截:光标在 code_block 内部时只插换行,保持仍在一个 code_block 内。
function codeBlockEnter(state: any, dispatch?: any): boolean {
  const { $head } = state.selection
  if ($head.parent.type.name !== 'code_block') return false
  if (dispatch) dispatch(state.tr.insertText('\n'))
  return true
}

function dollarEnterCmd(state: any, dispatch?: any): boolean {
  const { $from } = state.selection
  const lineStart = $from.start()
  const before = state.doc.textBetween(lineStart, $from.pos, '\n', '\n')
  if (before !== '$$') return false
  const mathBlockType = state.schema.nodes.math_block
  if (!mathBlockType) return false
  const newMathBlock = mathBlockType.create({ value: '' })
  triggerNextMathBlockAutoEdit(newMathBlock)
  const tr = state.tr
  tr.replaceWith(lineStart, $from.pos, newMathBlock)
  if (dispatch) dispatch(tr)
  return true
}

const dollarEnterToMathBlock = keymap({
  Enter: dollarEnterCmd,
})

// ============================================================
//  image NodeView + Tauri 协议注入
// ============================================================

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const imageNodeView = createImageNodeView({
  proxyDomURL: (url: string) => {
    if (!isTauriEnv()) return url
    if (/^(https?:|data:|asset:|tauri:)/.test(url)) return url
    const currentFilePath = useDocumentStore().currentFilePath
    const absPath = resolveImageAssetAbsPath(url, currentFilePath)
    if (!absPath.startsWith('/') && !/^[A-Z]:/i.test(absPath)) return absPath
    return convertFileSrc(absPath)
  },
})

// image_inline NodeView 接到 mathEditPlugin 同一个 Plugin 里。
const imageInlineViewPlugin = new Plugin({
  key: new PluginKey('imageInlineView'),
  props: {
    nodeViews: { image: imageNodeView },
  },
})

// image upload 拦截 paste/drop:走 saveImageAsset。
// 原 imageUploadPlugin 的 saveAndInsert 直接 view.state.schema.nodes.image 拿类型,
// 行为已通过现 schema 完整。无需新代码。
// 但上传调 onUpload 行为(预设 /Paste placeholder)没了 —— 我们走极简版,这里
// 也不需要 onUpload,直接 save+insert 即可。

// ============================================================
//  装入顺序:keymap 放最前(headingBackspace 抢在默认 baseKeymap 前),
//  history 居中,destroyed 时不挂
// ============================================================

const basePlugins: Plugin[] = [
  // 自定义 Backspace / Delete:
  //   1. codeBlockBackspaceCommand:在 code_block 首位按 Backspace —— 有内容时
  //      吞掉事件(不允许影响外面的行),空代码块转回 paragraph。必须排在
  //      baseKeymap 前,否则 joinBackward 会把代码块降级合并到上一段。
  //   2. headingToParagraph:heading 前退化为段落
  //   3. baseKeymap['Backspace']:兜底
  keymap({
    Backspace: chainCommands(codeBlockBackspaceCommand, headingToParagraph, baseKeymap['Backspace']),
    Delete: chainCommands(headingToParagraph, baseKeymap['Delete']),
    // Mod-a:code_block 内只选 block 内容;其他位置放行给 baseKeymap 的 selectAll。
    'Mod-a': chainCommands(selectInsideCodeBlock, selectAll),
  }),
  keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
  // Enter 链:
  //   1. dollarEnterCmd:`$$` + Enter → math_block 编辑态
  //   2. splitListItem:有内容的 list_item 内 Enter 产生新 list_item
  //   3. liftListItem:空 list_item 内 Enter 把当前项提升为普通 paragraph
  //      (splitListItem 在空 list_item 里 return false,不能 fall back 到
  //      splitBlock —— 否则 list_item 里又开一段 paragraph,跟之前有内容
  //      时的行为割裂)
  //   4. splitBlock:兜底,普通段落里换行
  keymap({
    Enter: chainCommands(
      codeBlockEnter,
      dollarEnterCmd,
      codeBlockEnterCommand,
      hrEnterCommand,
      splitListItem(schema.nodes.list_item),
      liftListItem(schema.nodes.list_item),
      splitBlock,
    ),
  }),
  // baseKeymap 装在最后:接管未自定义的所有键(Enter, Backspace-after-failed, ...)
  keymap(baseKeymap),
  dropCursor({ color: false, class: 'velo-drop-cursor' }),
  gapCursor(),
  history(),
  tabIndent,
  dollarEnterToMathBlock,
  imageKeymapPlugin,
  imageUploadPlugin,
  // markdownPastePlugin 接管 text/plain 粘贴 → 走 fromMarkdown,绕开 ProseMirror
  // 默认 plain-text fallback 的 normalizeSiblings 错误合并;与 imageUploadPlugin
  // 不冲突(imageUploadPlugin 只 handlePaste 拦截 image/* 文件,非图片返回 false;
  // clipboardTextParser 是独立 prop,仅在 text/plain 路径生效,text/html 不受影响)
  markdownPastePlugin,
  linkClickPlugin,
  linkEditEscapeKeymap,
  syntaxAutoFormatPlugin,
  codeHighlightPlugin,
  imageInlineViewPlugin,
  htmlNodeViewPlugin,
  mathEditPlugin,
  mermaidDecoration,
  taskListPlugin,
  footnoteEditPlugin,
  tocDecoration,
  findHighlight,
]

// 只剩"纯文本→纯文本"的快速路径在 InputRule 里;有段级语义 / 转节点 /
// 加 mark 的语法都走 syntaxAutoFormatPlugin。
const inputRulesPlugin = inputRules({
  rules: [ellipsis],
})

// 快捷键 keymap(declarative registry)—— 优先级在 history / baseKeymap 之后,
// 让内置 Backspace / Enter / Tab 链先响应,shortcuts 只补"未自定义"的键。
const shortcutKeymap = buildShortcutKeymap()

const allPlugins = [...basePlugins, inputRulesPlugin, shortcutKeymap]

// ============================================================
//  Vue 组件壳
// ============================================================

const props = withDefaults(defineProps<{
  modelValue: string
  /** 只读模式：禁用编辑器输入，用于示例文档等不允许直接修改的场景。 */
  readOnly?: boolean
}>(), {
  readOnly: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'cursor-position-change': [position: CursorPosition]
}>()

// 区分 self-emit echo vs 外部 modelValue 变化。值匹配 → echo,跳过;
// 否则 → 直接 view.updateState 替换内部状态,plugin state 因 init 跑而归零
// (等价于"销毁重建 EditorView",但不动 view 实例,不重挂 NodeView 容器)。
let lastSelfEmitted: string | null = null
// 首次挂载完成 = onReady 跑过 = mounted。后续 watch 触发的都是"外部 modelValue
// 切换",这时拉焦点回编辑区(切文件 / CLI 打开 / 外部同步的明确意图)。
// 启动期(mounted=false)不抢焦点,避免把 DraftRecoveryDialog 等启动期弹窗的
// 焦点踢走。
let mounted = false

function emitCursorPosition() {
  const view = getView()
  if (!view) return
  const pos = view.state.selection.head
  const textBefore = view.state.doc.textBetween(0, pos, '\n', '\n')
  emit('cursor-position-change', cursorFromTextBefore(textBefore))
}

watch(() => props.modelValue, (newVal) => {
  if (newVal === lastSelfEmitted) return
  const view = getView()
  if (!view) return

  const doc = fromMarkdown(newVal, schema as VeloSchema)
  view.updateState(EditorState.create({
    schema,
    doc,
    plugins: allPlugins,
  }))
  if (mounted) {
    try { view.focus() } catch { /* 销毁期忽略 */ }
  }
  emitCursorPosition()
})

// useProseMirror 返回的 containerRef 直接绑到 template ref。TS 看不到
// template ref 的隐式 binding 会误报未使用变量,这里通过 defineExpose
// 把它暴露出去 —— TS 看到暴露对象消费过 ref 就不再报。
const { containerRef, getView, setReadOnly } = useProseMirror({
  schema: schema as VeloSchema,
  initialDoc: props.modelValue,
  fromMarkdown: (md, s) => fromMarkdown(md, s as VeloSchema),
  plugins: allPlugins,
  editable: !props.readOnly,
  onChange: (doc) => {
    const md = toMarkdown(doc)
    lastSelfEmitted = md
    emit('update:modelValue', md)
  },
  onSelectionChange: () => {
    emitCursorPosition()
  },
  onReady: () => {
    mounted = true
    emitCursorPosition()
  },
})

// 动态切换只读:首次 mount 时 editable 已由 useProseMirror 的初值覆盖,此 watch
// 只管"挂载后 readOnly 翻转"(示例文档 → 切回普通文档)。卸载后 setReadOnly
// 内部 view 为 null 自动 no-op,无需判 unmounted。
watch(() => props.readOnly, (readOnly) => {
  setReadOnly(readOnly)
})

function focusEditor() {
  const view = getView()
  if (view && !view.hasFocus()) view.focus()
}

defineExpose({ focusEditor, getEditorView: getView, containerRef })

onBeforeUnmount(() => {
  // useProseMirror 内部已 destroy
})
</script>

<template>
  <!-- 挂载容器:ref 拿给 useProseMirror 内部 EditorView 挂 contentDOM 用 -->
  <div ref="containerRef" class="velo-editor-mount h-full w-full" data-testid="pm-editor" />
</template>

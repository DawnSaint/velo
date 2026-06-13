<script setup lang="ts">
// 新版 ProseMirror 编辑器(无 Milkdown 依赖)。
//
// 装配策略:
// - schema / markdownIO 来自 ./editor/
// - 历史 / dropCursor / gapCursor 走 prosemirror-* 官方插件
// - 修上游 markRule bug 的 fixedXxx 规则保留(markRule 仍来自 prosemirror-inputrules)
// - 各自定义 NodeView / Decoration / InputRule 走本地 nodes/* + image/* + findreplace/*
// - 写入时 toMarkdown(doc) → emit update:modelValue(走 markdownIO)
// - modelValue 外部变化时,由父级 :key 触发重挂;本组件不做 watch modelValue
//
// 对外 API 与旧 EditorInner 完全一致:
//   props: modelValue, focusOnCreate
//   emit: update:modelValue, rebuildRequest
//   expose: focusEditor, getEditorView

import { onBeforeUnmount, watch } from 'vue'
import { EditorView } from 'prosemirror-view'
import { Plugin, PluginKey } from 'prosemirror-state'
import { inputRules, emDash, ellipsis, InputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { sinkListItem, liftListItem } from 'prosemirror-schema-list'
import { baseKeymap, chainCommands, splitBlock } from 'prosemirror-commands'
import { convertFileSrc } from '@tauri-apps/api/core'
import { schema, type VeloSchema } from './editor/schema'
import { fromMarkdown, toMarkdown } from './editor/markdownIO'
import { createImageNodeView } from './editor/imageNodeView'
import { useProseMirror } from './composables/useProseMirror'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from './nodes/MathNodeViews'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin, footnoteReferenceInputRule } from './nodes/FootnoteNodeViews'
import { findHighlight } from './findreplace/findHighlight'
import { imageKeymapPlugin } from './image/imageKeymap'
import { imageUploadPlugin } from './image/imageUploadPlugin'
import { useDocumentStore } from '@/stores/document'
import { resolveImageAssetAbsPath } from '@/utils/imagePath'
import 'katex/dist/katex.min.css'

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
//  markRule 修复:
//  Milkdown 的 preset-commonmark/gfm 里 emphasisUnderscoreInputRule /
//  strikethroughInputRule 的正则末尾没有 $ 锚点,会扫到段落里任意位置。
//  新版用 prosemirror-inputrules 的 markRule 自己写一对带 $ 锚点的修复版。
// ============================================================

const fixedEmphasisUnderscoreInputRule = new InputRule(
  /\b_(?![_\s])(.*?[^_\s])_\b$/,
  (state, match, start, end) => {
    const inner = match[1]
    if (!inner) return null
    const tr = state.tr
    tr.delete(start, end)
    const mark = state.schema.marks.emphasis.create({ marker: '_' })
    tr.addMark(start, start + inner.length, mark)
    return tr
  },
)

const fixedStrikethroughInputRule = new InputRule(
  /(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)$/,
  (state, match, _start, end) => {
    const inner = match[2]
    if (!inner) return null
    const tr = state.tr
    tr.delete(_start, end)
    const mark = state.schema.marks.strike_through.create()
    tr.addMark(_start, _start + inner.length, mark)
    return tr
  },
)

// 行内公式:用户敲完 `$x$`,光标紧贴第二个 $ 时,把匹配段替换为 math_inline 节点。
//
// 规则:
//   - regex `\$([^$\n]+)\$`:匹配 `$ <非空非换行非 $> $` 紧贴光标
//   - 必须 $1 非空,空匹配不转
//   - 替换为 math_inline 节点,textContent 是 $1,KaTeX 渲染由 MathNodeViews.ts 接管
//
// remark-math / markdownIO 走的是**外部 markdown 解析**;EditorView 实时键入
// 不经过 unified,必须靠 input rule 显式转换。
const inlineMathInputRule = new InputRule(
  /\$([^$\n]+)\$$/,
  (state, match, start, end) => {
    const inner = match[1]
    if (!inner) return null
    const type = state.schema.nodes.math_inline
    if (!type) return null
    const tr = state.tr
    tr.replaceRangeWith(start, end, type.create(null, state.schema.text(inner)))
    return tr
  },
)

// ============================================================
//  列表项 + 代码类节点的 Tab 缩进(对齐旧 tabIndent)
// ============================================================

const CODE_LIKE = new Set(['code_block', 'math_inline', 'math_block', 'mermaid'])

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
  // 自定义 Backspace / Delete:heading 前退化为段落;不命中走 baseKeymap
  keymap({
    Backspace: chainCommands(headingToParagraph, baseKeymap['Backspace']),
    Delete: chainCommands(headingToParagraph, baseKeymap['Delete']),
  }),
  keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
  // dollarEnter 优先($$ + Enter),失败再 splitBlock
  keymap({
    Enter: chainCommands(dollarEnterCmd, splitBlock),
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
  imageInlineViewPlugin,
  mathEditPlugin,
  mermaidDecoration,
  taskListPlugin,
  footnoteEditPlugin,
  findHighlight,
]

// InputRule 链路:fixedXxx + footnote + (smartQuotes 由上面基线带)
// 注意:markRule(emphasis_/strong) 默认规则我们在 schema.ts 装配 schema 时
// 没用 preset-commonmark 的 rule,所以这里**只挂** fixedXxx + footnote rule。
// 用户的 emphasisStarInputRule / strongInputRule 行为(走 * ** 触发)目前
// 在新 schema 下不自动触发 —— 这是 Phase 1 接受的范围,Phase 2 验收后再加
// 显式 markRule 恢复。
const inputRulesPlugin = inputRules({
  rules: [
    fixedEmphasisUnderscoreInputRule,
    fixedStrikethroughInputRule,
    inlineMathInputRule,
    footnoteReferenceInputRule,
    ellipsis,
    emDash,
  ],
})

const allPlugins = [...basePlugins, inputRulesPlugin]

// ============================================================
//  Vue 组件壳
// ============================================================

const props = defineProps<{
  modelValue: string
  focusOnCreate?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  rebuildRequest: []
}>()

// 区分 self-emit echo vs 外部 modelValue 变化。值匹配 → echo,跳过;
// 否则 → emit rebuildRequest(父级 bump :key 重建)。
let lastSelfEmitted: string | null = null

watch(() => props.modelValue, (newVal) => {
  if (newVal === lastSelfEmitted) return
  emit('rebuildRequest')
})

// useProseMirror 返回的 containerRef 直接绑到 template ref。TS 看不到
// template ref 的隐式 binding 会误报未使用变量,这里通过 defineExpose
// 把它暴露出去 —— TS 看到暴露对象消费过 ref 就不再报。
const { containerRef, getView } = useProseMirror({
  schema: schema as VeloSchema,
  initialDoc: props.modelValue,
  fromMarkdown: (md, s) => fromMarkdown(md, s as VeloSchema),
  plugins: allPlugins,
  onChange: (doc) => {
    const md = toMarkdown(doc)
    lastSelfEmitted = md
    emit('update:modelValue', md)
  },
  onReady: (view) => {
    stampHljsInto(view)
    if (props.focusOnCreate) {
      try { view.focus() } catch { /* 销毁期忽略 */ }
    }
  },
})

function stampHljsInto(view: EditorView) {
  try {
    view.dom.querySelectorAll('.ProseMirror pre').forEach((pre: Element) => {
      pre.classList.add('hljs')
    })
  }
  catch { /* 销毁期 view.dom 已 null,忽略 */ }
}

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
  <div ref="containerRef" class="velo-editor-mount h-full w-full" />
</template>

<script setup lang="ts">

// 装配策略:
// - schema / markdownIO 来自 ./editor/
// - 历史 / dropCursor / gapCursor 走 prosemirror-* 官方插件
// - 修上游 markRule bug 的 fixedXxx 规则保留(markRule 仍来自 prosemirror-inputrules)
// - 各自定义 NodeView / Decoration / InputRule 走本地 nodes/* + image/* + findreplace/*
// - 写入时 toMarkdown(doc) → emit update:modelValue(走 markdownIO)
// - modelValue 外部变化时(切文件 / CLI 打开 / fs:watch 同步)→ 直接 view.updateState
//   重置 EditorState,无需销毁重建整个 EditorView(等价语义,plugin state 自然清零)

import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { inputRules, ellipsis } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { tableEditing, columnResizing } from 'prosemirror-tables'
import { sinkListItem, liftListItem, splitListItem } from 'prosemirror-schema-list'
import { baseKeymap, chainCommands, liftEmptyBlock, selectAll, splitBlock } from 'prosemirror-commands'
import { convertFileSrc } from '@tauri-apps/api/core'
import { schema, type VeloSchema } from './editor/schema'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { fromMarkdown, fromMarkdownAsync, toMarkdown } from './editor/markdownIO'
import { decideOpenFocus } from './editor/openFocus'
import { createImageNodeView } from './editor/imageNodeView'
import { createHrNodeView } from './nodes/HrNodeView'
import { createEmojiNodeView } from './nodes/EmojiNodeView'
import { frontmatterNodeViewPlugin } from './nodes/FrontmatterNodeView'
import { useProseMirror } from './composables/useProseMirror'
import { findScrollAncestor } from './composables/scrollUtils'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from './nodes/MathNodeViews'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin } from './nodes/FootnoteNodeViews'
import { tocDecoration } from './nodes/TocDecoration'
import { createHtmlNodeViewPlugin } from './nodes/HtmlNodeView'
import { findHighlight } from './findreplace/findHighlight'
import { imageKeymapPlugin } from './image/imageKeymap'
import { imageUploadPlugin } from './image/imageUploadPlugin'
import { createImageEditPlugin, imageEditEscapeKeymap } from './image/imageEditPlugin'
import {
  registerTableEditorView,
  unregisterTableEditorView,
  hasTableEditorView,
  runTableCommand,
  runSetCellAlignment,
} from './editor/tableEditor'
import { schema as veloSchema } from './editor/schema'
import {
  cmdAddRowAfter,
  cmdAddRowBefore,
  cmdDeleteRow,
  cmdAddColumnAfter,
  cmdAddColumnBefore,
  cmdDeleteColumn,
  cmdDeleteTable,
  cmdMoveRow,
  cmdMoveColumn,
  cmdTableCellEnter,
  cmdTableCellHardBreak,
  cmdTableTab,
} from './editor/shortcuts/commands/tableCommands'
// Pre-bind commands with schema。
// add/delete/align/deleteTable 仍靠 tableMenuAnchorPos 注入锚点;
// moveRow/moveColumn 改读 state.selection(CellSelection 矩形),不再传 anchor。
const addRowAfter = (anchorPos?: number) => cmdAddRowAfter(veloSchema, anchorPos)
const addRowBefore = (anchorPos?: number) => cmdAddRowBefore(veloSchema, anchorPos)
const deleteRow = (anchorPos?: number) => cmdDeleteRow(veloSchema, anchorPos)
const addColumnAfter = (anchorPos?: number) => cmdAddColumnAfter(veloSchema, anchorPos)
const addColumnBefore = (anchorPos?: number) => cmdAddColumnBefore(veloSchema, anchorPos)
const deleteColumn = (anchorPos?: number) => cmdDeleteColumn(veloSchema, anchorPos)
const deleteTable = (anchorPos?: number) => cmdDeleteTable(veloSchema, anchorPos)
const moveRowUp = () => cmdMoveRow(-1)
const moveRowDown = () => cmdMoveRow(1)
const moveColLeft = () => cmdMoveColumn(-1)
const moveColRight = () => cmdMoveColumn(1)
import { createTableContextMenuPlugin } from './plugins/tableContextMenu'
import { createTableResizeCursorPlugin } from './plugins/tableResizeCursor'
import { createTableInsertHandlePlugin } from './plugins/tableInsertHandle'
import { createTableCellInputGuardPlugin } from './plugins/tableCellInputGuard'
import type { PluginEntry } from './plugins/types'
import { resolvePlugins } from './plugins/resolvePlugins'

// ============ 表格上下文菜单状态 + handler ============
const showTableMenu = ref(false)
const tableMenuX = ref(0)
const tableMenuY = ref(0)
// 右键点中的 cell 的 descendants pos(与 doc.descendants 同语义),作为命令锚点。
// 单个 cell 右键 = 该 cell 位置;CellSelection 矩形内右键 = 右键点中那格位置。
const tableMenuAnchorPos = ref<number | null>(null)
// 右键点中的 cell 是否为 header(th)。header 行不可删除,且上方插行逻辑特殊。
const tableMenuInHeader = ref(false)
// 触发右键时是否存在 CellSelection(多格拖蓝)。
const tableMenuIsCellSelection = ref(false)
// 隐藏"上/下移该行":header 行不可移动。
const tableMenuHideMoveRow = ref(false)
// 隐藏"左/右移该列":单列表格无列移动意义。
const tableMenuHideMoveColumn = ref(false)

function onTableMenuAction(action: string) {
  if (!hasTableEditorView()) return
  const anchor: number | undefined = tableMenuAnchorPos.value ?? undefined
  switch (action) {
    case 'add-row-after':
      runTableCommand(addRowAfter(anchor))
      break
    case 'add-row-before':
      runTableCommand(addRowBefore(anchor))
      break
    case 'move-row-up':
      runTableCommand(moveRowUp())
      break
    case 'move-row-down':
      runTableCommand(moveRowDown())
      break
    case 'delete-row':
      runTableCommand(deleteRow(anchor))
      break
    case 'add-column-left':
      runTableCommand(addColumnBefore(anchor))
      break
    case 'add-column-right':
      runTableCommand(addColumnAfter(anchor))
      break
    case 'move-column-left':
      runTableCommand(moveColLeft())
      break
    case 'move-column-right':
      runTableCommand(moveColRight())
      break
    case 'delete-column':
      runTableCommand(deleteColumn(anchor))
      break
    case 'align-left':
      runSetCellAlignment('left', anchor)
      break
    case 'align-center':
      runSetCellAlignment('center', anchor)
      break
    case 'align-right':
      runSetCellAlignment('right', anchor)
      break
    case 'delete-table':
      runTableCommand(deleteTable(anchor))
      break
  }
}

// 从 anchorPos 解析出所在 table 的列数;列数 ≤ 1 → 隐藏列移动。
function computeTableMenuHideMoveColumn(anchorPos: number): boolean {
  const view = getView()
  if (!view) return true
  const $from = view.state.doc.resolve(anchorPos)
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d)
    if (n.type.name === 'table') {
      return n.child(0).childCount <= 1
    }
  }
  return true
}

import { linkClickPlugin, linkEditEscapeKeymap } from './plugins/linkClick'
import { syntaxAutoFormatPlugin } from './plugins/syntaxAutoFormat'
import { markSourceEditPlugin, markSourceEditEscapeKeymap } from './plugins/markSourceEdit'
import { htmlSourceEditPlugin, htmlSourceEditEscapeKeymap } from './plugins/htmlSourceEdit'
import { emojiSourceEditPlugin, emojiSourceEditEscapeKeymap } from './plugins/emojiSourceEdit'
import { markdownPastePlugin } from './plugins/markdownPastePlugin'
import { codeHighlightPlugin } from './nodes/CodeHighlightWidget'
import { codeLineNumberPlugin } from './nodes/CodeLineNumberWidget'
import { codeWrapPlugin } from './nodes/CodeWrapPlugin'
import { foldDecoration, foldKey, foldDeleteCommand } from './nodes/FoldDecoration'
import { viewportPlugin, setInitialViewportHint, refreshViewport } from './nodes/viewportPlugin'
import { focusModePlugin, focusModeKey, setFocusModeEnabled } from './plugins/focusMode'
import { typewriterModePlugin, typewriterModeKey, setTypewriterModeEnabled } from './plugins/typewriterMode'
import { cjkLetterSpacingPlugin } from './plugins/cjkLetterSpacing'
import { cjkAutoFormatPlugin } from './plugins/cjkAutoFormat'
import { autoPairPlugin } from './plugins/autoPair'
import { useFoldStore } from '@/stores/folding'
import { codeBlockEnterCommand, codeBlockBackspaceCommand } from './syntax/block/codeBlock'
import { frontmatterBackspaceCommand } from './syntax/block/frontmatter'
import { codeBlockLangSuggestPlugin } from './plugins/codeBlockLangSuggest'
import { emojiSuggestPlugin } from './plugins/emojiSuggest'
import { hrEnterCommand } from './syntax/block/hr'
import { frontmatterEnterCommand } from './syntax/block/frontmatter'
import './syntax' // 触发 syntax registry 注册副作用(block + inline 全套语法)
import './editor/shortcuts' // 触发 shortcut registry 注册副作用(Mod-b/i/h/k/0~6/t 等)
import { buildShortcutKeymap } from './editor/shortcuts'
import TableContextMenu from './TableContextMenu.vue'
import { useDocumentStore } from '@/stores/document'
import { useContextMenu } from '../../composables/useContextMenu'
import { resolveImageAssetAbsPath } from '@/utils/imagePath'
import { cursorFromTextBefore, type CursorPosition } from '@/utils/editorCursor'
import { headingChainFromDoc, type HeadingBreadcrumb } from '@/utils/breadcrumbs'
import { getSourceEditRanges } from './editor/sourceEditSession'
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
//  列表下方空段落 Backspace → 删除空行(不 join 到列表)
// ============================================================

// baseKeymap 的 joinBackward 在「空段落 + 前一个兄弟是列表」时会把空段落
// 合并进列表末尾 list_item,等价于扩展列表(用户看到"多了一个列表项")。
// 用户需要按 3 次 Backspace 才能删掉空行。这里提前拦截:直接删除空段落。
function emptyParaBeforeListBackspace(state: any, dispatch?: any): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const $from = selection.$from
  if ($from.parentOffset !== 0) return false
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parent.content.size > 0) return false

  const parentDepth = $from.depth - 1
  if (parentDepth < 0) return false
  const paraIndex = $from.index(parentDepth)
  if (paraIndex === 0) return false

  const parent = $from.node(parentDepth)
  const prevSibling = parent.child(paraIndex - 1)
  if (prevSibling.type.name !== 'bullet_list' && prevSibling.type.name !== 'ordered_list') {
    return false
  }

  if (dispatch) {
    const tr = state.tr
    const paraStart = $from.before($from.depth)
    const paraEnd = paraStart + $from.parent.nodeSize
    tr.delete(paraStart, paraEnd)
    const $pos = tr.doc.resolve(Math.min(paraStart, tr.doc.content.size))
    tr.setSelection(TextSelection.near($pos, -1))
    dispatch(tr)
  }
  return true
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

    // 表格内 → cell 导航(Tab 往后一格,末尾新增行)
    if (cmdTableTab(1)(state, dispatch)) return true

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
    // 表格内 → cell 导航(Shift+Tab 往前一格)
    if (cmdTableTab(-1)(state, dispatch)) return true

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
    // 用户感知“光标丢失”。
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

// 代码块内 Shift-Enter:在 code_block 后插入空段落并将光标移入,
// 用户感知"跳出代码块"。与 Typora 的 Ctrl+Enter 退出语义一致,
// 但用 Shift-Enter(与 table cell 的 Shift-Enter 插 <br> 同键位族,
// 都是"Enter 的变体")。code_block 外 return false。
function codeBlockExit(state: any, dispatch?: any): boolean {
  const { $head } = state.selection
  if ($head.parent.type.name !== 'code_block') return false
  const end = $head.after()
  const paragraphType = state.schema.nodes.paragraph
  const tr = state.tr.replaceWith(end, end, paragraphType.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1))
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

// ── Shift-Enter 多场景命令 ──

// blockquote / alert 内 Shift-Enter:退出引用 / 警告框。
// - 空段落 → liftEmptyBlock(提升空段落出 block,与 Enter 退出行为一致)
// - 非空段落 → 在 block 后插入空段落并将光标移入
// 不在 blockquote / alert 内时 return false。
function shiftEnterExitBlock(state: any, dispatch?: any): boolean {
  const { $head } = state.selection
  // 向上找 blockquote / alert 祖先
  let blockDepth = -1
  for (let d = $head.depth; d > 0; d--) {
    const name = $head.node(d).type.name
    if (name === 'blockquote' || name === 'alert') {
      blockDepth = d
      break
    }
  }
  if (blockDepth < 0) return false
  // 空段落 → 提升出 block(避免 block 内残留空段 + block 外又插一段)
  if ($head.parent.content.size === 0) return liftEmptyBlock(state, dispatch)
  // 非空 → 在 block 后插入空段落
  const end = $head.after(blockDepth)
  const paragraphType = state.schema.nodes.paragraph
  const tr = state.tr.replaceWith(end, end, paragraphType.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1))
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

// list_item 首层 paragraph 内 Shift-Enter:直接 splitBlock 在 list_item 内
// 分裂段落,产生"带缩进的空段落"(list_item 内追加 paragraph)。
// 效果等同 Enter(创建新 list_item) + Backspace(合并回 list_item)。
// 跳过 splitListItem(Enter 会创建新 list_item,Shift-Enter 不创建)。
// 不在 list_item 首层 paragraph 时 return false(嵌套 block / 普通段落走兜底)。
function shiftEnterListItem(state: any, dispatch?: any): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const { $from } = selection
  // 祖先链中有 list_item 吗?
  let listItemDepth = -1
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'list_item') {
      listItemDepth = d
      break
    }
  }
  if (listItemDepth < 0) return false
  // list_item 的直接子节点是 paragraph 吗?不是则说明在嵌套 block 内,
  // 交给兜底 splitBlock 处理。
  const directChild = $from.node(listItemDepth + 1)
  if (!directChild || directChild.type.name !== 'paragraph') return false
  return splitBlock(state, dispatch)
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
//  list_item 内嵌套 block(blockquote / alert 等)的 Enter 守卫
// ============================================================

// splitListItem 只在光标直接在 list_item 的首层 paragraph 中时匹配
// ($from.node(-1) 是 list_item)。当光标在 list_item 内的嵌套 block
// (blockquote / alert / …)的 paragraph 中时,splitListItem 返回 false,
// 接下来 liftListItem 会错误匹配(bullet_list 的 blockRange 谓词命中),
// 把整个 list_item 提升出 list —— 用户看到 "list 降了一级"。
//
// 此守卫检测该场景,跳过 liftListItem 直接处理:
// - 空段落 → liftEmptyBlock(提升出嵌套 block,与顶层 blockquote 退出一致)
// - 非空段落 → splitBlock(在嵌套 block 内正常分裂段落)
function splitInListItemNestedBlock(state: any, dispatch?: any): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const { $from } = selection

  // 祖先链中有 list_item 吗?
  let listItemDepth = -1
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'list_item') {
      listItemDepth = d
      break
    }
  }
  if (listItemDepth < 0) return false

  // list_item 的直接子节点是 paragraph 吗?如果是,说明光标在 list_item 的
  // 首层 paragraph 中,splitListItem / liftListItem 的正常逻辑应接管。
  // list_item content 是 'paragraph block*',首子必须是 paragraph。
  // 当光标在 list_item 的非首子(嵌套 block)中时,$from.node(listItemDepth)
  // 是 list_item,而 $from.node(listItemDepth + 1) 是嵌套 block(blockquote /
  // alert / ...),不是 paragraph。
  const directChild = $from.node(listItemDepth + 1)
  if (directChild && directChild.type.name === 'paragraph') return false

  // 光标在 list_item 内的嵌套 block 中。
  // 空段落 → liftEmptyBlock(提升出嵌套 block,与顶层 blockquote 退出行为一致);
  // 非空 → splitBlock(在嵌套 block 内分裂段落)。
  if ($from.parent.content.size === 0) return liftEmptyBlock(state, dispatch)
  return splitBlock(state, dispatch)
}

// ============================================================
//  image NodeView + Tauri 协议注入
// ============================================================

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// 把 markdown 里的 src(相对 / 绝对路径)转成浏览器可展示 url —— image NodeView
// 与 imageEdit 预览 widget 共用同一份解析,避免渲染态与编辑态预览分叉。
function resolveImageSrc(url: string): string {
  if (!isTauriEnv()) return url
  if (/^(https?:|data:|asset:|tauri:)/.test(url)) return url
  const currentFilePath = useDocumentStore().currentFilePath
  const absPath = resolveImageAssetAbsPath(url, currentFilePath)
  if (!absPath.startsWith('/') && !/^[A-Z]:/i.test(absPath)) return absPath
  return convertFileSrc(absPath)
}

const imageNodeView = createImageNodeView({ proxyDomURL: resolveImageSrc })
const imageEditPlugin = createImageEditPlugin({ proxyDomURL: resolveImageSrc })
const htmlNodeViewPlugin = createHtmlNodeViewPlugin({ proxyDomURL: resolveImageSrc })

// image_inline NodeView 接到 mathEditPlugin 同一个 Plugin 里。
const imageInlineViewPlugin = new Plugin({
  key: new PluginKey('imageInlineView'),
  props: {
    nodeViews: { image: imageNodeView },
  },
})

// hr NodeView:block(atom) 包裹在 <div class="velo-hr">,提供可选中视觉态。
// 与 image 同范式,挂成独立 plugin 让 PM 在渲染 hr 节点时走 NodeView。
const hrNodeViewPlugin = new Plugin({
  key: new PluginKey('hrNodeView'),
  props: {
    nodeViews: { hr: createHrNodeView() },
  },
})

// emoji NodeView:inline(atom) 节点,查 node-emoji 表把 shortcode 转 Unicode emoji
// char 渲染到 <span>。与 hr / image 同范式,挂成独立 plugin。
const emojiNodeViewPlugin = new Plugin({
  key: new PluginKey('emojiNodeView'),
  props: {
    nodeViews: { emoji: createEmojiNodeView() },
  },
})

// image upload 拦截 paste/drop:走 saveImageAsset,直接 save+insert。

// ============================================================
//  插件注册 — 物理顺序无关,resolvePlugins 按 CANONICAL_PLUGIN_ORDER
//  (plugins/order.ts) 排序。requires 声明显式依赖,解析器校验后排序。
// ============================================================

const pluginEntries: PluginEntry[] = [
  // ── Suggest(必须在 keymap 之前) ──────────────────────────────────
  // ``` 语言建议下拉:handleKeyDown 需在 Enter 链(codeBlockEnterCommand)之前
  // 拦截上下键导航和高亮条目的 Enter 提交。
  { id: 'codeBlockLangSuggest', plugin: codeBlockLangSuggestPlugin },
  // `:short` emoji 自动补全下拉:handleKeyDown 需拦截 ArrowUp/Down/Enter/Escape。
  { id: 'emojiSuggest', plugin: emojiSuggestPlugin },

  // ── Keymap ────────────────────────────────────────────────────────
  // 自定义 Backspace / Delete:
  //   0. foldDeleteCommand:选区覆盖 fold_placeholder 节点时扩展删除到折叠区段末尾
  //      (必须排在最前,先于 baseKeymap['Backspace'] 否则 baseKeymap 直接删选区,
  //      foldDeleteCommand 没机会扩展)
  //   1. frontmatterBackspaceCommand:在 frontmatter 首位按 Backspace —— 有内容时
  //      吞掉事件,空 frontmatter 删除节点(连同尾随空段)。必须排在 codeBlock 前。
  //   2. codeBlockBackspaceCommand:在 code_block 首位按 Backspace —— 有内容时
  //      吞掉事件(不允许影响外面的行),空代码块转回 paragraph。必须排在
  //      baseKeymap 前,否则 joinBackward 会把代码块降级合并到上一段。
  //   3. headingToParagraph:heading 前退化为段落
  //   4. emptyParaBeforeListBackspace:列表下方空段落 Backspace → 直接删除空行
  //      (不走到 baseKeymap 的 joinBackward,否则空段落会被合并进列表末尾 list_item)
  //   5. baseKeymap['Backspace']:兜底
  {
    id: 'keymap.backspaceDeleteSelectAll',
    plugin: keymap({
      Backspace: chainCommands(foldDeleteCommand, frontmatterBackspaceCommand, codeBlockBackspaceCommand, headingToParagraph, emptyParaBeforeListBackspace, baseKeymap['Backspace']),
      Delete: chainCommands(foldDeleteCommand, headingToParagraph, baseKeymap['Delete']),
      // Mod-a:code_block 内只选 block 内容;其他位置放行给 baseKeymap 的 selectAll。
      'Mod-a': chainCommands(selectInsideCodeBlock, selectAll),
    }),
  },
  { id: 'keymap.undoRedo', plugin: keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }) },
  // Enter 链:
  //   1. codeBlockEnter:code_block 内只插 \n(保持一个 block)
  //   2. cmdTableCellEnter:table cell 内 Enter → 跳下一行同列(末行追加行)
  //      放在 dollarEnterCmd / frontmatterEnterCommand / hrEnterCommand 之前 ——
  //      这些命令会在 cell 内尝试创建 block 节点(math_block / frontmatter / hr),
  //      但 cell schema 只允许 paragraph,会导致无效文档。
  //   3. dollarEnterCmd:`$$` + Enter → math_block 编辑态
  //   4. splitListItem:有内容的 list_item 内 Enter 产生新 list_item
  //   5. splitInListItemNestedBlock:list_item 内嵌套 block(blockquote / alert)
  //      的 paragraph 中 Enter → 走 splitBlock 在嵌套 block 内分裂段落。
  //      必须排在 liftListItem 之前 —— 否则 liftListItem 的 blockRange 谓词
  //      会匹配到 bullet_list(首子是 list_item),把整个 list_item 提升出
  //      list,用户感知 "list 降了一级"。
  //   6. liftListItem:空 list_item 内 Enter 把当前项提升为普通 paragraph
  //      (splitListItem 在空 list_item 里 return false,不能 fall back 到
  //      splitBlock —— 否则 list_item 里又开一段 paragraph,跟之前有内容
  //      时的行为割裂)
  //   7. frontmatterEnterCommand:文档首段 `---`/`+++`+Enter → frontmatter 节点
  //   8. hrEnterCommand:任意位置 `---`/`***`/`___`+Enter → hr 节点
  //   9. liftEmptyBlock:空段落(含 blockquote / alert / list_item 内的空段落)
  //      按 Enter → 提升出父节点(用户感知"退出引用/警告框")。
  //      必须排在 splitBlock 之前 —— splitBlock 在空段落里也会成功(分裂出
  //      另一个空段落),导致用户被困在 blockquote 内永远出不来。
  //   10. splitBlock:兜底,普通段落里换行
  // Shift-Enter 多场景命令链:
  //   1. codeBlockExit:code_block 内 → 在 block 后插入段落(跳出代码块)
  //   2. cmdTableCellHardBreak:table cell 内 → 插 <br>(格内换行)
  //   3. shiftEnterExitBlock:blockquote / alert 内 → 在 block 后插入段落(退出引用)
  //   4. shiftEnterListItem:list_item 首层 paragraph 内 → splitBlock(产生缩进段落,
  //      等同 Enter+Backspace,不创建新 list_item)
  //   5. splitBlock:兜底,普通段落 / 嵌套 block 内正常换行
  {
    id: 'keymap.enter',
    plugin: keymap({
      Enter: chainCommands(
        codeBlockEnter,
        cmdTableCellEnter(),
        dollarEnterCmd,
        codeBlockEnterCommand,
        frontmatterEnterCommand,
        hrEnterCommand,
        splitListItem(schema.nodes.list_item),
        splitInListItemNestedBlock,
        liftListItem(schema.nodes.list_item),
        liftEmptyBlock,
        splitBlock,
      ),
      'Shift-Enter': chainCommands(
        codeBlockExit,
        cmdTableCellHardBreak(),
        shiftEnterExitBlock,
        shiftEnterListItem,
        splitBlock,
      ),
    }),
  },
  // baseKeymap 装在最后:接管未自定义的所有键(Enter, Backspace-after-failed, ...)
  { id: 'keymap.base', plugin: keymap(baseKeymap) },
  { id: 'tabIndent', plugin: tabIndent },
  { id: 'dollarEnterToMathBlock', plugin: dollarEnterToMathBlock },
  { id: 'imageKeymap', plugin: imageKeymapPlugin },

  // ── Cursor & History ──────────────────────────────────────────────
  { id: 'dropCursor', plugin: dropCursor({ color: false, class: 'velo-drop-cursor' }) },
  { id: 'gapCursor', plugin: gapCursor() },
  { id: 'history', plugin: history() },

  // ── Table ─────────────────────────────────────────────────────────
  // 表格:列宽拖拽 + 单元格选中/Tab 导航/复制粘贴。
  // columnResizing 必须在 tableEditing 之前(列宽拖柄优先响应鼠标事件)。
  // tableCellInputGuard 必须在 tableEditing 之前(其 handlePaste 需先于
  //   tableEditing 的 handlePaste 被试:HTML 路径粘贴时 DOMParser 用 table_cell
  //   context 剥离 <tr>/<td> → pastedCells 返回 null → tableEditing 走 1×1 fallback
  //   → 行列错乱;guard 检测到无表格结构时从 clipboard text 重建 TSV slice 再委托)。
  { id: 'tableColumnResizing', plugin: columnResizing({ handleWidth: 5, cellMinWidth: 24, lastColumnResizable: false }) },
  { id: 'tableCellInputGuard', plugin: createTableCellInputGuardPlugin() },
  { id: 'tableEditing', plugin: tableEditing(), requires: ['tableColumnResizing', 'tableCellInputGuard'] },
  { id: 'tableResizeCursor', plugin: createTableResizeCursorPlugin() },
  {
    id: 'tableInsertHandle',
    plugin: createTableInsertHandlePlugin({
      onInsert: (cellPos, type, dir) => {
        if (!hasTableEditorView()) return
        if (type === 'row') {
          runTableCommand(dir === 'before' ? addRowBefore(cellPos) : addRowAfter(cellPos))
        } else {
          runTableCommand(dir === 'before' ? addColumnBefore(cellPos) : addColumnAfter(cellPos))
        }
      },
    }),
  },
  {
    id: 'tableContextMenu',
    plugin: createTableContextMenuPlugin({
      onTableContextMenu: (clickCellPos, inHeader, isCellSelection, x, y) => {
        tableMenuAnchorPos.value = clickCellPos
        tableMenuInHeader.value = inHeader
        tableMenuIsCellSelection.value = isCellSelection
        tableMenuX.value = x
        tableMenuY.value = y
        // 计算移动按钮的隐藏标志
        tableMenuHideMoveRow.value = inHeader
        // 单列表格隐藏列移动
        tableMenuHideMoveColumn.value = computeTableMenuHideMoveColumn(clickCellPos)
        showTableMenu.value = true
      },
    }),
  },

  // ── Paste & Upload ────────────────────────────────────────────────
  { id: 'imageUpload', plugin: imageUploadPlugin },
  // markdownPastePlugin 接管 text/plain 粘贴 → 走 fromMarkdown,绕开 ProseMirror
  // 默认 plain-text fallback 的 normalizeSiblings 错误合并;与 imageUploadPlugin
  // 不冲突(imageUploadPlugin 只 handlePaste 拦截 image/* 文件,非图片返回 false;
  // clipboardTextParser 是独立 prop,仅在 text/plain 路径生效,text/html 不受影响)
  { id: 'markdownPaste', plugin: markdownPastePlugin },

  // ── Link & Image Edit ─────────────────────────────────────────────
  { id: 'linkClick', plugin: linkClickPlugin },
  { id: 'linkEditEscape', plugin: linkEditEscapeKeymap },
  { id: 'imageEdit', plugin: imageEditPlugin },
  { id: 'imageEditEscape', plugin: imageEditEscapeKeymap },

  // ── Source Edit (must precede syntaxAutoFormat) ───────────────────
  // mark 源码编辑(Obsidian Live Preview 风格):光标进入 **bold** 等 mark 范围 →
  // appendTransaction 把整段换源码字符可编辑;移出光标 commit 还原。放 syntaxAutoFormat
  // 之前 —— appendTransaction 的 enter 让 syntaxAutoFormat 的 getActiveEditRange 在
  // pass 2 读到 session 自动退避(不会把用户源码 `**` 又转回 mark)。
  { id: 'markSourceEdit', plugin: markSourceEditPlugin },
  { id: 'markSourceEditEscape', plugin: markSourceEditEscapeKeymap },
  { id: 'htmlSourceEdit', plugin: htmlSourceEditPlugin },
  { id: 'htmlSourceEditEscape', plugin: htmlSourceEditEscapeKeymap },
  // emoji 源码编辑(Obsidian Live Preview 风格):光标靠近 emoji 节点 →
  // appendTransaction 把 emoji 替换为 :shortcode: 源码文本可编辑;移出光标 commit
  // 还原。放 syntaxAutoFormat 之前 —— appendTransaction 的 enter 让 syntaxAutoFormat
  // 退避(不会把源码 :xxx: 又转回 emoji)。
  { id: 'emojiSourceEdit', plugin: emojiSourceEditPlugin },
  { id: 'emojiSourceEditEscape', plugin: emojiSourceEditEscapeKeymap },

  // ── Syntax & Input ────────────────────────────────────────────────
  { id: 'syntaxAutoFormat', plugin: syntaxAutoFormatPlugin },

  // ── Viewport (must precede decoration plugins) ────────────────────
  // viewportPlugin 必须在 decoration 插件之前：decoration 插件的 buildDecorations
  // 读 viewportKey.getState(state) 做 viewport 过滤，plugin apply 顺序 = allPlugins 数组顺序
  { id: 'viewport', plugin: viewportPlugin },

  // ── Code Decorations (read viewport state) ────────────────────────
  { id: 'codeHighlight', plugin: codeHighlightPlugin },
  { id: 'codeWrap', plugin: codeWrapPlugin },
  { id: 'codeLineNumber', plugin: codeLineNumberPlugin },

  // ── NodeView ──────────────────────────────────────────────────────
  { id: 'imageInlineView', plugin: imageInlineViewPlugin },
  { id: 'hrNodeView', plugin: hrNodeViewPlugin },
  { id: 'emojiNodeView', plugin: emojiNodeViewPlugin },
  { id: 'frontmatterNodeView', plugin: frontmatterNodeViewPlugin },
  { id: 'htmlNodeView', plugin: htmlNodeViewPlugin },

  // ── Math & Mermaid ────────────────────────────────────────────────
  { id: 'mathEdit', plugin: mathEditPlugin },
  { id: 'mermaidDecoration', plugin: mermaidDecoration },

  // ── Misc Decorations ──────────────────────────────────────────────
  { id: 'taskList', plugin: taskListPlugin },
  { id: 'footnoteEdit', plugin: footnoteEditPlugin },
  { id: 'tocDecoration', plugin: tocDecoration },
  { id: 'foldDecoration', plugin: foldDecoration },
  { id: 'findHighlight', plugin: findHighlight },

  // ── Mode ──────────────────────────────────────────────────────────
  { id: 'focusMode', plugin: focusModePlugin },
  { id: 'typewriterMode', plugin: typewriterModePlugin },

  // ── CJK (letterSpacing → autoFormat → autoPair) ───────────────────
  { id: 'cjkLetterSpacing', plugin: cjkLetterSpacingPlugin },
  { id: 'cjkAutoFormat', plugin: cjkAutoFormatPlugin },
  { id: 'autoPair', plugin: autoPairPlugin },

  // ── Tail ──────────────────────────────────────────────────────────
  // 只剩"纯文本→纯文本"的快速路径在 InputRule 里;有段级语义 / 转节点 /
  // 加 mark 的语法都走 syntaxAutoFormatPlugin。
  { id: 'inputRules', plugin: inputRules({ rules: [ellipsis] }) },
  // 快捷键 keymap(declarative registry)—— 优先级在 history / baseKeymap 之后,
  // 让内置 Backspace / Enter / Tab 链先响应,shortcuts 只补"未自定义"的键。
  { id: 'shortcutKeymap', plugin: buildShortcutKeymap() },
]

const allPlugins = resolvePlugins(pluginEntries)

// ============================================================
//  Vue 组件壳
// ============================================================

const props = withDefaults(defineProps<{
  modelValue: string
  /** 只读模式：禁用编辑器输入，用于示例文档等不允许直接修改的场景。 */
  readOnly?: boolean
  /** 专注模式：当前段落外内容降透明度。 */
  focusMode?: boolean
  /** 打字机模式：光标锁定在视口中线（文档在光标下滚动）。 */
  typewriterMode?: boolean
}>(), {
  readOnly: false,
  focusMode: false,
  typewriterMode: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'cursor-position-change': [position: CursorPosition]
  'heading-context-change': [chain: HeadingBreadcrumb[]]
  /** 大文档异步加载状态变化。父级在滚动容器外渲染遮罩，
   *  避免遮罩随内容滚动出可视区。 */
  'loading-change': [loading: boolean]
}>()

// 区分 self-emit echo vs 外部 modelValue 变化。值匹配 → echo,跳过;
// 否则 → 直接 view.updateState 替换内部状态,plugin state 因 init 跑而归零
// (等价于"销毁重建 EditorView",但不动 view 实例,不重挂 NodeView 容器)。
let lastSelfEmitted: string | null = null
// 切标签恢复期间(tabSwitchToken watch 调 view.updateState(cachedState) 后)
// 置 true,让同 tick 的 modelValue watch 跳过重建 —— 否则缓存恢复的 undo 历史被
// EditorState.create 重置掉。flush:'sync' 的 tabSwitchToken watch 先跑置位,
// pre-flush 的 modelValue watch 读到后清位跳过。
let pendingTabRestore = false
// 首次挂载完成 = onReady 跑过 = mounted。后续 watch 触发的都是"外部 modelValue
// 切换",这时拉焦点回编辑区(切文件 / CLI 打开 / 外部同步的明确意图)。
// 启动期(mounted=false)不抢焦点,避免把 DraftRecoveryDialog 等启动期弹窗的
// 焦点踢走。
let mounted = false
// 跟踪上一个活动标签 id,切标签时据此把旧标签的 PM state + scrollTop
// 同步写回 store(flush:'sync' watch 里,view 仍持有旧标签的 state)。
let prevActiveId = ''
// C2: 折叠恢复 rAF 句柄,切文件 / 首挂时延迟 dispatch initCollapsedKeys,让编辑器先渲染未折叠内容
// C3: 大文档 loading 遮罩 —— fromMarkdownAsync 在 Worker 后台解析,遮罩让用户看到即时反馈
const docLoading = ref(false)
// C1: parse 取消令牌。modelValue 快速连续变化(切 tab)时,旧 Worker 请求的结果应丢弃。
// 每次 watch 递增 token,await 返回后检查 token 是否仍是最新,否则放弃结果。
let parseToken = 0

// ---- toMarkdown debounce ----
// 大文档下 toMarkdown 序列化耗时数十毫秒,每次按键同步执行会拖慢输入。
// debounce 150ms:连续打字期间不序列化,停顿后才触发。
// - lastSelfEmitted 仍在 emit 时设置(与 modelValue watch 的 echo 检测同步)
// - 组件卸载时 flush,防止丢失最后一次编辑
// - 外部 modelValue 变化(切文件 / fs:watch)时 cancel,防止旧 doc 序列化结果覆盖新内容
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pendingDoc: PMNode | null = null
const DEBOUNCE_MS = 150

function cancelPendingEmit(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  pendingDoc = null
}

function flushPendingEmit(): void {
  if (debounceTimer && pendingDoc) {
    clearTimeout(debounceTimer)
    debounceTimer = null
    const doc = pendingDoc
    pendingDoc = null
    doEmitMarkdown(doc)
  }
}

/**
 * 执行 toMarkdown 序列化 + emit。
 * 从 onChange 回调和 debounce flush 两处调用。
 */
function doEmitMarkdown(doc: PMNode): void {
  const view = getView()
  const ranges = view ? getSourceEditRanges(view.state) : []
  let md: string
  if (ranges.length > 0) {
    // 源码编辑 session 活跃时,doc 中是纯文本源码(`![alt](src)` 等),
    // toMarkdown 会转义语法字符(`![` → `\![`)。用纯字母占位符替换源码文本,
    // toMarkdown 不会转义字母,输出后再把占位符还原为原始文本。
    const schema_ = doc.type.schema
    let tr = view!.state.tr
    const restores: { placeholder: string; original: string }[] = []
    for (let i = ranges.length - 1; i >= 0; i--) {
      const { from, to } = ranges[i]
      const original = doc.textBetween(from, to, '\n', '\n')
      if (!original) continue
      const placeholder = `veloRaw${i}Placeholder`
      tr = tr.replaceWith(from, to, schema_.text(placeholder))
      restores.unshift({ placeholder, original })
    }
    md = toMarkdown(tr.doc)
    for (const { placeholder, original } of restores) {
      md = md.replace(placeholder, original)
    }
  } else {
    md = toMarkdown(doc)
  }
  lastSelfEmitted = md
  emit('update:modelValue', md)
}

// 折叠状态持久化 store —— scheduleFoldRestore 读取当前文件的稳定 key 集合
const foldStore = useFoldStore()
let pendingFoldRestoreRAF: number | null = null

function emitCursorPosition() {
  const view = getView()
  if (!view) return
  const pos = view.state.selection.head
  const textBefore = view.state.doc.textBetween(0, pos, '\n', '\n')
  emit('cursor-position-change', cursorFromTextBefore(textBefore))
}

function emitHeadingContext() {
  const view = getView()
  if (!view) return
  emit('heading-context-change', headingChainFromDoc(view.state.doc, view.state.selection.head))
}

watch(() => props.modelValue, async (newVal) => {
  // 外部 modelValue 变化(切文件 / fs:watch / CLI 打开):cancel pending debounce,
  // 防止旧 doc 的序列化结果在 150ms 后覆盖新内容。
  cancelPendingEmit()
  if (pendingTabRestore) {
    // 切标签恢复已由 tabSwitchToken watch 调 view.updateState(cachedState) 处理,
    // 这里不能再 EditorState.create 重建(会丢 undo)。清 flag 跳过。
    pendingTabRestore = false
    return
  }
  if (newVal === lastSelfEmitted) return
  const view = getView()
  if (!view) return

  // parseToken 在分支前 bump：无论大 / 小文档路径，只要 modelValue 变了就
  // 让此前的大文档异步链（双 rAF + Worker parse）失效，防止旧异步结果
  // 覆盖新内容（大文件 → 快速切小文件竞态根因）。
  const myToken = ++parseToken

  // C1+C3: 大文档(> 2000 行)loading 遮罩 + Worker 异步 parse。
  // loadContentInto 已跳过同步 fromMarkdown(C3),pendingPmDoc 为 null →
  // fallback 走 fromMarkdownAsync(newVal)。双 rAF 确保浏览器先 paint 遮罩:
  // 第一帧 Vue 更新 DOM 加遮罩;第二帧浏览器 paint 遮罩 → Worker parse(不阻塞)
  // 或同步降级(阻塞,但遮罩已可见)。
  const isLargeDoc = newVal.split('\n').length > 2000
  if (isLargeDoc) {
    docLoading.value = true
    emit('loading-change', true)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    // rAF 期间可能已切到另一个 tab(modelValue 再变),token 失效 → 放弃。
    // 必须关 loading 遮罩：本次异步链放弃了，如果不重置，遮罩会永久卡住。
    // 后续触发的 modelValue watch 会重新设 loading=true 并接管加载。
    if (myToken !== parseToken) {
      docLoading.value = false
      emit('loading-change', false)
      return
    }
    // C0: 优先消费 pendingPmDoc(延迟期间 loadContentInto 可能已存入)。
    const pendingDoc = documentStore.consumePendingPmDoc() as PMNode | null
    const doc = pendingDoc ?? await fromMarkdownAsync(newVal, schema as VeloSchema)
    // Worker 解析期间可能又切了 tab,token 失效 → 放弃（同上，必须关 loading）
    if (myToken !== parseToken) {
      docLoading.value = false
      emit('loading-change', false)
      return
    }
    const openFocus = decideOpenFocus(doc)
    // C1: 预设窄 viewport hint，让 decoration 插件只为首屏节点构建装饰，
    // 避免为整个大文档同步跑 shiki tokenization + 创建 header widget DOM。
    // updateState 后 rAF 调 refreshViewport 计算真实 viewport 触发重建。
    setInitialViewportHint({ from: 0, to: 5000 })
    const newState = EditorState.create({
      schema,
      doc,
      plugins: allPlugins,
      selection: openFocus.selection,
    })
    setInitialViewportHint(null) // 立即清除，防泄漏到后续 state 创建
    view.updateState(newState)
    docLoading.value = false
    emit('loading-change', false)
    resetScrollToTop()
    // view factory 的 rAF 只在首次 mount 时跑一次；文件切换走 updateState
    // 后需手动刷新 viewport，让 decoration 插件为真实可见区域重建装饰。
    requestAnimationFrame(() => refreshViewport(view))
    documentStore.captureActivePmState(view.state, 0)
    scheduleFoldRestore(view)
    await nextTick()
    if (mounted && openFocus.shouldFocus) {
      try { view.focus() } catch { /* 销毁期忽略 */ }
    }
    emitCursorPosition()
    emitHeadingContext()
    return
  }

  // 小文档:同步路径(无遮罩,无 Worker)
  // C0: 优先消费 loadContentInto 存入的 pendingPmDoc,跳过冗余 fromMarkdown。
  const pendingDoc = documentStore.consumePendingPmDoc() as PMNode | null
  const doc = pendingDoc ?? fromMarkdown(newVal, schema as VeloSchema)
  const openFocus = decideOpenFocus(doc)
  view.updateState(EditorState.create({
    schema,
    doc,
    plugins: allPlugins,
    selection: openFocus.selection,
  }))
  docLoading.value = false
  emit('loading-change', false)
  // 切换文档时把视口滚动位置归零 —— PM updateState 会尽量保留旧视口
  // 位置(尤其旧文档短、视口足以装下新文档时),即便 selection 已经在
  // doc 顶部,viewport 仍可能停在旧位置。
  // view.dom 自身不带 overflow(PM 的 .ProseMirror 只是 contentEditable),
  // 真实滚动容器是上层 overflow:auto 的 wrapper —— useProseMirror 的
  // resetScrollToTop() 沿祖先链 walk 找最近的可滚祖先并 scrollTop=0。
  resetScrollToTop()
  // 装载后立即缓存初始 PM state + scrollTop=0:文件装载走 view.updateState
  // 而非 dispatchTransaction,onSelectionChange 不跑 → pmState 为 undefined。
  // 切回时 peekActivePmStateForRestore 返回 null → 走重建 + resetScrollToTop,
  // 滚动位置丢失。这里在装载后立即缓存。
  documentStore.captureActivePmState(view.state, 0)
  // C2: 延迟折叠恢复到下一帧 —— view.updateState 已完成,单 rAF 即可
  scheduleFoldRestore(view)
  // 等同 tick 的 props 副作用跑完(典型:从只读 sample 切到新建文件时,
  // readOnly watch 在同一 tick 内把 view.editable 从 false 翻 true)。
  // 否则 view.focus() 在 editable=false 状态下调用,PM 拒键盘事件,
  // 用户感知"焦点没拉进编辑器"。
  await nextTick()
  // 打开文件:按 doc 形态决定是否抢焦点。
  // 决策见 editor/openFocus.ts —— 默认不抢焦点,避免屏幕顶部高亮(TOC / 首段)
  // 抢占用户注意力;唯一例外是整个文档只有一个空段落(典型:新建空白文档),
  // 这种情况下把 selection 移到末尾并 focus,免去用户点一下编辑器再打字的步骤。
  // (非空内容 + 尾空段不在此列 —— atEnd 会被打字机居中、视口跳末行)
  if (mounted && openFocus.shouldFocus) {
    try { view.focus() } catch { /* 销毁期忽略 */ }
  }
  emitCursorPosition()
emitHeadingContext()
})

const documentStore = useDocumentStore()

/**
 * C2: 延迟折叠恢复 —— 通过 rAF 把 initCollapsedKeys dispatch 推迟到下一帧,
 * 让编辑器先以未折叠状态渲染(paint),再在下一帧应用折叠。大文档下折叠区段
 * display:none 的 Decoration.node 构建开销可观,延后一帧可显著降低首屏 TTI。
 *
 * key→pos 翻译在 foldDecoration.apply 内部完成(经 initCollapsedKeys meta),
 * 复用 scanDoc 缓存 + 确保翻译用的是 view.updateState 后的正确 doc。
 *
 * @param delay onReady 路径传 true:大文档 useProseMirror 在 rAF 里才
 *   view.updateState 真实 doc,双 rAF 确保折叠恢复在真实 doc 就绪后执行。
 *   modelValue watch 路径传 false:view.updateState 已同步完成,单 rAF 足够。
 */
function scheduleFoldRestore(view: EditorView, delay = false) {
  if (pendingFoldRestoreRAF != null) cancelAnimationFrame(pendingFoldRestoreRAF)
  const path = documentStore.currentFilePath
  if (!path) return
  const keys = foldStore.getKeysFor(path)
  if (keys.length === 0) return
  const fire = () => {
    pendingFoldRestoreRAF = null
    if (view.isDestroyed) return
    view.dispatch(view.state.tr.setMeta(foldKey, { initCollapsedKeys: keys }))
  }
  if (delay) {
    pendingFoldRestoreRAF = requestAnimationFrame(() => {
      if (view.isDestroyed) return
      pendingFoldRestoreRAF = requestAnimationFrame(fire)
    })
  } else {
    pendingFoldRestoreRAF = requestAnimationFrame(fire)
  }
}

// 切标签:恢复该标签缓存的 PM state(保 undo 历史 / 光标),而非 modelValue watch 的重建路径。
// flush:'sync' 确保 tabSwitchToken 自增后立即恢复,先于 modelValue(pre-flush)watch 跑;
// 后者看到 pendingTabRestore=true 跳过重建。
//
// 滚动位置保留:PM 不像 CM6 有 viewportChanged 信号,滚动不产生 transaction →
// onSelectionChange 不跑 → store 里的 scrollTop 停在上次选区变更时的值。
// 解法:在此 watch(同步)里,restore 新标签**之前**先把旧标签的 view.state +
// scrollTop 写回 store。此时 activeId 已指向新标签,但 view 仍持有旧标签的
// EditorState、滚动容器仍是旧标签的位置 —— 原子保存,无 rAF 竞态。
watch(() => documentStore.tabSwitchToken, () => {
  if (!mounted) return
  const view = getView()
  if (!view) return
  // 同步捕获即将离开的标签的 state + 滚动位
  if (prevActiveId && prevActiveId !== documentStore.activeId) {
    const scroller = findScrollAncestor(view.dom)
    const scrollTop = scroller ? scroller.scrollTop : 0
    documentStore.capturePmStateForDoc(prevActiveId, view.state, scrollTop)
  }
  const cached = documentStore.peekActivePmStateForRestore()
  prevActiveId = documentStore.activeId // 无论 cache 命中与否都更新
  if (!cached) return // 无缓存 / 内容已外部改 → 走 modelValue watch 重建
  pendingTabRestore = true
  view.updateState(cached.state as EditorState)
  if (cached.scrollTop != null) restoreScrollTop(cached.scrollTop)
}, { flush: 'sync' })

// 用户明确意图切换文件(目前只 newDoc 走这条)的独立 hint 通道。
// 解决"content 已是 '' 时再点 Ctrl+N,Vue modelValue watch 不触发"的死锁——
// focusRequestToken 在 stores/document.ts 的 newDoc() 内 ++,
// 任一 Vue watch 触发(token watch 独立于 modelValue watch)。
watch(() => useDocumentStore().focusRequestToken, async (n, prev) => {
  // 初始化那一次:prev === undefined,跳过(初始 focus 走 mount 路径,不在这里管)
  if (prev === undefined) return
  if (n === prev) return
  if (!mounted) return
  // 等 modelValue watch(同 tick 内 dispatch)+ readOnly watch + 其它 props 翻转完成
  await nextTick()
  const view = getView()
  if (!view) return
  try { view.focus() } catch { /* 销毁期忽略 */ }
})

// useProseMirror 返回的 containerRef 直接绑到 template ref。TS 看不到
// template ref 的隐式 binding 会误报未使用变量,这里通过 defineExpose
// 把它暴露出去 —— TS 看到暴露对象消费过 ref 就不再报。
const { containerRef, getView, setReadOnly, resetScrollToTop, restoreScrollTop } = useProseMirror({
  schema: schema as VeloSchema,
  initialDoc: props.modelValue,
  fromMarkdown: (md, s) => {
    // C0: useProseMirror onMounted / rAF 回调中优先消费 pendingPmDoc,
    //     跳过冗余 fromMarkdown(初始装载路径)。
    const pending = documentStore.consumePendingPmDoc() as PMNode | null
    if (pending) return pending
    // C1: 大文档走 Worker 异步 parse,小文档走同步
    if (md.split('\n').length > 2000) {
      return fromMarkdownAsync(md, s as VeloSchema)
    }
    return fromMarkdown(md, s as VeloSchema)
  },
  plugins: allPlugins,
  editable: !props.readOnly,
  onChange: (doc) => {
    // debounce toMarkdown:存储最新 doc,延迟序列化。
    // 连续打字期间 cancel 旧 timer 重设,停顿 DEBOUNCE_MS 后才执行 toMarkdown。
    // 注意:cancelPendingEmit 必须在 pendingDoc 赋值之前调,它会清 pendingDoc=null。
    cancelPendingEmit()
    pendingDoc = doc
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      const d = pendingDoc
      pendingDoc = null
      if (d) doEmitMarkdown(d)
    }, DEBOUNCE_MS)
    // state 缓存走 onSelectionChange(它覆盖 docChanged + selectionSet,更全)
  },
onSelectionChange: (view) => {
emitCursorPosition()
emitHeadingContext()
    // Step 3: 选区变化(含光标移动)也缓存,切回时恢复光标位 —— 不只编辑才记
    const scroller = (findScrollAncestor(view.dom) ?? view.dom)
    documentStore.captureActivePmState(view.state, scroller.scrollTop)
  },
onReady: () => {
mounted = true
prevActiveId = documentStore.activeId
emitCursorPosition()
emitHeadingContext()
    const view = getView()
    if (view) {
      registerTableEditorView(view)
      // 首挂时也缓存初始 PM state,覆盖「组件首挂 + modelValue watch 不 fire」的场景
      documentStore.captureActivePmState(view.state, 0)
      // C2: 首挂折叠恢复 —— delay=true(双 rAF)应对大文档 useProseMirror rAF 异步加载真实 doc
      scheduleFoldRestore(view, true)
    }
    // C3: 大文档冷启动 —— useProseMirror 在双 rAF 后才 fromMarkdown + view.updateState,
    // 期间显示 loading 遮罩,onLargeDocReady 回调关闭
    if (props.modelValue.split('\n').length > 2000) {
      docLoading.value = true
      emit('loading-change', true)
    }
  },
onLargeDocReady: () => {
docLoading.value = false
  emit('loading-change', false)
  },
})

// 动态切换只读:首次 mount 时 editable 已由 useProseMirror 的初值覆盖,此 watch
// 只管"挂载后 readOnly 翻转"(示例文档 → 切回普通文档)。卸载后 setReadOnly
// 内部 view 为 null 自动 no-op,无需判 unmounted。
watch(() => props.readOnly, (readOnly) => {
  setReadOnly(readOnly)
})

// 专注模式 toggle → 同步模块级镜像(切文件重建 state 时 init 读它)+ dispatch setMeta
// 让当前 view 立即生效。首挂时模块级镜像已在 setup 顶层设过(props 初值),
// state.init 读它拿到正确初值;本 watch 只管"用户后续改"。
setFocusModeEnabled(props.focusMode)
watch(() => props.focusMode, (enabled) => {
  setFocusModeEnabled(enabled)
  const view = getView()
  if (!view || view.isDestroyed) return
  view.dispatch(view.state.tr.setMeta(focusModeKey, { enabled }))
})

// 打字机模式 toggle → 同 focusMode 同款范式(模块级镜像 + setMeta)。
// 居中由 plugin 的 view.update() 在 justEnabled / sel/doc 变化时做,watch 不显式调。
setTypewriterModeEnabled(props.typewriterMode)
watch(() => props.typewriterMode, (enabled) => {
  setTypewriterModeEnabled(enabled)
  const view = getView()
  if (!view || view.isDestroyed) return
  view.dispatch(view.state.tr.setMeta(typewriterModeKey, { enabled }))
})

function focusEditor() {
  const view = getView()
  if (view && !view.hasFocus()) view.focus()
}

defineExpose({ focusEditor, getEditorView: getView, containerRef })

// 表格右键菜单:点击外部/滚动时关闭
const tableMenuRef = ref<InstanceType<typeof TableContextMenu> | null>(null)
useContextMenu({
  isOpen: () => showTableMenu.value,
  getMenuEl: () => tableMenuRef.value?.rootEl ?? null,
  close: () => { showTableMenu.value = false },
})

// 滚动/滚轮时关闭表格菜单(避免菜单与表格脱节)
function closeTableMenuOnScroll() {
  if (showTableMenu.value) showTableMenu.value = false
}
onMounted(() => {
  // 监听编辑器根容器的 wheel/scroll 事件,滚动时关闭菜单
  const el = containerRef.value
  if (el) {
    el.addEventListener('wheel', closeTableMenuOnScroll, { passive: true })
    el.addEventListener('scroll', closeTableMenuOnScroll, { passive: true })
  }
})
onBeforeUnmount(() => {
  // flush pending toMarkdown:防止最后一次编辑丢失
  flushPendingEmit()
  cancelPendingEmit()
  if (pendingFoldRestoreRAF != null) cancelAnimationFrame(pendingFoldRestoreRAF)
  const el = containerRef.value
  if (el) {
    el.removeEventListener('wheel', closeTableMenuOnScroll)
    el.removeEventListener('scroll', closeTableMenuOnScroll)
  }
  unregisterTableEditorView()
  // useProseMirror 内部已 destroy
})
</script>

<template>
  <!-- 挂载容器:ref 拿给 useProseMirror 内部 EditorView 挂 contentDOM 用 -->
  <div ref="containerRef" class="velo-editor-mount h-full w-full" data-testid="pm-editor" />
  <TableContextMenu
    v-if="showTableMenu"
    ref="tableMenuRef"
    :x="tableMenuX"
    :y="tableMenuY"
    :hide-delete-row="tableMenuInHeader && !tableMenuIsCellSelection"
    :hide-move-row="tableMenuHideMoveRow"
    :hide-move-column="tableMenuHideMoveColumn"
    @action="onTableMenuAction"
    @close="showTableMenu = false"
  />
</template>

<script setup lang="ts">
// 装配策略:
// - schema / markdownIO 来自 ./editor/
// - 历史 / dropCursor / gapCursor 走 prosemirror-* 官方插件
// - 修上游 markRule bug 的 fixedXxx 规则保留(markRule 仍来自 prosemirror-inputrules)
// - 各自定义 NodeView / Decoration / InputRule 走本地 nodes/* + image/* + findreplace/*
// - 写入时 toMarkdown(doc) → emit update:modelValue(走 markdownIO)
// - modelValue 外部变化时(切文件 / CLI 打开 / fs:watch 同步)→ 直接 view.updateState
//   重置 EditorState,无需销毁重建整个 EditorView(等价语义,plugin state 自然清零)

import { nextTick, onBeforeUnmount, watch } from 'vue'
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { inputRules, ellipsis } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { tableEditing, columnResizing } from 'prosemirror-tables'
import { sinkListItem, liftListItem, splitListItem } from 'prosemirror-schema-list'
import { baseKeymap, chainCommands, selectAll, splitBlock } from 'prosemirror-commands'
import { convertFileSrc } from '@tauri-apps/api/core'
import { schema, type VeloSchema } from './editor/schema'
import { fromMarkdown, toMarkdown } from './editor/markdownIO'
import { decideOpenFocus } from './editor/openFocus'
import { createImageNodeView } from './editor/imageNodeView'
import { createHrNodeView } from './nodes/HrNodeView'
import { frontmatterNodeViewPlugin } from './nodes/FrontmatterNodeView'
import { useProseMirror, findScrollAncestor } from './composables/useProseMirror'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from './nodes/MathNodeViews'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin } from './nodes/FootnoteNodeViews'
import { tocDecoration } from './nodes/TocDecoration'
import { htmlNodeViewPlugin } from './nodes/HtmlNodeView'
import { findHighlight } from './findreplace/findHighlight'
import { imageKeymapPlugin } from './image/imageKeymap'
import { imageUploadPlugin } from './image/imageUploadPlugin'
import { createImageEditPlugin, imageEditEscapeKeymap } from './image/imageEditPlugin'
import { linkClickPlugin, linkEditEscapeKeymap } from './plugins/linkClick'
import { syntaxAutoFormatPlugin } from './plugins/syntaxAutoFormat'
import { markSourceEditPlugin, markSourceEditEscapeKeymap } from './plugins/markSourceEdit'
import { markdownPastePlugin } from './plugins/markdownPastePlugin'
import { codeHighlightPlugin } from './nodes/CodeHighlightWidget'
import { codeLineNumberPlugin } from './nodes/CodeLineNumberWidget'
import { codeWrapPlugin } from './nodes/CodeWrapPlugin'
import { foldDecoration, foldKey, collectFoldableKeys } from './nodes/FoldDecoration'
import { focusModePlugin, focusModeKey, setFocusModeEnabled } from './plugins/focusMode'
import { typewriterModePlugin, typewriterModeKey, setTypewriterModeEnabled } from './plugins/typewriterMode'
import { useFoldStore } from '@/stores/folding'
import { codeBlockEnterCommand, codeBlockBackspaceCommand } from './syntax/block/codeBlock'
import { frontmatterBackspaceCommand } from './syntax/block/frontmatter'
import { codeBlockLangSuggestPlugin } from './plugins/codeBlockLangSuggest'
import { hrEnterCommand } from './syntax/block/hr'
import { frontmatterEnterCommand } from './syntax/block/frontmatter'
import './syntax' // 触发 syntax registry 注册副作用(block + inline 全套语法)
import './editor/shortcuts' // 触发 shortcut registry 注册副作用(Mod-b/i/h/k/0~6/t 等)
import { buildShortcutKeymap } from './editor/shortcuts'
import { useDocumentStore } from '@/stores/document'
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

    // 表格内不消费 Tab —— 让 tableEditing 的 goToNextCell 接管
    for (let d = $from.depth; d > 0; d--) {
      const role = $from.node(d).type.spec.tableRole
      if (role) return false
    }

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
  // ``` 语言建议下拉:必须在 keymap 之前,handleKeyDown 需在 Enter 链
  // (codeBlockEnterCommand) 之前拦截上下键导航和高亮条目的 Enter 提交。
  codeBlockLangSuggestPlugin,
  // 自定义 Backspace / Delete:
  //   1. frontmatterBackspaceCommand:在 frontmatter 首位按 Backspace —— 有内容时
  //      吞掉事件,空 frontmatter 删除节点(连同尾随空段)。必须排在 codeBlock 前。
  //   2. codeBlockBackspaceCommand:在 code_block 首位按 Backspace —— 有内容时
  //      吞掉事件(不允许影响外面的行),空代码块转回 paragraph。必须排在
  //      baseKeymap 前,否则 joinBackward 会把代码块降级合并到上一段。
  //   3. headingToParagraph:heading 前退化为段落
  //   4. baseKeymap['Backspace']:兜底
  keymap({
    Backspace: chainCommands(frontmatterBackspaceCommand, codeBlockBackspaceCommand, headingToParagraph, baseKeymap['Backspace']),
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
  //   4. frontmatterEnterCommand:文档首段 `---`/`+++`+Enter → frontmatter 节点
  //   5. hrEnterCommand:任意位置 `---`/`***`/`___`+Enter → hr 节点
  //   6. splitBlock:兜底,普通段落里换行
  keymap({
    Enter: chainCommands(
      codeBlockEnter,
      dollarEnterCmd,
      codeBlockEnterCommand,
      frontmatterEnterCommand,
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
  // 表格:列宽拖拽 + 单元格选中/Tab 导航/复制粘贴。
  // columnResizing 必须在 tableEditing 之前(列宽拖柄优先响应鼠标事件)。
  columnResizing({ handleWidth: 4, cellMinWidth: 24, lastColumnResizable: false }),
  tableEditing(),
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
  imageEditPlugin,
  imageEditEscapeKeymap,
  // mark 源码编辑(Obsidian Live Preview 风格):光标进入 **bold** 等 mark 范围 →
  // appendTransaction 把整段换源码字符可编辑;移出光标 commit 还原。放 syntaxAutoFormat
  // 之前 —— appendTransaction 的 enter 让 syntaxAutoFormat 的 getActiveEditRange 在
  // pass 2 读到 session 自动退避(不会把用户源码 `**` 又转回 mark)。
  markSourceEditPlugin,
  markSourceEditEscapeKeymap,
  syntaxAutoFormatPlugin,
  codeHighlightPlugin,
  codeWrapPlugin,
  codeLineNumberPlugin,
  imageInlineViewPlugin,
  hrNodeViewPlugin,
  frontmatterNodeViewPlugin,
  htmlNodeViewPlugin,
  mathEditPlugin,
  mermaidDecoration,
  taskListPlugin,
  footnoteEditPlugin,
  tocDecoration,
  foldDecoration,
  findHighlight,
  focusModePlugin,
  typewriterModePlugin,
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

// 折叠状态同步:文件切换时,把 store 里稳定 key 翻译成当前 doc 的 contentStart
// 灌进 plugin。文件 path 变化是这个 watch 的唯一信号(modelValue 变可能是
// 同文件内容回写,不能误触发)。
// 旧路径上的折叠 pos 灌 store 走 plugin view hook 的 diff 同步(见
// FoldDecoration.ts view.update 注释),本 watch 只负责"新文件灌入折叠 pos"。
const foldStore = useFoldStore()
let lastSeenFilePath: string | null = null

/**
 * 把 store 里的稳定 key 集合翻译成当前 doc 的 contentStart 数组。
 * 翻译失败的 key(用户改了 block 内容,key 变了)直接丢 —— 旧 block 已
 * 不存在,保留无意义;这是稳定 key 设计的取舍(见 stores/folding.ts 注释)。
 */
function foldKeysToPositions(
  doc: ReturnType<typeof fromMarkdown>,
  keys: string[],
): number[] {
  if (keys.length === 0) return []
  const set = new Set(keys)
  const positions: number[] = []
  for (const { contentStart, stableKey } of collectFoldableKeys(doc)) {
    if (set.has(stableKey)) positions.push(contentStart)
  }
  return positions
}

watch(() => useDocumentStore().currentFilePath, async (newPath) => {
  if (newPath === lastSeenFilePath) return
  lastSeenFilePath = newPath
  if (!mounted) return
  const view = getView()
  if (!view) return
  // 取新 doc:同 tick 内 modelValue watch 已 updateState,这里直接读
  const positions = foldKeysToPositions(view.state.doc, foldStore.getKeysFor(newPath))
  if (positions.length === 0) return
  view.dispatch(view.state.tr.setMeta(foldKey, { initCollapsed: positions }))
})

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
  if (pendingTabRestore) {
    // 切标签恢复已由 tabSwitchToken watch 调 view.updateState(cachedState) 处理,
    // 这里不能再 EditorState.create 重建(会丢 undo)。清 flag 跳过。
    pendingTabRestore = false
    return
  }
  if (newVal === lastSelfEmitted) return
  const view = getView()
  if (!view) return

  const doc = fromMarkdown(newVal, schema as VeloSchema)
  const openFocus = decideOpenFocus(doc)
  view.updateState(EditorState.create({
    schema,
    doc,
    plugins: allPlugins,
    selection: openFocus.selection,
  }))
  // 切换文档时把视口滚动位置归零 —— PM updateState 会尽量保留旧视口
  // 位置(尤其旧文档短、视口足以装下新文档时),即便 selection 已经在
  // doc 顶部,viewport 仍可能停在旧位置。
  // view.dom 自身不带 overflow(PM 的 .ProseMirror 只是 contentEditable),
  // 真实滚动容器是上层 overflow:auto 的 wrapper —— useProseMirror 的
  // resetScrollToTop() 沿祖先链 walk 找最近的可滚祖先并 scrollTop=0。
  resetScrollToTop()
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
// 切标签:恢复该标签缓存的 PM state(保 undo 历史 / 光标),而非 modelValue watch 的重建路径。
// flush:'sync' 确保 tabSwitchToken 自增后立即恢复,先于 modelValue(pre-flush)watch 跑;
// 后者看到 pendingTabRestore=true 跳过重建。
watch(() => documentStore.tabSwitchToken, () => {
  if (!mounted) return
  const view = getView()
  if (!view) return
  const cached = documentStore.peekActivePmStateForRestore()
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
  fromMarkdown: (md, s) => fromMarkdown(md, s as VeloSchema),
  plugins: allPlugins,
  editable: !props.readOnly,
  onChange: (doc) => {
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
emitCursorPosition()
emitHeadingContext()
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

onBeforeUnmount(() => {
  // useProseMirror 内部已 destroy
})
</script>

<template>
  <!-- 挂载容器:ref 拿给 useProseMirror 内部 EditorView 挂 contentDOM 用 -->
  <div ref="containerRef" class="velo-editor-mount h-full w-full" data-testid="pm-editor" />
</template>

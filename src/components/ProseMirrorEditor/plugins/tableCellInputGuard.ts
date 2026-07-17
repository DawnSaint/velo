// CellSelection 输入守卫 —— 多 cell 被选中(无光标)时吞掉文字输入和 Enter,
// 防止内容落入 DOM 选区所在的最后一个 cell。
//
// 背景:CellSelection.visible=false,PM 给 .ProseMirror 加 .ProseMirror-hideselection
// 隐藏原生选区视觉,但 DOM 选区仍留在最后一个 cell。用户敲字符时浏览器在该 cell
// 插入文字,看起来像"内容输入到了一个被选中的 cell 里"。
//
// 关键陷阱:光标从表格内拖选 cell 时,浏览器原生拖拽把 DOM 选区留在最后一个 cell
// 内部,与 PM 的 CellSelection 位置不一致。PM 内置 keydown 处理器在检查 handleKeyDown
// 之前先调 forceFlush(),forceFlush 检测到 DOM 选区差异后把 CellSelection 覆盖成
// TextSelection —— 之后 beforeinput / handleTextInput 的 instanceof CellSelection 检查
// 全部失效。因此必须在 handleDOMEvents.keydown 阶段(handleDOMEvents 先于内置处理器)
// preventDefault,跳过内置 keydown 处理器(含 forceFlush),保住 CellSelection。
//
// 不拦截:Backspace/Delete(tableEditing 的 deleteCellSelection 处理)、
// 方向键(tableEditing 的 arrow 处理)、Tab(tableEditing 的 goToNextCell 处理)、
// Ctrl/Meta/Alt 组合键。
//
// 剪贴板快捷键(Mod-c/v/x):不能 preventDefault(否则 copy/cut/paste 事件不触发),
// 但 forceFlush 同样会销毁 CellSelection。解决:在 forceFlush 运行前调
// domObserver.setCurSelection(),让 domObserver 认为 DOM 选区"没变",跳过
// selection 同步。之后 PM 的 handlers.copy / editHandlers.cut / editHandlers.paste
// 正常读到 CellSelection —— copy/cut 走 sel.content() 拿到矩形 cell 块,paste
// 走 tableEditing 的 handlePaste 做整块填充。

import { Plugin, PluginKey } from "prosemirror-state"
import { Fragment, Slice, type ResolvedPos, type Node, type Schema } from "prosemirror-model"
import { CellSelection, TableMap, handlePaste as tableHandlePaste } from "prosemirror-tables"
import type { EditorView } from "prosemirror-view"

export const tableCellInputGuardKey = new PluginKey("tableCellInputGuard")

// beforeinput inputType 中表示"插入文本内容"的类型(不含 delete*/paste/drop)。
// 用于 IME 组合输入(keydown keyCode=229 时 forceFlush 不跑,CellSelection 安全,
// 但 beforeinput 仍会派发 insertCompositionText)。
const INSERT_TEXT_TYPES = new Set([
  "insertText",
  "insertCompositionText",
  "insertParagraph",
  "insertLineBreak",
  "insertReplacementText",
])

// 判断 keydown 事件是否为"会产生文字内容插入"的按键(应被拦截)。
// 单字符键(a-z/0-9/标点/空格)+ Enter;排除 Ctrl/Meta/Alt 组合(快捷键)和
// 正在组合中(isComposing,交由 beforeinput 拦截)。
function isTextInsertingKey(event: KeyboardEvent): boolean {
  if (event.isComposing) return false
  const key = event.key
  if (key === "Enter") return true
  // 单字符键 = 可打印字符(不含功能键 F1~/Arrow~/Escape 等,length>1)
  return key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
}

// 判断 keydown 事件是否为剪贴板快捷键(Mod-c / Mod-v / Mod-x)。
// 这些键不能 preventDefault(否则 copy/cut/paste 事件不触发),但 forceFlush
// 会销毁 CellSelection,需在 forceFlush 前调 setCurSelection 保护。
function isClipboardShortcut(event: KeyboardEvent): boolean {
  if (!event.metaKey && !event.ctrlKey) return false
  if (event.altKey || event.shiftKey) return false
  const key = event.key.toLowerCase()
  return key === "c" || key === "v" || key === "x"
}

// 从 CellSelection 提取目标表格 + 粘贴矩形(top/left),用于判断每行应使用
// table_header(表头行)还是 table_cell(body 行)。
// 返回 null 表示无法确定(非 CellSelection 或表格不存在)。
function getTargetRowInfo(sel: CellSelection): { table: Node; rectTop: number } | null {
  const table = sel.$anchorCell.node(-1)
  if (!table || table.type.spec.tableRole !== 'table') return null
  const tableStart = sel.$anchorCell.start(-1)
  const map = TableMap.get(table)
  const rect = map.rectBetween(
    sel.$anchorCell.pos - tableStart,
    sel.$headCell.pos - tableStart,
  )
  return { table, rectTop: rect.top }
}

// 判断目标表格中第 rectTop + rowOffset 行是否为 table_header_row。
function isTargetHeaderRow(table: Node, rectTop: number, rowOffset: number): boolean {
  const idx = rectTop + rowOffset
  return idx < table.childCount && table.child(idx).type.name === 'table_header_row'
}

// 检查 slice 是否包含有效的表格行结构:所有子节点都是 row 且每行至少有一个 cell,
// 且 openStart/openEnd <= 1(CellSelection content() 的标准值)。
// DOMParser 用 table_cell 作为 context 解析含 <tr> 的 HTML 时,可能产出损坏的 slice:
//   - 空 table_row + 裸 table_header cell
//   - openStart/openEnd > 1 导致 pastedCells → fitSlice 用 openStart-1 > 0 调用,
//     把 cell content 包进多余层级,破坏表格结构
function hasValidTableStructure(slice: Slice): boolean {
  if (slice.content.childCount === 0) return false
  if (slice.openStart > 1 || slice.openEnd > 1) return false
  for (let i = 0; i < slice.content.childCount; i++) {
    const child = slice.content.child(i)
    if (child.type.spec.tableRole !== 'row') return false
    if (!child.firstChild) return false // 空行 = 损坏
  }
  return true
}

// 检查 slice 中每行的首个 cell 类型是否与目标行匹配
// (table_header_row 需要 table_header,table_row 需要 table_cell)。
// 不匹配时返回 false,表示需要重建 slice。
function cellTypesMatchTarget(sel: CellSelection, slice: Slice): boolean {
  const info = getTargetRowInfo(sel)
  if (!info) return true // 无法确定,假设匹配
  const { table, rectTop } = info
  for (let i = 0; i < slice.content.childCount; i++) {
    const row = slice.content.child(i)
    if (row.type.spec.tableRole !== 'row') continue
    const targetIdx = rectTop + i
    if (targetIdx >= table.childCount) return true // 超出范围,clipCells 会裁剪
    const isHeader = table.child(targetIdx).type.name === 'table_header_row'
    const firstCell = row.firstChild
    // firstCell 为 null 说明行结构损坏,不应匹配(hasValidTableStructure 已过滤,
    // 此处防御性返回 false)
    if (!firstCell) return false
    const isHeaderCell = firstCell.type.name === 'table_header'
    if (isHeader !== isHeaderCell) return false
  }
  return true
}

// 把 TSV 文本(tab 分隔列、换行分隔行)重建为 table_row slice。
// 如果传入 CellSelection,按目标行类型选择 table_header / table_cell,
// 避免 table_cell 插入 table_header_row(只接受 table_header)导致 Fitter
// 破坏表格结构。
function buildTsvSlice(text: string, schema: Schema, sel: CellSelection | null): Slice {
  const lines = text.split(/\r?\n/)
  const info = sel ? getTargetRowInfo(sel) : null

  const rows = lines.map((line, i) => {
    const cellTexts = line.split('\t')
    const isHeader = info
      ? isTargetHeaderRow(info.table, info.rectTop, i)
      : false
    const cellType = isHeader ? schema.nodes.table_header : schema.nodes.table_cell
    const rowType = isHeader ? schema.nodes.table_header_row : schema.nodes.table_row
    const cells = cellTexts.map((ct) => {
      const t = ct.trim()
      const p = schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined)
      return cellType.create(null, p)
    })
    return rowType.create(null, cells)
  })
  return new Slice(Fragment.from(rows), 1, 1)
}

export function createTableCellInputGuardPlugin(): Plugin {
  return new Plugin({
    key: tableCellInputGuardKey,
    props: {
      handleDOMEvents: {
        // 主防线:handleDOMEvents 先于 PM 内置处理器运行。
        // 在 keydown 阶段 preventDefault → 跳过内置 keydown(含 forceFlush),
        // CellSelection 不会被覆盖,浏览器也不会派发 beforeinput/input。
        //
        // 剪贴板快捷键(Mod-c/v/x)不能 preventDefault,但 forceFlush 同样会
        // 销毁 CellSelection。在 forceFlush 前调 setCurSelection 让 domObserver
        // 认为 DOM 选区"没变",跳过 selection 同步,保住 CellSelection。
        keydown(view: EditorView, event: Event) {
          if (!(view.state.selection instanceof CellSelection)) return false
          const e = event as KeyboardEvent
          if (isTextInsertingKey(e)) {
            event.preventDefault()
            return true
          }
          if (isClipboardShortcut(e)) {
            // domObserver 是 PM 内部字段(TS 未导出类型),运行时稳定存在。
            // setCurSelection 把 currentSelection 同步到当前 DOM 选区,使随后的
            // forceFlush → flush 检测到 currentSelection.eq(sel) = true,跳过
            // readDOMChange → selectionFromDOM,CellSelection 不被覆盖。
            ;(view as unknown as { domObserver: { setCurSelection: () => void } }).domObserver.setCurSelection()
          }
          return false
        },
        // IME 防线:中文/日文 IME 的 keydown keyCode=229,forceFlush 不跑,
        // CellSelection 安全,但 beforeinput(insertCompositionText)仍会派发。
        // 此时 keydown 的 event.key 通常是 "Process"(length>1),不被 isTextInsertingKey
        // 拦截,需在 beforeinput 阶段补拦。
        beforeinput(view: EditorView, event: Event) {
          if (!(view.state.selection instanceof CellSelection)) return false
          const inputType = (event as InputEvent).inputType
          if (inputType && INSERT_TEXT_TYPES.has(inputType)) {
            event.preventDefault()
            return true
          }
          return false
        },
      },
      // 最终 fallback:不支持 beforeinput 的旧浏览器走 keypress → handleTextInput。
      // PM keypress handler 调 handleTextInput 后统一 preventDefault,无 desync。
      handleTextInput(view: EditorView) {
        return view.state.selection instanceof CellSelection
      },
      // CellSelection 复制时,默认 textBetween 把所有 cell 文本用 "\n\n" 连接,
      // 丢失行列结构。改为 tab 分隔列、换行分隔行,对齐 Excel / Google Sheets 粘贴格式。
      // 仅对 CellSelection 的 slice(openStart=1/openEnd=1 + 首子节点 tableRole='row')生效;
      // 其他选区返回 undefined 走 PM 默认 textBetween。
      clipboardTextSerializer: ((slice: Slice) => {
        const { content, openStart, openEnd } = slice
        if (openStart !== 1 || openEnd !== 1) return undefined as unknown as string
        const first = content.firstChild
        if (!first || first.type.spec.tableRole !== "row") return undefined as unknown as string
        const lines: string[] = []
        for (let i = 0; i < content.childCount; i++) {
          const row = content.child(i)
          const cells: string[] = []
          row.forEach((cell) => { cells.push(cell.textContent) })
          lines.push(cells.join("\t"))
        }
        return lines.join("\n")
      }) as (slice: Slice, view: EditorView) => string,
      // 表格 cell 内粘贴纯文本(text/plain 路径,无 text/html 时触发)时,
      // 把 tab 分隔的文本解析为表格行 slice,让 handlePaste 走 pastedCells 整块填充。
      // 没有这个 parser,markdownPastePlugin 会把 "A\nB\nC" 当 markdown 解析成段落,
      // pastedCells 返回 null → handlePaste 退化到单 cell fallback → 行列错乱。
      // markdownPastePlugin 已在表格内 return null 让路,此 parser 接管。
      clipboardTextParser: ((text: string, $context: ResolvedPos, _plain: boolean, view: EditorView) => {
        // 仅在表格 cell 内生效
        let inTable = false
        for (let d = $context.depth; d > 0; d--) {
          if ($context.node(d).type.spec.tableRole === "row") { inTable = true; break }
        }
        if (!inTable) return null

        const trimmed = text.trim()
        if (!trimmed) return null

        // 含 tab 或多行 → 表格格式(tab 分隔列,换行分隔行)
        // 纯单行无 tab → 不是表格数据,return null 让默认 fallback 处理
        if (!text.includes("\t") && !text.includes("\n")) return null

        // 按 CellSelection 目标行类型选 cell 类型:表头行用 table_header,
        // body 行用 table_cell。否则全用 table_cell 时,粘贴到 table_header_row
        // (只接受 table_header)的 cell 会让 Fitter 破坏表格结构。
        const sel = view.state.selection instanceof CellSelection
          ? view.state.selection
          : null
        return buildTsvSlice(text, view.state.schema, sel)
      }) as (this: Plugin, text: string, $context: ResolvedPos, plain: boolean, view: EditorView) => Slice,
      // handlePaste 拦截:HTML 路径粘贴时,DOMParser 用 table_cell 作为 context 解析 HTML,
      // 导致 <tr>/<td> 被当作无效内容剥离(表格 cell 不允许嵌套 table_row),
      // 产出段落而非表格行 → pastedCells 返回 null → tableEditing 的 handlePaste
      // 走 1×1 fallback 把所有内容塞进一个 cell → clipCells 重复填充 → 行列错乱。
      //
      // 本插件必须在 tableEditing 之前注册(EditorInner.vue),使 someProp 先试本 handler。
      // 检测到 slice 无表格结构(tableRole)时,从 clipboard event 读 text/plain,
      // 按 TSV 重建 table_row slice,再委托 tableEditing 的 handlePaste 做整块填充。
      handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
        // 不在表格内 → 不接管
        const sel = view.state.selection
        if (!(sel instanceof CellSelection)) return false

        // slice 已有表格结构(table_row/table_cell/table):
        //   - 结构有效且 cell 类型与目标行匹配 → 交给 tableEditing
        //   - 结构损坏(DOMParser 在 table_cell context 下解析 <tr> 产出空行/裸 cell)
        //     或 cell 类型不匹配 → 继续走重建路径
        const first = slice.content.firstChild
        if (first && first.type.spec.tableRole === 'table') return false
        if (first && first.type.spec.tableRole === 'row'
            && hasValidTableStructure(slice)
            && cellTypesMatchTarget(sel, slice)) return false

        // slice 无表格结构,或 cell 类型不匹配 → 从 clipboard text 重建
        const clipText = event?.clipboardData?.getData('text/plain') ?? ''
        if (!clipText.trim()) return false

        // 纯单行无 tab → 不是表格数据,交给 tableEditing fallback
        if (!clipText.includes('\t') && !clipText.includes('\n')) return false

        // 按目标行类型重建(table_header / table_cell)
        const fixedSlice = buildTsvSlice(clipText, view.state.schema, sel)
        return tableHandlePaste(view, event, fixedSlice)
      },
    },
  })
}

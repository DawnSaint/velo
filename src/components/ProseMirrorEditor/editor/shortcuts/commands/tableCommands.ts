// 表格操作命令 —— splice + replaceWith 整体表替换 + 光标定位补丁。
//
// 每个命令 splice(或 clone)一个 table_row / table_cell 到新表,然后用
// replaceWith(tablePos, tablePos + oldTableSize, newTable) 整体替换。
//
// 关键约束:
//   - replaceWith 的 `to` 必须 = `tablePos + oldTableSize`,不能用
//     `tablePos + oldTableSize - 1`。因为 range 的 end 是 exclusive 语义,
//     -1 后 slice 无法含入旧表 close token,Fitter 会创建伪表。
//   - 当旧表是 doc 最后一个顶级块 + 新表 > 旧表时,range end 越界,replaceWith
//     报 "Position X out of range"。这种情况在实际编辑器里几乎不存在(表后总有
//     schema 强制补的空 paragraph),但如果遇到,命令会直接失败,不产生伪表。
//   - 官方推荐用局部 step(insert/delete/setNodeMarkup),但我们的 splice 写法在
//     「表后有段落」这一常规场景工作正常,且代码比 step-by-step 更紧凑。
//
// 光标定位补丁:
//   splice 后新表已替换旧表,PM selection 默认会映射到新 doc 的同相对位置,但在多种
//   常见场景(新增行/删列)下会漂到表外(用户 bug 1、3)。
//   我们用 tmpDoc = doc(null, [newTable]) 在新表段落上解析目标 cell 的绝对 pos,
//   设 selection 到 tmpDoc 中的对应位置,然后 apply replaceWith — PM 的 mapping 会把
//   该位置正确映射到真实 doc。

import type { Node as PMNode, Schema } from "prosemirror-model"
import type { EditorState } from "prosemirror-state"
import type { ShortcutCommand } from "../registry"
import { CellSelection, TableMap, goToNextCell, isInTable } from "prosemirror-tables"
import { TextSelection } from "prosemirror-state"

// 表格内矩形 { left, top, right, bottom }(left/top 含,right/bottom 不含)。
// 与 prosemirror-tables 的 Rect 同构,这里内联定义避免类型导出问题。
interface TableRect { left: number; top: number; right: number; bottom: number }

export type Alignment = "left" | "center" | "right"

const HEADER_ROW = "table_header_row"
const BODY_ROW = "table_row"
const HEADER_CELL = "table_header"
const BODY_CELL = "table_cell"
const TABLE = "table"

// 计算 CellSelection 矩形覆盖到的所有列 index(去重、升序)。
// 以右键点中的 cell 所在列为主列加入,并把矩形内其他列一并纳入,
// 达成「矩形内任意格右键 = 覆盖的所有列一起对齐」。
function columnsOfCellSelection(sel: CellSelection): number[] {
  const cols = new Set<number>()
  const table = sel.$anchorCell.node(-1)
  const tableStart = sel.$anchorCell.start(-1)
  const map = TableMap.get(table)
  sel.forEachCell((_cell: PMNode, pos: number) => {
    const cellRect = map.findCell(pos - tableStart)
    cols.add(cellRect.left)
  })
  return Array.from(cols).sort((a, b) => a - b)
}

// 取 CellSelection 覆盖的矩形 { left, top, right, bottom } (left/top 含, right/bottom 不含)。
// 行号 = table child 行号(0 = header 行);列号 = 列序号。
function rectOfCellSelection(sel: CellSelection) {
  const table = sel.$anchorCell.node(-1)
  const tableStart = sel.$anchorCell.start(-1)
  return TableMap.get(table).rectBetween(sel.$anchorCell.pos - tableStart, sel.$headCell.pos - tableStart)
}

// 构造一个 body 行table_row(含 N 个空 cell)——用于批量插行。
function createEmptyBodyRow(schema: Schema, numCols: number): PMNode {
  const cells = Array.from({ length: numCols }, () =>
    schema.nodes[BODY_CELL].create(null, schema.nodes.paragraph.create()))
  return schema.nodes[BODY_ROW].create(null, cells)
}

// 沿 $from 树向上找最近的 table 节点,返回 { table, pos }。
//
// pos 语义用「node 的 open token 之前的 gap position」(即 doc.descendants
// 报的位置),不是 $from.start(d)。实测在我们定制了 table 节点后,
// $from.start(d) 比 descendants 报的值大 1,用它做 replaceWith(from,to)
// 会切片错位,产生伪旧表@0 + 真新表@6 并列。因此这里显式 -1 对齐。
//
// 为什么不直接用 prosemirror-tables 的 findTable:
//   findTable 在 Velo 定制了 table 节点(isolate: true、强制 table_header_row
//   只含 table_header、table_row 只含 table_cell)后,会因为内部按列宽
//   (map.width) 偏移定位 cell 而返回错误引用,重蹈 replaceWith 切片错位
//   问题。改为纯手动沿 $from 向上,完全绕开 prosemirror-tables 的列宽探测。
function findTableWrapper($from: import("prosemirror-model").ResolvedPos): { table: PMNode; pos: number } | null {
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === TABLE) return { table: $from.node(d), pos: $from.start(d) - 1 }
  }
  return null
}

// 行索引,用 descendants 语义定位。
//   findTableWrapper 返回的 tablePos 是 descendants 语义(open token 前的 gap),
//   所以表内每一行的 descendants-pos = tablePos + 1 + offset(offset 来自 forEach)。
//   rowAbsStart = $from.start(d) 是 open-token 位置 = descendants-pos + 1。
//   因此匹配条件为 tablePos + 1 + offset === rowAbsStart - 1。
function rowIndexForSelection($from: import("prosemirror-model").ResolvedPos, table: PMNode, tablePos: number): number {
  let rowAbsStart = -1
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === BODY_ROW || $from.node(d).type.name === HEADER_ROW) {
      rowAbsStart = $from.start(d); break
    }
  }
  if (rowAbsStart < 0) return -1
  let found = -1, idx = 0
  table.forEach((_c, offset) => {
    if (tablePos + 1 + offset === rowAbsStart - 1) found = idx
    idx++
  })
  return found
}

// 注意: prosemirror Fragment.forEach 的回调签名是 (node, offset, index),
// 第三个参数才是 0-based child index,第二个参数 offset 是节点在父 fragment 内的位置偏移。
// 这里必须用第三个参数 index,不能用 offset。
function findColIndex($from: import("prosemirror-model").ResolvedPos): number {
  let cell = null, cellDepth = -1
  // 从 $from.depth(含最深节点)起向上找 cell。真实 anchorPos 来自 posAtDOM(cellDom,0)
  // = cell 的 content 起点(=descendants pos + 1),此时最深节点即为 cell。
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d)
    if (n.type.name === BODY_CELL || n.type.name === HEADER_CELL) { cell = n; cellDepth = d; break }
  }
  if (!cell) return -1
  const row = $from.node(cellDepth - 1)
  if (!row) return -1
  let idx = 0
  row.forEach((c, _offset, i) => { if (c === cell) idx = i })
  return idx
}

function countCells(row: PMNode): number { let n = 0; row.forEach(() => n++); return n }

function createCell(schema: Schema, rowType: string): PMNode {
  return rowType === HEADER_ROW
    ? schema.nodes[HEADER_CELL].create(null, schema.nodes.paragraph.create())
    : schema.nodes[BODY_CELL].create(null, schema.nodes.paragraph.create())
}

function cloneRowSchema(schema: Schema, row: PMNode): PMNode {
  const cells: PMNode[] = []
  row.forEach(() => cells.push(createCell(schema, row.type.name)))
  return row.type.create(null, cells)
}

function tableChildren(table: PMNode): PMNode[] {
  const out: PMNode[] = []
  table.forEach((c) => out.push(c))
  return out
}

// 新表内 (rowIdx, clamp(colIdx)) cell 的 paragraph content start 在新表 content 内的偏移。
function cellOffsetInNewTableContent(newTable: PMNode, rowIdx: number, colIdx: number): number {
  let rowOffset = 0
  for (let i = 0; i < rowIdx && i < newTable.childCount; i++) rowOffset += newTable.child(i).nodeSize
  const row = newTable.child(rowIdx)
  if (!row) return rowOffset
  const cellCount = row.childCount
  const safeCol = Math.max(0, Math.min(colIdx, cellCount - 1))
  let cellOffset = 0
  for (let i = 0; i < safeCol; i++) cellOffset += row.child(i).nodeSize
  return rowOffset + 1 + cellOffset + 1
}

// 构建在「已换入新表」的 doc 内,(tablePos, rowIdx, clamp(colIdx)) cell 的 paragraph content start 位置的 TextSelection。
//
// 为什么不能像之前那样先在新表外挂一个 tmpDoc,设 selection 后让 PM mapping 映射:
//   PM 的 setSelection 会检查 `selection.$from.doc == this.doc`(Transaction.doc),
//   若不一致会报 "Selection passed to setSelection must point at the current document"。
//   setSelection 之后不会再做 mapping,所以「先在新表外挂 tmpDoc,apply replaceWith 时让 mapping
//   映射」这条路根本走不通 — setSelection 立即校验 doc 引用同一性,映射永远不会发生。
// === Commands ===

// 封装:dispatch replaceWith 后在新 doc 内重新定位光标的通用流程。
function dispatchReplaceWithCursor(
  state: import("prosemirror-state").EditorState,
  dispatch: (tr: import("prosemirror-state").Transaction) => void,
  tablePos: number,
  oldTableSize: number,
  newTable: PMNode,
  offsetInContent: number,
) {
  const tr = state.tr.replaceWith(tablePos, tablePos + oldTableSize, newTable)
  const newDoc = tr.doc
  const cursorAbs = tablePos + offsetInContent + 1
  const clamped = Math.max(1, Math.min(Math.trunc(cursorAbs), newDoc.content.size - 1))
  dispatch(tr.setSelection(TextSelection.near(newDoc.resolve(clamped))).scrollIntoView())
}

// 新表中 (rowIdx,colIdx) cell 在外部 doc 的 descendants pos(open token 前的 gap position)。
// 算法:tablePos(= table descendants pos)+ table open token(1)+ 前序所有行 nodeSize 之和
//   + row open token(1)+ 前序所有 cell nodeSize 之和。与 rowIndexForSelection 同语义。
function cellOpenGapAbs(newTable: PMNode, tablePos: number, rowIdx: number, colIdx: number): number {
  let rel = 0
  for (let i = 0; i < rowIdx && i < newTable.childCount; i++) rel += newTable.child(i).nodeSize
  const row = newTable.child(rowIdx)
  const safeCol = row ? Math.max(0, Math.min(colIdx, row.childCount - 1)) : 0
  for (let i = 0; i < safeCol; i++) rel += row.child(i).nodeSize
  return tablePos + rel + 2
}

// 移动专用 dispatch:replaceWith 整表后,在新 doc 重建 CellSelection,覆盖「移动后块」。
//   行块原 [top,bottom) 移动方向 ±1 → 新 [top+d,bottom+d);anchor 取块首格(newTop,newLeft),
//   head 取块末格(newBottom-1,newRight-1)。列块对称:newLeft/newRight,newTop/newBottom 不变。
function dispatchReplaceKeepingCellSelection(
  state: import("prosemirror-state").EditorState,
  dispatch: (tr: import("prosemirror-state").Transaction) => void,
  tablePos: number,
  oldTableSize: number,
  newTable: PMNode,
  // 移动后块的新矩形(含/不含边界同 rect 语义)。
  newTop: number,
  newBottom: number,
  newLeft: number,
  newRight: number,
) {
  const tr = state.tr.replaceWith(tablePos, tablePos + oldTableSize, newTable)
  const newDoc = tr.doc
  const anchorAbs = cellOpenGapAbs(newTable, tablePos, newTop, newLeft)
  const headAbs = cellOpenGapAbs(newTable, tablePos, Math.max(0, newBottom - 1), Math.max(0, newRight - 1))
  const anchor = newDoc.resolve(Math.max(1, Math.min(anchorAbs, newDoc.content.size - 1)))
  const head = newDoc.resolve(Math.max(1, Math.min(headAbs, newDoc.content.size - 1)))
  dispatch(tr.setSelection(new CellSelection(anchor, head)).scrollIntoView())
}

// 由 anchorPos(右键点中的 cell descendants pos)解析出 $from。
// anchorPos 为空 → 退到 selection.$from(兼容非菜单触发场景)。
function resolveAnchor(state: import("prosemirror-state").EditorState, anchorPos?: number) {
  return anchorPos != null ? state.doc.resolve(anchorPos) : state.selection.$from
}

// 所有表格命令统一签名:cmd(schema, anchorPos?) => ShortcutCommand。
// anchorPos = 右键点中 cell 的 descendants pos(与 doc.descendants 同语义);
// 为空 → 退到 selection.$from(兼容快捷键 / 测试等无锚点触发)。
// 此签名让 bindings.ts / 现有测试调用 cmdAddRowAfter(schema) 完全不变。

export function cmdAddRowAfter(schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    // 矩形内右键:在最下面那格的下方插 1 行(锚定矩形下边界 rect.bottom)。
    if (anchorPos != null && sel instanceof CellSelection) {
      const rect = rectOfCellSelection(sel)
      const table = sel.$anchorCell.node(-1)
      const tableStart = sel.$anchorCell.start(-1)
      const tablePos = tableStart - 1
      const baseRowIndex = Math.max(rect.bottom - 1, 1) // 以底边界上一行宽度为基准(>=1 保 body)
      const numCols = table.child(baseRowIndex).childCount
      const children = tableChildren(table)
      children.splice(rect.bottom, 0, createEmptyBodyRow(schema, numCols))
      const newTable = schema.nodes[TABLE].create(table.attrs, children)
      if (dispatch) {
        const offsetInContent = cellOffsetInNewTableContent(newTable, rect.bottom, rect.left)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
      return true
    }
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection($from, table, tablePos)
    if (rowIdx < 0) return false
    const children = tableChildren(table)
    // header 行(rowIdx === 0):下方插行 = 在 header 后(index 1)插 1 个空 body 行。
    if (rowIdx === 0 && table.child(0).type.name === HEADER_ROW) {
      const numCols = table.child(0).childCount
      children.splice(1, 0, createEmptyBodyRow(schema, numCols))
    } else {
      const newRow = cloneRowSchema(schema, table.child(rowIdx))
      children.splice(rowIdx + 1, 0, newRow)
    }
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const cursorRow = rowIdx === 0 ? 1 : rowIdx + 1
      const offsetInContent = cellOffsetInNewTableContent(newTable, cursorRow, 0)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdAddRowBefore(schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    // 矩形内右键:在最上面那格的上方插 1 行(锚定矩形上边界 rect.top)。
    // 特殊:矩形触及 header(rect.top === 0)时,新行应为 header 行,旧 header 降级为 body 行。
    if (anchorPos != null && sel instanceof CellSelection) {
      const rect = rectOfCellSelection(sel)
      const table = sel.$anchorCell.node(-1)
      const tableStart = sel.$anchorCell.start(-1)
      const tablePos = tableStart - 1
      const numCols = table.child(0).childCount
      const children = tableChildren(table)
      if (rect.top === 0) {
        // 在 index 0 插入新 header 行,并把旧 header(row 0)降级为 body 行。
        const oldHeader = children[0]
        const newHeaderCells = Array.from({ length: numCols }, () =>
          schema.nodes[HEADER_CELL].create(null, schema.nodes.paragraph.create()))
        const newHeader = schema.nodes[HEADER_ROW].create(null, newHeaderCells)
        // 旧 header cells 由 table_header → table_cell(保 content),body 行数据保留。
        const demotedBodyCells = tableChildren(oldHeader).map((cell) =>
          schema.nodes[BODY_CELL].create(cell.attrs, cell.content))
        const demotedBody = schema.nodes[BODY_ROW].create(oldHeader.attrs, demotedBodyCells)
        children.splice(0, 1, newHeader, demotedBody)
      } else {
        const baseRowIndex = rect.top
        const widthCols = table.child(baseRowIndex).childCount
        children.splice(rect.top, 0, createEmptyBodyRow(schema, widthCols))
      }
      const newTable = schema.nodes[TABLE].create(table.attrs, children)
      if (dispatch) {
        const cursorRow = rect.top === 0 ? 0 : rect.top
        const offsetInContent = cellOffsetInNewTableContent(newTable, cursorRow, rect.left)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
      return true
    }
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection($from, table, tablePos)
    if (rowIdx < 0) return false
    const children = tableChildren(table)
    // header 行(rowIdx === 0):上方插行 = 新 header + 旧 header 降级为 body 行。
    if (rowIdx === 0 && table.child(0).type.name === HEADER_ROW) {
      const oldHeader = children[0]
      const numCols = oldHeader.childCount
      const newHeaderCells = Array.from({ length: numCols }, () =>
        schema.nodes[HEADER_CELL].create(null, schema.nodes.paragraph.create()))
      const newHeader = schema.nodes[HEADER_ROW].create(null, newHeaderCells)
      const demotedBodyCells = tableChildren(oldHeader).map((cell) =>
        schema.nodes[BODY_CELL].create(cell.attrs, cell.content))
      const demotedBody = schema.nodes[BODY_ROW].create(oldHeader.attrs, demotedBodyCells)
      children.splice(0, 1, newHeader, demotedBody)
    } else {
      const newRow = cloneRowSchema(schema, table.child(rowIdx))
      children.splice(rowIdx, 0, newRow)
    }
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const cursorRow = rowIdx === 0 ? 0 : rowIdx
      const offsetInContent = cellOffsetInNewTableContent(newTable, cursorRow, 0)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdDeleteRow(_schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    // 矩形内右键:删掉矩形覆盖到的所有 body 行;若全删 → 删整张表。
    if (anchorPos != null && sel instanceof CellSelection) {
      const rect = rectOfCellSelection(sel)
      const table = sel.$anchorCell.node(-1)
      const tableStart = sel.$anchorCell.start(-1)
      const tablePos = tableStart - 1
      const children = tableChildren(table)
      let bodyCount = 0
      children.forEach((c) => { if (c.type.name === BODY_ROW) bodyCount++ })
      // 要删的行号 = [max(rect.top,1), rect.bottom) 中实际存在的(跳过 header=0)。
      const removeFrom = Math.max(rect.top, 1)
      const removedBodyRows = Math.max(0, Math.min(rect.bottom, children.length) - removeFrom)
      if (removedBodyRows <= 0) return false
      // 矩形同时覆盖 header(rect.top === 0)且向下覆盖到底 → 全表拖蓝,直接删整张表。
      if (rect.top === 0 && rect.bottom >= children.length) {
        if (dispatch) dispatch(state.tr.delete(tablePos, tablePos + table.nodeSize - 1))
        return true
      }
      const removeIdx = new Set<number>()
      for (let i = removeFrom; i < Math.min(rect.bottom, children.length); i++) removeIdx.add(i)
      // schema 允许 0 body 行(table_row*),矩形可删光所有 body 行仅留 header。
      const newChildren = children.filter((_, i) => !removeIdx.has(i))
      const newTable = state.schema.nodes[TABLE].create(table.attrs, newChildren)
      if (dispatch) {
        // 光标 clamp 到最后一个有效行(兼容删光 body 行后 childCount=1 仅 header 的情况)。
        const newRowIdx = Math.max(0, Math.min(removeFrom, newTable.childCount - 1))
        const offsetInContent = cellOffsetInNewTableContent(newTable, newRowIdx, Math.min(rect.left, newTable.child(0).childCount - 1))
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
      return true
    }
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection($from, table, tablePos)
    if (rowIdx < 0 || table.child(rowIdx).type.name !== BODY_ROW) return false
    // schema 允许 0 body 行(table_row*);仅删该行,保留 header(即便只剩 1 body 行)。
    const children = tableChildren(table)
    children.splice(rowIdx, 1)
    const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const newRowIdx = Math.max(0, Math.min(rowIdx, newTable.childCount - 1))
      const offsetInContent = cellOffsetInNewTableContent(newTable, newRowIdx, 0)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdDeleteTable(_schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    if (dispatch) dispatch(state.tr.delete(info.pos, info.pos + info.table.nodeSize - 1))
    return true
  }
}

export function cmdAddColumnAfter(schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    // 矩形内右键:在最右边那格的右边插 1 列(锚定矩形右边界 rect.right)。
    if (anchorPos != null && sel instanceof CellSelection) {
      const rect = rectOfCellSelection(sel)
      const table = sel.$anchorCell.node(-1)
      const tableStart = sel.$anchorCell.start(-1)
      const tablePos = tableStart - 1
      const colIdx = rect.right // 右边界(不含)即插入位置
      const children: PMNode[] = []
      table.forEach((row) => {
        const cells = tableChildren(row)
        cells.splice(colIdx, 0, createCell(schema, row.type.name))
        children.push(row.type.create(row.attrs, cells))
      })
      const newTable = schema.nodes[TABLE].create(table.attrs, children)
      if (dispatch) {
        const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(rect.top, 1), colIdx)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
      return true
    }
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const colIdx = findColIndex($from)
    if (colIdx < 0) return false
    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => { cells.push(cell); if (i === colIdx) cells.push(createCell(schema, row.type.name)) })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection($from, table, tablePos)
      const cursorRow = rowIdx === 0 ? 0 : Math.max(1, rowIdx)
      const offsetInContent = cellOffsetInNewTableContent(newTable, cursorRow, colIdx + 1)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdAddColumnBefore(schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    // 矩形内右键:在最左边那格的左边插 1 列(锚定矩形左边界 rect.left)。
    if (anchorPos != null && sel instanceof CellSelection) {
      const rect = rectOfCellSelection(sel)
      const table = sel.$anchorCell.node(-1)
      const tableStart = sel.$anchorCell.start(-1)
      const tablePos = tableStart - 1
      const colIdx = rect.left // 左边界(含)即插入位置
      const children: PMNode[] = []
      table.forEach((row) => {
        const cells = tableChildren(row)
        cells.splice(colIdx, 0, createCell(schema, row.type.name))
        children.push(row.type.create(row.attrs, cells))
      })
      const newTable = schema.nodes[TABLE].create(table.attrs, children)
      if (dispatch) {
        const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(rect.top, 1), colIdx)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
      return true
    }
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const colIdx = findColIndex($from)
    if (colIdx < 0) return false
    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => { if (i === colIdx) cells.push(createCell(schema, row.type.name)); cells.push(cell) })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection($from, table, tablePos)
      const cursorRow = rowIdx === 0 ? 0 : Math.max(1, rowIdx)
      const offsetInContent = cellOffsetInNewTableContent(newTable, cursorRow, colIdx)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdDeleteColumn(schema: Schema, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    // 矩形内右键:删掉矩形覆盖到的所有列;保底留 1 列。
    if (anchorPos != null && sel instanceof CellSelection) {
      const rect = rectOfCellSelection(sel)
      const table = sel.$anchorCell.node(-1)
      const tableStart = sel.$anchorCell.start(-1)
      const tablePos = tableStart - 1
      const numCols = table.child(0).childCount
      const removeFrom = rect.left
      const removeTo = Math.min(rect.right, numCols)
      const removedCols = removeTo - removeFrom
      if (removedCols <= 0) return false
      // 矩形覆盖全部列 → 删整张表(无列表格无意义);否则删覆盖列并保底留 1 列。
      if (numCols - removedCols < 1) {
        if (dispatch) dispatch(state.tr.delete(tablePos, tablePos + table.nodeSize - 1))
        return true
      }
      const removeIdx = new Set<number>()
      for (let i = removeFrom; i < removeTo; i++) removeIdx.add(i)
      const children: PMNode[] = []
      table.forEach((row) => {
        const cells = tableChildren(row).filter((_, i) => !removeIdx.has(i))
        children.push(row.type.create(row.attrs, cells))
      })
      const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
      if (dispatch) {
        const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(rect.top, 1), removeFrom)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
      return true
    }
    const $from = resolveAnchor(state, anchorPos)
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const colIdx = findColIndex($from)
    if (colIdx < 0) return false
    // 仅 1 列(最后一列)→ 删整张表。
    if (countCells(table.child(0)) <= 1) {
      if (dispatch) dispatch(state.tr.delete(tablePos, tablePos + table.nodeSize - 1))
      return true
    }
    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => { if (i !== colIdx) cells.push(cell) })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection($from, table, tablePos)
      const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(1, rowIdx), colIdx)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function insertTable2x2(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const $from = state.selection.$from
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === TABLE) return false
    if (!dispatch) return true
    const h = [schema.nodes[HEADER_CELL].create(null, schema.nodes.paragraph.create()), schema.nodes[HEADER_CELL].create(null, schema.nodes.paragraph.create())]
    const b = [schema.nodes[BODY_CELL].create(null, schema.nodes.paragraph.create()), schema.nodes[BODY_CELL].create(null, schema.nodes.paragraph.create())]
    const table = schema.nodes[TABLE].create(null, [schema.nodes[HEADER_ROW].create(null, h), schema.nodes[BODY_ROW].create(null, b)])
    let tr = state.tr.replaceSelectionWith(table)
    let tablePos = -1
    tr.doc.descendants((node, pos) => { if (node.type.name === TABLE && tablePos === -1) tablePos = pos; return true })
    if (tablePos < 0) return false
    tr = tr.setSelection(TextSelection.create(tr.doc, tablePos + 4))
    tr = tr.scrollIntoView()
    dispatch(tr)
    return true
  }
}

// 列级对齐。若 anchorPos 存在且为 CellSelection → 把矩形覆盖到的所有列一起对齐;
// 否则把 anchor(或其所在 $from)的列对齐。两种路径都走整表 replaceWith,保 round-trip。
// anchorPos 语义 = 右键点中 cell 的 descendants pos(与 doc.descendants 同语义)。
export function setCellAlignment(alignment: Alignment, anchorPos?: number): ShortcutCommand {
  return (state, dispatch) => {
    const $from = anchorPos != null ? state.doc.resolve(anchorPos) : state.selection.$from
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info

    // 决定要改哪些列:CellSelection 覆盖的所有列,否则只看锚点所在列。
    let targetCols: number[]
    const sel = state.selection
    if (anchorPos != null && sel instanceof CellSelection) {
      targetCols = columnsOfCellSelection(sel)
    } else {
      const colIdx = findColIndex($from)
      if (colIdx < 0) return false
      targetCols = [colIdx]
    }
    if (targetCols.length === 0) return false

    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => {
        // 目标列一起改 alignment,非目标列原样复用(保持 content + 其他 attrs)。
        cells.push(
          targetCols.includes(i)
            ? cell.type.create({ ...cell.attrs, alignment }, cell.content)
            : cell,
        )
      })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection($from, table, tablePos)
      const offsetCol = targetCols[0]
      const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(0, rowIdx), offsetCol)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

// 获取移动操作的矩形和表信息。支持 CellSelection(矩形拖蓝)和 TextSelection-in-cell(单格光标)。
// TextSelection 时构造单 cell 矩形 { left:col, top:row, right:col+1, bottom:row+1 }。
function getMoveRect(state: EditorState): { rect: TableRect; table: PMNode; tablePos: number } | null {
  const sel = state.selection
  if (sel instanceof CellSelection) {
    const table = sel.$anchorCell.node(-1)
    const tablePos = sel.$anchorCell.start(-1) - 1
    return { rect: rectOfCellSelection(sel), table, tablePos }
  }
  // TextSelection in cell
  const $from = sel.$from
  if (!isInTableCell($from)) return null
  const info = findTableWrapper($from)
  if (!info) return null
  const { table, pos: tablePos } = info
  const rowIdx = rowIndexForSelection($from, table, tablePos)
  const colIdx = findColIndex($from)
  if (rowIdx < 0 || colIdx < 0) return null
  return {
    rect: { left: colIdx, top: rowIdx, right: colIdx + 1, bottom: rowIdx + 1 },
    table, tablePos,
  }
}

// 移动行:direction = -1 上移, +1 下移。
//
// 支持 CellSelection(矩形拖蓝整块移动)和 TextSelection-in-cell(单行移动)。
// 矩形覆盖的所有行 [rect.top,rect.bottom) 当作一个整块,与相邻行做块 swap:
//   - 上移:抽出 rect.top-1 那行(邻居),插到块尾之后 → 块整体上移一位。
//   - 下移:抽出 rect.bottom 那行(邻居),插到块头之前 → 块整体下移一位。
// 边界整块 noop(false):块触 header(rect.top < 1);上移时邻居 rect.top-1 < 1;
// 下移时邻居 rect.bottom 不存在(>= children.length)。
export function cmdMoveRow(direction: number): ShortcutCommand {
  return (state, dispatch) => {
    const wasCellSel = state.selection instanceof CellSelection
    const moveInfo = getMoveRect(state)
    if (!moveInfo) return false
    const { rect, table, tablePos } = moveInfo
    const top = rect.top, bottom = rect.bottom
    // 矩形必须落在 body 区内(rect.top >= 1),否则 noop。
    if (top < 1) return false
    const children = tableChildren(table)
    if (direction === -1) {
      // 上移:邻居 = top-1,要求 >= 1(不可越过 header)。
      if (top - 1 < 1) return false
      const [neighbor] = children.splice(top - 1, 1)
      children.splice(bottom - 1, 0, neighbor)
    } else {
      // 下移:邻居 = bottom,要求 < children.length(不可越过末行)。
      if (bottom >= children.length) return false
      const [neighbor] = children.splice(bottom, 1)
      children.splice(top, 0, neighbor)
    }
    const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const newTop = top + direction
      if (wasCellSel) {
        // CellSelection → 移动后保持 CellSelection 覆盖移动后的块。
        dispatchReplaceKeepingCellSelection(state, dispatch, tablePos, table.nodeSize, newTable, newTop, bottom + direction, rect.left, rect.right)
      } else {
        // TextSelection → 移动后恢复光标到移动后的行同列。
        const offsetInContent = cellOffsetInNewTableContent(newTable, newTop, rect.left)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
    }
    return true
  }
}

// 移动列:direction = -1 左移, +1 右移。
//
// 支持 CellSelection(矩形拖蓝整块移动)和 TextSelection-in-cell(单列移动)。
// 矩形覆盖的所有列 [rect.left,rect.right) 当作一个整块,在每一行内与相邻列做块 splice:
//   - 左移:抽出 rect.left-1 那列(邻居),插到 block 尾之后。
//   - 右移:抽出 rect.right 那列(邻居),插到 block 头之前。
// 边界 noop:rect.left <= 0 不可左;rect.right >= numCols 不可右。
export function cmdMoveColumn(direction: number): ShortcutCommand {
  return (state, dispatch) => {
    const wasCellSel = state.selection instanceof CellSelection
    const moveInfo = getMoveRect(state)
    if (!moveInfo) return false
    const { rect, table, tablePos } = moveInfo
    const left = rect.left, right = rect.right
    const numCols = right - left
    // 矩形必须至少含 1 列;左移不可越过首列,右移不可越过末列。
    if (left < 0 || numCols < 1) return false
    const maxCol = table.child(0).childCount
    if (direction === -1) {
      if (left < 1) return false
    } else {
      if (right >= maxCol) return false
    }

    const newChildren: PMNode[] = []
    table.forEach((row) => {
      const cells = tableChildren(row)
      const swapped = swapColumns(cells, left, right, direction)
      if (!swapped) return false as never
      newChildren.push(row.type.create(row.attrs, swapped))
    })
    const newTable = state.schema.nodes[TABLE].create(table.attrs, newChildren)
    if (dispatch) {
      const newLeft = left + direction
      if (wasCellSel) {
        // CellSelection → 移动后保持 CellSelection 覆盖移动后的块。
        dispatchReplaceKeepingCellSelection(state, dispatch, tablePos, table.nodeSize, newTable, rect.top, rect.bottom, newLeft, right + direction)
      } else {
        // TextSelection → 移动后恢复光标到移动后的列同行。
        const offsetInContent = cellOffsetInNewTableContent(newTable, rect.top, newLeft)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
    }
    return true
  }
}

// 单步列交换:单列 rect 直接 swap 相邻两列;多列 rect 抽出相邻列、插到块另一端(块旋转保序)。
//   - 左移(-1):抽出 cells[left-1](左邻),插到 right-1(块尾)。
//   - 右移(+1):抽出 cells[right](右邻),插到 left(块头)。
function swapColumns(cells: PMNode[], left: number, right: number, direction: number): PMNode[] | false {
  if (right - left === 1) {
    // 单列:单步相邻 swap。
    const a = direction === -1 ? left - 1 : left
    const b = direction === -1 ? left : right
    if (a < 0 || b >= cells.length) return false
    const tmp = cells[a]; cells[a] = cells[b]; cells[b] = tmp
    return cells
  }
  // 多列块:抽出相邻列,插到块另一端。
  if (direction === -1) {
    const [neighbor] = cells.splice(left - 1, 1)
    cells.splice(right - 1, 0, neighbor)
  } else {
    const [neighbor] = cells.splice(right, 1)
    cells.splice(left, 0, neighbor)
  }
  return cells
}

// ============================================================
//  表格内 Enter / Shift+Enter
// ============================================================

// 判定 TextSelection 是否在 table cell 内(header/body 均可)。
function isInTableCell($from: import("prosemirror-model").ResolvedPos): boolean {
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === BODY_CELL || name === HEADER_CELL) return true
  }
  return false
}

// 表格内 Enter:光标在 cell 内(TextSelection.empty)时,跳到下一行同列 cell。
// 最后一行(header-only 表或 body 末行)→ 追加空 body 行再跳转(Typora 行为)。
// CellSelection 时由 tableCellInputGuard 已 preventDefault,不会进入此命令。
export function cmdTableCellEnter(): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    if (!(sel instanceof TextSelection) || !sel.empty) return false
    const { $from } = sel
    if (!isInTableCell($from)) return false

    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection($from, table, tablePos)
    const colIdx = findColIndex($from)
    if (rowIdx < 0 || colIdx < 0) return false

    // 有下一行 → 跳到下一行同列
    if (rowIdx + 1 < table.childCount) {
      if (dispatch) {
        const offsetInContent = cellOffsetInNewTableContent(table, rowIdx + 1, colIdx)
        const cursorAbs = tablePos + offsetInContent + 1
        const clamped = Math.max(1, Math.min(Math.trunc(cursorAbs), state.doc.content.size - 1))
        dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(clamped))).scrollIntoView())
      }
      return true
    }

    // 最后一行 → 追加空 body 行并跳转
    if (!dispatch) return true
    const numCols = table.child(rowIdx).childCount
    const newRow = createEmptyBodyRow(state.schema, numCols)
    const children = tableChildren(table)
    children.push(newRow)
    const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
    const newRowIdx = table.childCount
    const offsetInContent = cellOffsetInNewTableContent(newTable, newRowIdx, colIdx)
    dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    return true
  }
}

// 表格内 Shift+Enter:插入 hardbreak(<br>)实现 cell 内换行。
// 仅在 table cell 内生效;CellSelection 由 tableCellInputGuard 阻拦。
export function cmdTableCellHardBreak(): ShortcutCommand {
  return (state, dispatch) => {
    const sel = state.selection
    if (!(sel instanceof TextSelection)) return false
    if (!isInTableCell(sel.$from)) return false

    const hardBreakType = state.schema.nodes.hardbreak
    if (!hardBreakType) return false

    if (dispatch) {
      dispatch(state.tr.replaceSelectionWith(hardBreakType.create()).scrollIntoView())
    }
    return true
  }
}

// ============================================================
//  表格内 Tab / Shift+Tab(cell 导航)
// ============================================================

// 表格内 Tab(direction=1)/Shift+Tab(direction=-1):在 cell 间导航。
//   - 调 prosemirror-tables 的 goToNextCell(行优先遍历,到末行折回首列下一行)。
//   - Tab 到表格最后一个 cell → 追加空 body 行并跳到新行同列(Excel/Typora 行为)。
//   - Shift+Tab 到第一个 cell → 消费事件但不做事(不在 header 前面新增行)。
//   - 不在表格内 → return false(让 tabIndent 的列表/代码/段落逻辑接管)。
//   - CellSelection 也支持:goToNextCell 内部用 selectionCell 兼容 CellSelection。
export function cmdTableTab(direction: 1 | -1): ShortcutCommand {
  return (state, dispatch) => {
    if (!isInTable(state)) return false
    // 先试 goToNextCell(支持 TextSelection 和 CellSelection)
    if (goToNextCell(direction)(state, dispatch)) return true

    // goToNextCell 返回 false = 在末尾(Tab)或开头(Shift-Tab)
    if (direction === -1) {
      // Shift+Tab 在第一个 cell → 消费但不做事
      return true
    }

    // Tab 在最后一个 cell → 追加空 body 行并跳到新行同列
    if (!dispatch) return true
    const $from = state.selection.$from
    const info = findTableWrapper($from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection($from, table, tablePos)
    const colIdx = findColIndex($from)
    if (rowIdx < 0 || colIdx < 0) return false

    const numCols = table.child(rowIdx).childCount
    const newRow = createEmptyBodyRow(state.schema, numCols)
    const children = tableChildren(table)
    children.push(newRow)
    const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
    const newRowIdx = table.childCount
    const offsetInContent = cellOffsetInNewTableContent(newTable, newRowIdx, colIdx)
    dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    return true
  }
}

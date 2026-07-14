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
import type { ShortcutCommand } from "../registry"
import { CellSelection, TableMap } from "prosemirror-tables"
import { TextSelection } from "prosemirror-state"

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
      const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(1, rowIdx), colIdx + 1)
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
      const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(1, rowIdx), colIdx)
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

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
import { TextSelection } from "prosemirror-state"

export type Alignment = "left" | "center" | "right"

const HEADER_ROW = "table_header_row"
const BODY_ROW = "table_row"
const HEADER_CELL = "table_header"
const BODY_CELL = "table_cell"
const TABLE = "table"

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
  for (let d = $from.depth - 1; d > 0; d--) {
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

export function cmdAddRowAfter(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection(state.selection.$from, table, tablePos)
    if (rowIdx < 0 || table.child(rowIdx).type.name !== BODY_ROW) return false
    const newRow = cloneRowSchema(schema, table.child(rowIdx))
    const children = tableChildren(table)
    children.splice(rowIdx + 1, 0, newRow)
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const offsetInContent = cellOffsetInNewTableContent(newTable, rowIdx + 1, 0)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdAddRowBefore(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection(state.selection.$from, table, tablePos)
    if (rowIdx < 0 || table.child(rowIdx).type.name !== BODY_ROW) return false
    const newRow = cloneRowSchema(schema, table.child(rowIdx))
    const children = tableChildren(table)
    children.splice(rowIdx, 0, newRow)
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const offsetInContent = cellOffsetInNewTableContent(newTable, rowIdx, 0)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdDeleteRow(_schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const rowIdx = rowIndexForSelection(state.selection.$from, table, tablePos)
    if (rowIdx < 0 || table.child(rowIdx).type.name !== BODY_ROW) return false
    let bodyCount = 0
    table.forEach((c) => { if (c.type.name === BODY_ROW) bodyCount++ })
    if (bodyCount <= 1) {
      if (dispatch) dispatch(state.tr.delete(tablePos, tablePos + table.nodeSize - 1))
    } else {
      const children = tableChildren(table)
      children.splice(rowIdx, 1)
      const newTable = state.schema.nodes[TABLE].create(table.attrs, children)
      if (dispatch) {
        // 光标落点:被删行的位置由后续行上移填补。
        //   rowIdx 是被删 body 在旧表里的 index(0-based,从 0 起,0=header)= 旧表视角。
        //   删后,新表里同一「逻辑行」位置 = clamp(rowIdx, 1, newTable.childCount - 1);
        //   - 删中间行:rowIdx 不变,下一行上移填补 → 光标落在原下一行(同列感)
        //   - 删最后一行:rowIdx > 最后 body index → 回落到上一行
        //   - 原 bodyCount=2 删到 1:clamp 到 1 = 唯一剩余的 body
        //   newTable.childCount - 1 = 最后一个 body 的 index。
        const newRowIdx = Math.min(rowIdx, newTable.childCount - 1)
        const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(1, newRowIdx), 0)
        dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
      }
    }
    return true
  }
}

export function cmdDeleteTable(_schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    if (dispatch) dispatch(state.tr.delete(info.pos, info.pos + info.table.nodeSize - 1))
    return true
  }
}

export function cmdAddColumnAfter(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const colIdx = findColIndex(state.selection.$from)
    if (colIdx < 0) return false
    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => { cells.push(cell); if (i === colIdx) cells.push(createCell(schema, row.type.name)) })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection(state.selection.$from, table, tablePos)
      const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(1, rowIdx), colIdx + 1)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdAddColumnBefore(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const colIdx = findColIndex(state.selection.$from)
    if (colIdx < 0) return false
    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => { if (i === colIdx) cells.push(createCell(schema, row.type.name)); cells.push(cell) })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection(state.selection.$from, table, tablePos)
      const offsetInContent = cellOffsetInNewTableContent(newTable, Math.max(1, rowIdx), colIdx)
      dispatchReplaceWithCursor(state, dispatch, tablePos, table.nodeSize, newTable, offsetInContent)
    }
    return true
  }
}

export function cmdDeleteColumn(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const info = findTableWrapper(state.selection.$from)
    if (!info) return false
    const { table, pos: tablePos } = info
    const colIdx = findColIndex(state.selection.$from)
    if (colIdx < 0 || countCells(table.child(0)) <= 1) return false
    const children: PMNode[] = []
    table.forEach((row) => {
      const cells: PMNode[] = []
      row.forEach((cell, _offset, i) => { if (i !== colIdx) cells.push(cell) })
      children.push(row.type.create(row.attrs, cells))
    })
    const newTable = schema.nodes[TABLE].create(table.attrs, children)
    if (dispatch) {
      const rowIdx = rowIndexForSelection(state.selection.$from, table, tablePos)
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

export function setCellAlignment(alignment: Alignment): ShortcutCommand {
  return (state, dispatch) => {
    const $from = state.selection.$from
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d)
      if (node.type.name === BODY_CELL || node.type.name === HEADER_CELL) {
        const cellPos = $from.before(d)
        const tr = state.tr.setNodeMarkup(cellPos, null, { ...node.attrs, alignment })
        if (dispatch) dispatch(tr)
        return true
      }
    }
    return false
  }
}

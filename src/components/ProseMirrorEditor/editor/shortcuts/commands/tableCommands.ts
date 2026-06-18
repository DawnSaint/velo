// 表格插入命令 —— 2x2 表格(1 header row + 1 body row,各 2 cell)。
//
// 关键行为:
// - 在 table 节点内 noop(让 keymap 不消费,baseKeymap 接管)—— 避免在表里
//   按 Mod-t 又插一个表,Obsidian 行为也是 noop
// - 光标显式进第一个 cell 的 paragraph content start ——
//   `replaceSelectionWith(table)` 默认光标停在 table open 节点边界,需要
//   setSelection 到 firstCellPos = tablePos + 4
//   (table open +1 / header_row open +1 / first cell open +1 / paragraph open +1)
// - scrollIntoView —— 插入在屏外时让用户看到表

import { TextSelection } from 'prosemirror-state'
import type { Schema } from 'prosemirror-model'
import type { ShortcutCommand } from '../registry'

export function insertTable2x2(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const $from = state.selection.$from

    // 表格内 noop
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'table') return false
    }

    const tableType = schema.nodes.table
    const headerRowType = schema.nodes.table_header_row
    const rowType = schema.nodes.table_row
    const headerType = schema.nodes.table_header
    const cellType = schema.nodes.table_cell
    if (!tableType || !headerRowType || !rowType || !headerType || !cellType) {
      return false
    }

    if (!dispatch) return true

    const headerCells = [
      headerType.create(null, schema.nodes.paragraph.create()),
      headerType.create(null, schema.nodes.paragraph.create()),
    ]
    const bodyCells = [
      cellType.create(null, schema.nodes.paragraph.create()),
      cellType.create(null, schema.nodes.paragraph.create()),
    ]
    const table = tableType.create(null, [
      headerRowType.create(null, headerCells),
      rowType.create(null, bodyCells),
    ])

    let tr = state.tr.replaceSelectionWith(table)

    // 找新 table 位置,光标定位到第一个 cell 的 paragraph content start
    let tablePos = -1
    tr.doc.descendants((node, pos) => {
      if (node.type.name === 'table' && tablePos === -1) {
        tablePos = pos
        return false
      }
      return true
    })
    if (tablePos < 0) return false
    // table open (+1) → header_row open (+1) → first header_cell open (+1)
    //   → paragraph open (+1) → content start
    const firstCellCursor = tablePos + 4

    tr = tr.setSelection(TextSelection.create(tr.doc, firstCellCursor))
    tr = tr.scrollIntoView()
    dispatch(tr)
    return true
  }
}
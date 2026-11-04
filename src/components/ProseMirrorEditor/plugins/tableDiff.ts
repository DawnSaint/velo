// 表格结构化 diff —— WYSIWYG diff 的 table 专用装饰(#diff-wysiwyg)
//
// 问题背景:Block Tree Diff 把整张表当作**一个顶层 block**,所有单元格文本
// 按 doc 顺序拍平成一个字符串做字符级 diff。删除整列时,被删文字的 widget
// 会通过「块内文本 offset → doc pos」映射落到**留存单元格内部**,于是每个
// 单元格前半截是红色删除标记、后半截是正常内容,列结构彻底丢失。
//
// 修复思路:表格按二维网格比对,而不是按拍平文本比对。
// - 列:用「该列所有行文本拼接」作指纹,表级跑一次 Myers 得到统一列对齐,
//   保证每一行的幽灵列插在同一位置(表格列不会错开)。
// - 行:用「该行所有单元格文本拼接」作指纹跑 Myers,识别删除行 / 新增行。
// - 被删列 → 在每一行的对应位置插入 `<td>/<th class="velo-diff-removed-cell">`
//   widget。widget 位于 table_row 内部的 cell 边界 pos,PM 会把它渲染成
//   `<tr>` 的独立子节点,视觉上就是单独一列标红,而不是混进留存单元格。
// - 被删行 → 插入 `<tr class="velo-diff-removed-row">` widget,内部按同样的
//   列对齐补齐单元格,保证幽灵行与新表列数一致。
// - 单元格内文本改动 → 字符级 diff 的作用域限定在**该单元格**的段落内,
//   不再跨单元格映射 offset。
//
// 所有删除内容仍是零长 Decoration.widget,不改动只读的新文档树。

import { Decoration } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import type { BlockEntry } from './blockDiff'
import {
  alignSequence,
  charDiffDecorations,
  type AlignOp,
  type TextSegment,
  type TextTarget,
} from './diffCommon'

// ========== 表格网格 ==========

interface CellInfo {
  node: PMNode
  /** 单元格节点的 doc 绝对起始 pos */
  pos: number
  text: string
}

interface RowInfo {
  node: PMNode
  /** 行节点的 doc 绝对起始 pos */
  pos: number
  cells: CellInfo[]
  isHeader: boolean
}

interface Grid {
  node: PMNode
  pos: number
  rows: RowInfo[]
}

function readGrid(block: BlockEntry): Grid {
  const rows: RowInfo[] = []
  // forEach 的 offset 是 child 相对父节点内容起点的偏移,
  // 绝对 pos = 父节点起始 pos + 1 + offset
  block.node.forEach((rowNode, rowOffset) => {
    const rowPos = block.pos + 1 + rowOffset
    const cells: CellInfo[] = []
    rowNode.forEach((cellNode, cellOffset) => {
      cells.push({
        node: cellNode,
        pos: rowPos + 1 + cellOffset,
        text: cellNode.textContent,
      })
    })
    rows.push({
      node: rowNode,
      pos: rowPos,
      cells,
      isHeader: rowNode.type.name === 'table_header_row',
    })
  })
  return { node: block.node, pos: block.pos, rows }
}

/** 单元格内的字符级 diff 作用域(只映射该 cell 的文本段) */
function cellTextTarget(cell: CellInfo): TextTarget {
  const segments: TextSegment[] = []
  let text = ''
  cell.node.descendants((child, localPos) => {
    if (child.isText && child.text) {
      segments.push({ pos: cell.pos + 1 + localPos, text: child.text })
      text += child.text
    }
    return true
  })
  return { pos: cell.pos, segments, text }
}

// ========== 列对齐 → 渲染指令 ==========

type ColRenderOp =
  | { kind: 'ghost'; oldIndex: number; at: number }
  | ({ at: number } & Exclude<AlignOp, { kind: 'delete' }>)

/**
 * 列对齐锚点 = **表头行**的单元格文本。
 *
 * 不能用「该列所有行文本拼接」做指纹:删任意一行都会让所有列指纹同时变化,
 * Myers 找不到 equal 锚点,整块退化成 N 个 delete + M 个 insert,列被错配
 * (删行 + 删列同时发生时,甚至会把删除文本重新塞进留存单元格)。
 * 列名才是列的身份,body 内容变化交给下面的 fullColumnKey 处理。
 */
function headerColumnKeys(grid: Grid, colCount: number): string[] {
  const header = grid.rows[0]
  return Array.from({ length: colCount }, (_, c) => header?.cells[c]?.text ?? '')
}

/** 列内全部行的文本(用于判断「列对齐上了,但列内容有改动」) */
function fullColumnKey(grid: Grid, c: number): string {
  return grid.rows.map(row => row.cells[c]?.text ?? '').join('\u0001')
}

/**
 * 行对齐 key = **列对齐后留存的列**的单元格文本。
 * 直接用「全部列文本」会在删列时让每一行 key 都变化,Myers 找不到 equal
 * 锚点,整块退化成 N delete + M insert,多余 delete 被排到块首 —— 幽灵行
 * 就跑到表头前面了。只比对留存列,删列对行对齐就完全透明。
 */
function rowKeys(grid: Grid, cols: number[]): string[] {
  return grid.rows.map(row => cols.map(c => row.cells[c]?.text ?? '').join('\u0002'))
}

/** 新行中「第 at 个单元格之前」的 widget 插入 pos;at 越界 → 行内容末尾 */
function ghostCellPos(row: RowInfo, at: number): number {
  if (at < row.cells.length) return row.cells[at].pos
  return row.pos + 1 + row.node.content.size
}

function ghostCell(text: string, isHeader: boolean): HTMLElement {
  const cell = document.createElement(isHeader ? 'th' : 'td')
  cell.className = 'velo-diff-removed-cell'
  cell.textContent = text
  return cell
}

// ========== 主函数 ==========

/**
 * 两张表格的 pair op 装饰。
 * 返回 null = 结构/文本都没变化(仅 marks / 非文本 leaf 变更),
 * 由调用方回退到通用「同文异 key」逻辑,避免吞掉格式变更标记。
 */
export function buildTablePairDecorations(
  oldBlock: BlockEntry,
  newBlock: BlockEntry,
): Decoration[] | null {
  const oldGrid = readGrid(oldBlock)
  const newGrid = readGrid(newBlock)

  const oldColCount = oldGrid.rows.reduce((m, r) => Math.max(m, r.cells.length), 0)
  const newColCount = newGrid.rows.reduce((m, r) => Math.max(m, r.cells.length), 0)
  const colOps = alignSequence(
    headerColumnKeys(oldGrid, oldColCount),
    headerColumnKeys(newGrid, newColCount),
  )
  // 行只比对「两版都存在的列」:删除 / 新增的列不参与行身份判定
  const survivingOldCols = colOps.flatMap(op =>
    op.kind === 'equal' || op.kind === 'pair' ? [op.oldIndex] : [])
  const survivingNewCols = colOps.flatMap(op =>
    op.kind === 'equal' || op.kind === 'pair' ? [op.newIndex] : [])
  const rowOps = alignSequence(
    rowKeys(oldGrid, survivingOldCols),
    rowKeys(newGrid, survivingNewCols),
  )

  // 列渲染指令:equal/pair/insert 各占一个新列位置(游标递增),
  // delete 不占新列,只在当前游标处留一列幽灵单元格。
  // 表头对齐成 equal 但整列内容有改动(body 单元格编辑 / 删行)→ 升级为 pair,
  // 逐单元格做字符级 diff,否则 body 里的改动会被完全漏掉。
  const colRender: ColRenderOp[] = []
  let outCol = 0
  for (const op of colOps) {
    if (op.kind === 'delete') {
      colRender.push({ kind: 'ghost', oldIndex: op.oldIndex, at: outCol })
    }
    else if (
      op.kind === 'equal'
      && fullColumnKey(oldGrid, op.oldIndex) !== fullColumnKey(newGrid, op.newIndex)
    ) {
      colRender.push({
        kind: 'pair', oldIndex: op.oldIndex, newIndex: op.newIndex, at: outCol++,
      })
    }
    else {
      colRender.push({ ...op, at: outCol++ })
    }
  }

  const structuralChange = colRender.some(op => op.kind !== 'equal')
    || rowOps.some(op => op.kind !== 'equal')
  if (!structuralChange) return null

  const decos: Decoration[] = []
  const tableEnd = newGrid.pos + 1 + newGrid.node.content.size
  let outRow = 0

  for (const rowOp of rowOps) {
    if (rowOp.kind === 'delete') {
      // 幽灵行插在下一个输出行之前;删的是尾部行时落在表格内容末尾。
      // 连续删行会落在同一 pos,靠 key 稳定顺序。
      // 行对齐必须用「留存列」的 key(见 rowKeys):否则删列后每行 key 全变,
      // Myers 退化成整块替换、多余 delete 排到块首,atPos 会落到第一行 pos,
      // 幽灵行就跑到表头前面了。
      const atPos = newGrid.rows[outRow]?.pos ?? tableEnd
      const oldRow = oldGrid.rows[rowOp.oldIndex]
      decos.push(deletedRowWidget(atPos, newGrid.pos, rowOp.oldIndex, oldRow, colRender))
      continue
    }

    const newRow = newGrid.rows[rowOp.newIndex]
    if (!newRow) { outRow++; continue }
    const oldRow = rowOp.kind === 'equal' || rowOp.kind === 'pair'
      ? oldGrid.rows[rowOp.oldIndex]
      : undefined

    for (const colOp of colRender) {
      if (colOp.kind === 'ghost') {
        const text = oldRow?.cells[colOp.oldIndex]?.text ?? ''
        decos.push(Decoration.widget(
          ghostCellPos(newRow, colOp.at),
          () => ghostCell(text, newRow.isHeader),
          {
            side: -1,
            ignoreSelection: true,
            // key 带表格 pos:同页多张表格 / 多个 block 同时删列时不能撞 key,
            // 否则 PM 会按 key 判定 widget 相等而复用错误的 DOM
            key: `velo-diff-ghost-col-${newGrid.pos}-${outRow}-${colOp.at}-${colOp.oldIndex}`,
          },
        ))
        continue
      }

      const newCell = newRow.cells[colOp.newIndex]
      if (!newCell) continue

      // 新增行 / 新增列 → 整个单元格绿底
      if (rowOp.kind === 'insert' || colOp.kind === 'insert') {
        decos.push(Decoration.node(newCell.pos, newCell.pos + newCell.node.nodeSize, {
          class: 'velo-diff-added-cell',
        }))
        continue
      }

      // equal 列无需处理;pair 列做「单元格内」字符级 diff
      if (colOp.kind === 'pair') {
        const target = cellTextTarget(newCell)
        const oldText = oldRow?.cells[colOp.oldIndex]?.text ?? ''
        if (oldText !== target.text) decos.push(...charDiffDecorations(oldText, target))
      }
    }

    outRow++
  }

  return decos
}

/** 被删行的幽灵 `<tr>`:按列渲染指令补齐到与新表相同的列数 */
function deletedRowWidget(
  pos: number,
  gridPos: number,
  rowIndex: number,
  oldRow: RowInfo | undefined,
  colRender: ColRenderOp[],
): Decoration {
  return Decoration.widget(pos, () => {
    const tr = document.createElement('tr')
    tr.className = 'velo-diff-removed-row'
    const isHeader = oldRow?.isHeader ?? false
    for (const colOp of colRender) {
      // insert 列在旧表中不存在 → 空单元格占位,保持列对齐
      const text = colOp.kind === 'insert'
        ? ''
        : (oldRow?.cells[colOp.oldIndex]?.text ?? '')
      tr.appendChild(ghostCell(text, isHeader))
    }
    return tr
  }, {
    side: -1,
    ignoreSelection: true,
    key: `velo-diff-ghost-row-${gridPos}-${rowIndex}`,
  })
}

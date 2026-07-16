// 表格行/列移动命令单元测试。
//
// 覆盖:
//   - cmdMoveRow(-1/+1) / cmdMoveColumn(-1/+1):CellSelection 矩形整块单步 swap
//   - 触边/触顶整块 noop:header 行不可移动 / 首 body 行上移 noop / 末行下移 noop
//   - 触边 noop:首列左移 noop / 末列右移 noop;单列表格列移动 noop
//   - 触顶上移 noop 与包含 header 行触顶 noop
//   - 移动后仍保持 CellSelection 覆盖移动后的块(支持连点继续推)
//   - GFM toMarkdown / fromMarkdown round-trip

import { describe, expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { CellSelection, TableMap } from 'prosemirror-tables'

// 用 cells[start..end] 的首尾 desc 构造 CellSelection(矩形拖蓝)。
function selectRect(
  view: import('prosemirror-view').EditorView,
  start: number,
  end: number,
): void {
  const cells = collectCellPos(view)
  view.dispatch(
    view.state.tr.setSelection(
      new CellSelection(view.state.doc.resolve(cells[start]), view.state.doc.resolve(cells[end])),
    ),
  )
}
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { cmdMoveRow, cmdMoveColumn } from '../editor/shortcuts/commands/tableCommands'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'

// ============================================================
//  辅助
// ============================================================

// 构造 header+body 表格,每个 cell 含可辨识文本 "R{r}/C{c}"
function buildTable(headerCols: number, bodyRows: number) {
  const mkText = (t: string) => schema.nodes.paragraph.create(null, schema.text(t))
  const h = Array.from({ length: headerCols }, (_, c) =>
    schema.nodes.table_header.create(null, mkText(`H${c}`)))
  const headerRow = schema.nodes.table_header_row.create(null, h)
  const body = Array.from({ length: bodyRows }, (_, r) =>
    schema.nodes.table_row.create(null,
      Array.from({ length: headerCols }, (_, c) =>
        schema.nodes.table_cell.create(null, mkText(`R${r}/C${c}`)))))
  return schema.nodes.table.create(null, [headerRow, ...body])
}

// 收集首个 table 的所有 cell 的 descendants pos(row-major: header 行 + 各行)。
function collectCellPos(view: EditorView): number[] {
  const cells: number[] = []
  view.state.doc.descendants((n, pos) => {
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
      cells.push(pos)
      return false
    }
    return true
  })
  return cells
}

function mount(blocks: ReturnType<typeof schema.node>[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, blocks)
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc, plugins: [] }),
  })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

// 读取表格中所有 cell 的文本内容(row-major),用于验证移动结果。
function readAllCellText(view: EditorView): string[] {
  const texts: string[] = []
  view.state.doc.descendants((n) => {
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
      texts.push(n.textContent)
      return false
    }
    return true
  })
  return texts
}

// ============================================================
//  行移动
// ============================================================

describe('cmdMoveRow:行移动(矩形整块)', () => {
  // 块 swap 的单行版 = 原来的"单 cell 上下相邻 swap",coverage 等价。
  it('上移 body 行块:row1 与 row0 交换', () => {
    // 1 header + 3 body,2 col。选 row1 单行块(rect.top=2,bottom=3)→ 上移与 row0 交换。
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 4, 5) // R1/C0..R1/C1
    const ok = cmdMoveRow(-1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H1', 'R1/C0', 'R1/C1', 'R0/C0', 'R0/C1', 'R2/C0', 'R2/C1',
    ])
    cleanup()
  })

  it('下移 body 行块:row1 与 row2 交换', () => {
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 4, 5) // R1
    const ok = cmdMoveRow(1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H1', 'R0/C0', 'R0/C1', 'R2/C0', 'R2/C1', 'R1/C0', 'R1/C1',
    ])
    cleanup()
  })

  // 选区包含 header 行时 rect.top=0,任何行移动 noop。
  it('header 行块不可移动(noop,上移)', () => {
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 0, 1) // H0..H1 (rect.top=0)
    const ok = cmdMoveRow(1)(view.state, view.dispatch)
    expect(ok).toBe(false)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H1', 'R0/C0', 'R0/C1', 'R1/C0', 'R1/C1', 'R2/C0', 'R2/C1',
    ])
    cleanup()
  })

  it('首 body 行块触顶上移 noop', () => {
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 2, 3) // R0 (rect.top=1,邻居=header → noop)
    expect(cmdMoveRow(-1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it('末 body 行块触底下移 noop', () => {
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 6, 7) // R2 (rect.bottom=4=children.length → noop)
    expect(cmdMoveRow(1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it('单 body 行表格:不可上移也不可下移(邻居不存在)', () => {
    const { view, cleanup } = mount([buildTable(2, 1), schema.node('paragraph')])
    selectRect(view, 2, 3) // 唯一的 body 行块:block [1,2),上触 header/下无邻居
    expect(cmdMoveRow(-1)(view.state, view.dispatch)).toBe(false)
    expect(cmdMoveRow(1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })
})

// ============================================================
//  列移动
// ============================================================

describe('cmdMoveColumn:列移动(矩形整块)', () => {
  // 单列 rect = 原来的"单个 col 左右相邻 swap",coverage 等价。
  // buildTable(3,2):header H0 H1 H2;row0 R0/C0 R0/C1 R0/C2;row1 R1/C0 R1/C1 R1/C2。
  // 单列矩形选 head===anchor 同 cell:selectRect(view,4,4)=row0 col1 单点,rect.left=1,right=2。
  it('左移列块:col1 与 col0 单步交换', () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    selectRect(view, 4, 4) // 单列 col1 rect
    const ok = cmdMoveColumn(-1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H1', 'H0', 'H2', 'R0/C1', 'R0/C0', 'R0/C2', 'R1/C1', 'R1/C0', 'R1/C2',
    ])
    cleanup()
  })

  it('右移列块:col1 与 col2 单步交换', () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    selectRect(view, 4, 4)
    const ok = cmdMoveColumn(1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H2', 'H1', 'R0/C0', 'R0/C2', 'R0/C1', 'R1/C0', 'R1/C2', 'R1/C1',
    ])
    cleanup()
  })

  it('首列块触左左移 noop', () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    selectRect(view, 3, 4) // col0 单列 rect
    expect(cmdMoveColumn(-1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it('末列块触右右移 noop', () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    selectRect(view, 5, 6) // col2 单列 rect
    expect(cmdMoveColumn(1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it('单列表格列块 noop(无邻居列)', () => {
    const { view, cleanup } = mount([buildTable(1, 2), schema.node('paragraph')])
    selectRect(view, 1, 2) // 唯一的列(单 col rect,left=0,right=1)
    expect(cmdMoveColumn(-1)(view.state, view.dispatch)).toBe(false)
    expect(cmdMoveColumn(1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })
})

// ============================================================
//  Round-trip
// ============================================================

// ============================================================
//  CellSelection 矩形整块移动(矩形覆盖的所有行/列一起移动)
// ============================================================
//
// 整块移动语义:当选中矩形包含 rows [top,bottom) 时,上/下移把整块
// 与相邻行做块 swap(不是逐行独立 swap)。触边/触顶 → 整块 noop。
// buildTable(2,4) row-major cells 索引(2 col):
//   [0,1]=H0/H1(header),  [2,3]=row0, [4,5]=row1, [6,7]=row2, [8,9]=row3

describe('cmdMoveRow:CellSelection 整块行移动', () => {
  // 2 col × 4 body,选 row1..row2(index 4..7 → anchor=4,head=7)。
  // 上移:row1..row2 整体与 row0 交换 → 顺序变成 row1,row2,row0,row3。
  it('单元格文本验证:整块上移 row1..row2 与 row0 块交换', () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    selectRect(view, 4, 7) // row1..row2
    const ok = cmdMoveRow(-1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H1',
      'R1/C0', 'R1/C1', 'R2/C0', 'R2/C1', // row1, row2 上移
      'R0/C0', 'R0/C1', // row0 被换下
      'R3/C0', 'R3/C1',
    ])
    cleanup()
  })

  // 同上选区,下移:row1..row2 整体与 row3 交换 → row0,row3,row1,row2。
  it('整块下移 row1..row2 与 row3 块交换', () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    selectRect(view, 4, 7)
    const ok = cmdMoveRow(1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H1',
      'R0/C0', 'R0/C1',
      'R3/C0', 'R3/C1', // row3 换上
      'R1/C0', 'R1/C1', 'R2/C0', 'R2/C1', // row1,row2 换下
    ])
    cleanup()
  })

  // 触顶:选 row0..row1(index 2..5),上移需越过 header → 整块 noop(false)。
  it('触顶整块上移 → noop(false),表格不变', () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    selectRect(view, 2, 5) // row0..row1
    const ok = cmdMoveRow(-1)(view.state, view.dispatch)
    expect(ok).toBe(false)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H1',
      'R0/C0', 'R0/C1', 'R1/C0', 'R1/C1', 'R2/C0', 'R2/C1', 'R3/C0', 'R3/C1',
    ])
    cleanup()
  })

  it('触底整块下移 → noop(false)', () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    selectRect(view, 6, 9) // row2..row3(body 最末两行)
    const ok = cmdMoveRow(1)(view.state, view.dispatch)
    expect(ok).toBe(false)
    cleanup()
  })

  // 选区包含 header 行(cells[0..7])的上移:top=0,触 header 边界 → 整块 noop。
  it('整块包含 header 行触顶上移 → noop(false)', () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    selectRect(view, 0, 7)
    expect(cmdMoveRow(-1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })
})

describe('cmdMoveColumn:CellSelection 整块列移动', () => {
  // 4 col × 2 body。选 col1..col2(row1)(index 5..6 → anchor=5(head row1,col1),...)。
  // 为简化,选左起连续 cols:cells header 起 4,row0 起 4。
  // buildTable(4,2): idx 0..3=header(H0..H3),4..7=row0(R0/C0..R0/C3),8..11=row1。
  // 矩形 anchor=5(row0,col1),head=6(row0,col2)覆盖 cols 1..2 width=2,跨 1 行。
  // 左移:col1..col2 块整体与 col0 块交换 → 每行变成 [col1,col2,col0,col3]。
  it('整块左移 col1..col2 与 col0 块交换', () => {
    const { view, cleanup } = mount([buildTable(4, 2), schema.node('paragraph')])
    selectRect(view, 5, 6) // cols 1..2,row0
    const ok = cmdMoveColumn(-1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 每行 = [col1,col2,col0,col3]
    expect(readAllCellText(view)).toEqual([
      'H1', 'H2', 'H0', 'H3',
      'R0/C1', 'R0/C2', 'R0/C0', 'R0/C3',
      'R1/C1', 'R1/C2', 'R1/C0', 'R1/C3',
    ])
    cleanup()
  })

  // 同样选区,右移:col1..col2 块与 col3 交换 → [col0,col3,col1,col2]。
  it('整块右移 col1..col2 与 col3 块交换', () => {
    const { view, cleanup } = mount([buildTable(4, 2), schema.node('paragraph')])
    selectRect(view, 5, 6)
    const ok = cmdMoveColumn(1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(readAllCellText(view)).toEqual([
      'H0', 'H3', 'H1', 'H2',
      'R0/C0', 'R0/C3', 'R0/C1', 'R0/C2',
      'R1/C0', 'R1/C3', 'R1/C1', 'R1/C2',
    ])
    cleanup()
  })

  it('触左整块左移 → noop(false)', () => {
    const { view, cleanup } = mount([buildTable(4, 2), schema.node('paragraph')])
    // col0 单列 rect(left=0,right=2,top=1,bottom=2)→ 触左 → noop。
    selectRect(view, 4, 4)
    expect(cmdMoveColumn(-1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it('触右整块右移 → noop(false)', () => {
    const { view, cleanup } = mount([buildTable(4, 2), schema.node('paragraph')])
    // col3 单列 rect(left=3,right=4)→ 触右 → noop。buildTable(4,2):idx8=row1 C0? 修:header idx0-3,row0 idx4-7,row1 idx8-11;col3=idx7(row0 C3)。
    selectRect(view, 7, 7)
    expect(cmdMoveColumn(1)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })
})

// 移动后应保持 CellSelection 覆盖移动后的块(交互上支持连点继续移)。
// 验证:移动后 selection 仍是 CellSelection,且其 $anchorCell 落在移动后块的首格 descendants pos。
// buildTable 4col×2 row-major:idx0..3=header H0..H3,4..7=row0(R0/C0..C3),8..11=row1。
describe('移动行/列后保持矩形选区', () => {
  it('行块下移后选区仍覆盖下移后的行块(top+1,bottom+1)', () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    selectRect(view, 2, 3) // row0 块 rect top=1,bottom=2
    expect(view.state.selection instanceof CellSelection).toBe(true)
    const ok = cmdMoveRow(1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    const sel = view.state.selection
    expect(sel instanceof CellSelection).toBe(true)
    // 下移 → 新块 [2,3)(落到 row1 位置,rect.top=2,bottom=3)。
    const table = (sel as CellSelection).$anchorCell.node(-1)
    const tableStart = (sel as CellSelection).$anchorCell.start(-1)
    const rect = TableMap.get(table).rectBetween(
      (sel as CellSelection).$anchorCell.pos - tableStart,
      (sel as CellSelection).$headCell.pos - tableStart,
    )
    expect(rect.top).toBe(2)
    expect(rect.bottom).toBe(3)
    cleanup()
  })

  it('列块左移后选区仍覆盖左移后的列块(left-1,right-1)', () => {
    const { view, cleanup } = mount([buildTable(4, 2), schema.node('paragraph')])
    // cells[5]=R0/C1,cells[6]=R0/C2 → 多列 rect(left=1,right=3),不触左。
    selectRect(view, 5, 6)
    const ok = cmdMoveColumn(-1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    const sel = view.state.selection
    expect(sel instanceof CellSelection).toBe(true)
    const table = (sel as CellSelection).$anchorCell.node(-1)
    const tableStart = (sel as CellSelection).$anchorCell.start(-1)
    const rect = TableMap.get(table).rectBetween(
      (sel as CellSelection).$anchorCell.pos - tableStart,
      (sel as CellSelection).$headCell.pos - tableStart,
    )
    expect(rect.left).toBe(0) // 落到 col0(col1..col2 块整体左移覆盖 col0..col1)
    expect(rect.right).toBe(2)
    cleanup()
  })
})

describe('表格移动 round-trip', () => {
  it('移动行后 toMarkdown → fromMarkdown 还原', () => {
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 2, 3) // R0 行块
    cmdMoveRow(1)(view.state, view.dispatch) // R0 下移 → 与 R1 交换
    const md = toMarkdown(view.state.doc)
    // 重新解析,验证内容一致
    const doc2 = fromMarkdown(md, schema)
    const texts: string[] = []
    doc2.descendants((n) => {
      if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
        texts.push(n.textContent)
        return false
      }
      return true
    })
    expect(texts).toEqual([
      'H0', 'H1', 'R1/C0', 'R1/C1', 'R0/C0', 'R0/C1', 'R2/C0', 'R2/C1',
    ])
    cleanup()
  })

  it('移动列后 toMarkdown → fromMarkdown 还原', () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    selectRect(view, 4, 4) // col1 单列块
    cmdMoveColumn(1)(view.state, view.dispatch) // col1 右移 → 与 col2 单步交换
    // 重新解析后:col0 不动,col1 与 col2 交换。
    const md = toMarkdown(view.state.doc)
    const doc2 = fromMarkdown(md, schema)
    const texts: string[] = []
    doc2.descendants((n) => {
      if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
        texts.push(n.textContent)
        return false
      }
      return true
    })
    expect(texts).toEqual([
      'H0', 'H2', 'H1', 'R0/C0', 'R0/C2', 'R0/C1', 'R1/C0', 'R1/C2', 'R1/C1',
    ])
    cleanup()
  })
})

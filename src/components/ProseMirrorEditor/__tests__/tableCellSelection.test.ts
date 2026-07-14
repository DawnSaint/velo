// v0.7.1 CellSelection(拖蓝多选)矩形批量增删集成测试。
//
// 覆盖:
//   - 矩形内右键 → 锚定右键点中格(cmd 以 anchorPos 解析 $from)
//   - 批量:上下插行沿矩形上/下外边界整体插 N 行(N = 矩形行数)
//   - 批量:左右插列沿矩形左/右外边界整体插 M 列(M = 矩形列数)
//   - 批量:删行删掉矩形覆盖的所有行(全删 → 删整张表)
//   - 批量:删列删掉矩形覆盖的所有列(保底留 1 列)
//   - 多列对齐:矩形覆盖的所有列一起对齐 + round-trip

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { CellSelection } from 'prosemirror-tables'
import { schema } from '../editor/schema'
import {
  cmdAddRowAfter,
  cmdAddRowBefore,
  cmdAddColumnAfter,
  cmdAddColumnBefore,
  cmdDeleteRow,
  cmdDeleteColumn,
  setCellAlignment,
} from '../editor/shortcuts/commands/tableCommands'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'

// ============================================================
//  辅助
// ============================================================

// 构造 header+body 表格,每个 cell 含可辨识文本 "R{row}/C{col}"
function buildTable(headerCols: number, bodyRows: number) {
  // 注意:paragraph.create([text]) 内容为空,须用 paragraph.create(null, text)。
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

// 数表格 body 行数。
function bodyRowCount(view: EditorView): number {
  let count = 0
  view.state.doc.descendants((n) => {
    if (n.type.name === 'table_row') count++
    return true
  })
  return count
}

// 数表格列数(header 行 = 首行 的 cell 数)。
function colCount(view: EditorView): number {
  let cols = 0
  view.state.doc.descendants((n) => {
    if (n.type.name === 'table') {
      n.child(0).forEach(() => cols++)
      return false // 找到 table 即停;只取首行
    }
    return true
  })
  return cols
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

// 把光标放到第 index 个 cell 的 paragraph 内容位置(cellPos+2,空 cell)。
function setCursorInCell(view: EditorView, index: number): void {
  const cells = collectCellPos(view)
  const cellPos = cells[index]
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos + 2))
  )
}

// ============================================================
//  矩形内右键锚定
// ============================================================

describe('CellSelection 矩形内右键:锚定点击格', () => {
  it('anchorPos 锚定右键点中格(非矩形起点)', () => {
    // 1 header + 3 body,3 col。
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形 anchor = (row1,col0) index 3,head = (row2,col1) index 7 → 覆盖 row1,row2 × col0,col1。
    const anchor = view.state.doc.resolve(cells[3])
    const head = view.state.doc.resolve(cells[7])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))

    // 右键点中矩形内 (row2,col1) = index 7(即 head),以它为 anchorPos 调用"右侧插列"。
    const clickCellPos = cells[7]
    const ok = cmdAddColumnAfter(schema, clickCellPos)(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 以最右边那格(col1)右边插 1 列;原 3 列 → 4 列。
    expect(colCount(view)).toBe(4)
    cleanup()
  })
})

describe('CellSelection 矩形内右键:插入锚定矩形外边界(1 行/1 列)', () => {
  it("下方插行:在最下面那格的下方插 1 行", () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形 = (row1,col0)index2 → (row2,col0)index4 → 底边界 = row2。
    const anchor = view.state.doc.resolve(cells[2])
    const head = view.state.doc.resolve(cells[4])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    expect(bodyRowCount(view)).toBe(4)
    // 右键点中 head(row2,col0),cmdAddRowAfter → 在最下面那格(row2)下方插 1 行。
    const ok = cmdAddRowAfter(schema, cells[4])(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(bodyRowCount(view)).toBe(5)
    cleanup()
  })

  it("上方插行:在最上面那格的上方插 1 行", () => {
    const { view, cleanup } = mount([buildTable(2, 4), schema.node('paragraph')])
    const cells = collectCellPos(view)
    const anchor = view.state.doc.resolve(cells[2]) // row1
    const head = view.state.doc.resolve(cells[4]) // row2
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdAddRowBefore(schema, cells[4])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 在最上面那格(row1)上方插 1 行 → 4+1=5。
    expect(bodyRowCount(view)).toBe(5)
    cleanup()
  })

  it("右侧插列:在最右边那格的右边插 1 列", () => {
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形 (row1,col0)index3 → (row2,col1)index7: 右边界 = col1。
    const anchor = view.state.doc.resolve(cells[3])
    const head = view.state.doc.resolve(cells[7])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdAddColumnAfter(schema, cells[7])(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(colCount(view)).toBe(4) // 原 3 + 1
    cleanup()
  })

  it("左侧插列:在最左边那格的左边插 1 列", () => {
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    const anchor = view.state.doc.resolve(cells[3])
    const head = view.state.doc.resolve(cells[7])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdAddColumnBefore(schema, cells[7])(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(colCount(view)).toBe(4)
    cleanup()
  })

  it("删行:删掉矩形覆盖的所有行", () => {
    const { view, cleanup } = mount([buildTable(2, 5), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形覆盖 row1,row2(2 行 body)。
    const anchor = view.state.doc.resolve(cells[2])
    const head = view.state.doc.resolve(cells[4])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdDeleteRow(schema, cells[4])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 5 body - 2 = 3。
    expect(bodyRowCount(view)).toBe(3)
    cleanup()
  })

  it("删行:矩形覆盖全部 body 行 → 删光所有 body 行,仅留 header(table_row* 语义)", () => {
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形覆盖全部 3 body 行: (row1,col0)index2 → (row3,col1)index7。
    const anchor = view.state.doc.resolve(cells[2])
    const head = view.state.doc.resolve(cells[7])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdDeleteRow(schema, cells[7])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // schema 允许 0 body 行(table_row*) → 删光所有 body 行,仅留 header。
    let tableCount = 0
    view.state.doc.descendants((n) => { if (n.type.name === 'table') tableCount++; return true })
    expect(tableCount).toBe(1)
    expect(bodyRowCount(view)).toBe(0)
    cleanup()
  })

  // header 相关
  it("上方插行且矩形触及 header → 新行变 header,旧 header 降级为 body", () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形从 header(col0)index0 到 row1(col1)index4 → rect.top=0。
    const anchor = view.state.doc.resolve(cells[0])
    const head = view.state.doc.resolve(cells[4])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdAddRowBefore(schema, cells[4])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 新表 header 行(index 0)应为空 header_row;原 header 内容降级到 index 1 的 body 行。
    let headerContent = ""
    let row1Content = ""
    view.state.doc.descendants((n) => {
      if (n.type.name === 'table_header_row') { headerContent = n.textContent; return false }
      return true
    })
    // 找 index 1 的 body 行(原 header 内容"尚未被覆盖")。
    view.state.doc.descendants((n) => {
      if (n.type.name === 'table_row' && row1Content === "") { row1Content = n.textContent; return false }
      return true
    })
    expect(headerContent).toBe("") // 新 header 行为空
    expect(row1Content).toContain("H0") // 旧 header 内容降级为 body 行
    expect(bodyRowCount(view)).toBe(3) // 原 2 body + 旧 header 降级 1 = 3
    cleanup()
  })

  it("矩形完全在 header 行内 → 删行无效(无 body 行可删)", () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形仅在 header 行内: (col0)index0 → (col2)index2 → rect.top=0,bottom=1。
    const anchor = view.state.doc.resolve(cells[0])
    const head = view.state.doc.resolve(cells[2])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdDeleteRow(schema, cells[2])(view.state, view.dispatch)
    expect(ok).toBe(false)
    expect(bodyRowCount(view)).toBe(2) // 未删
    cleanup()
  })

  // 单 cell(header)右键:上方插行 = 新 header + 旧 header 降级为 body;下方插行 = header 后插 1 body。
  it("单 cell(header)上方插行 → 新 header + 旧 header 变 body", () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 光标放 header 第 1 格(index 0,非矩形单 cell)。
    setCursorInCell(view, 0)
    const ok = cmdAddRowBefore(schema, cells[0])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 新表: index 0 = 新 header(空),index 1 = 旧 header 降级 body(含 H0/H1/H2),原 body 顺延。
    let headerText = ""
    view.state.doc.descendants((n) => { if (n.type.name === 'table_header_row') { headerText = n.textContent; return false } return true })
    expect(headerText).toBe("")
    expect(bodyRowCount(view)).toBe(3) // 原 2 + 旧 header 降级 1
    // 验证旧 header 内容降级到 body 第 1 行。
    let firstBodyText = ""
    view.state.doc.descendants((n) => { if (n.type.name === 'table_row' && firstBodyText === "") { firstBodyText = n.textContent; return false } return true })
    expect(firstBodyText).toContain("H0")
    cleanup()
  })

  it("单 cell(header)下方插行 → header 后插 1 空 body", () => {
    const { view, cleanup } = mount([buildTable(3, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    setCursorInCell(view, 0)
    const ok = cmdAddRowAfter(schema, cells[0])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // index 0 = header(保留),index 1 = 新空 body,原 body 顺延。
    let headerText = ""
    view.state.doc.descendants((n) => { if (n.type.name === 'table_header_row') { headerText = n.textContent; return false } return true })
    expect(headerText).toContain("H0")
    expect(bodyRowCount(view)).toBe(3) // 原 2 + 1
    // 新插的第 1 个 body 行为空;断言所有 body 行。
    const allBody: string[] = []
    view.state.doc.descendants((n) => { if (n.type.name === 'table_row') allBody.push(n.textContent); return true })
    expect(allBody[0]).toBe("")
    cleanup()
  })

  it("删行:删光最后 1 个 body 行 → 仅留 header(table_row*)", () => {
    const { view, cleanup } = mount([buildTable(2, 1), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // buildTable(2,1):cells[0..1]=header(H0/H1),cells[2..3]=body(R0)。
    setCursorInCell(view, 2)
    const ok = cmdDeleteRow(schema, cells[2])(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(bodyRowCount(view)).toBe(0) // 仅留 header
    cleanup()
  })

  it("删列:删掉矩形覆盖的所有列,保底留 1 列", () => {
    const { view, cleanup } = mount([buildTable(4, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形覆盖 col0,col1(2 列): anchor(row0,col0)index4,head(row2,col1)index13。
    const anchor = view.state.doc.resolve(cells[4])
    const head = view.state.doc.resolve(cells[13])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdDeleteColumn(schema, cells[13])(view.state, view.dispatch)
    expect(ok).toBe(true)
    expect(colCount(view)).toBe(2) // 4 - 2
    cleanup()
  })

  it("删列:矩形覆盖全部列 → 删整张表", () => {
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 矩形覆盖全部 3 列: anchor(row0,col0)index3,head(row2,col2)index11。
    const anchor = view.state.doc.resolve(cells[3])
    const head = view.state.doc.resolve(cells[11])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdDeleteColumn(schema, cells[11])(view.state, view.dispatch)
    expect(ok).toBe(true)
    let tableCount = 0
    view.state.doc.descendants((n) => { if (n.type.name === 'table') tableCount++; return true })
    expect(tableCount).toBe(0)
    cleanup()
  })

  it("删列:单点最后一列(仅 1 列)→ 删整张表", () => {
    const { view, cleanup } = mount([buildTable(1, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 仅 1 列,光标放 body 首格;anchorPos 用 cells[1]+1 模拟 posAtDOM 的真实返回(cell 内容起点)。
    setCursorInCell(view, 1)
    const ok = cmdDeleteColumn(schema, cells[1] + 1)(view.state, view.dispatch)
    expect(ok).toBe(true)
    let tableCount = 0
    view.state.doc.descendants((n) => { if (n.type.name === 'table') tableCount++; return true })
    expect(tableCount).toBe(0)
    cleanup()
  })

  it("删行:全表拖蓝(覆盖 header + 所有 body)→ 删整张表", () => {
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // 全表拖蓝: anchor = header 首格(index 0),head = 末 body 末格(index 11)。
    const anchor = view.state.doc.resolve(cells[0])
    const head = view.state.doc.resolve(cells[cells.length - 1])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    const ok = cmdDeleteRow(schema, cells[cells.length - 1])(view.state, view.dispatch)
    expect(ok).toBe(true)
    let tableCount = 0
    view.state.doc.descendants((n) => { if (n.type.name === 'table') tableCount++; return true })
    expect(tableCount).toBe(0)
    cleanup()
  })
})

describe('CellSelection 多列对齐 + round-trip', () => {
  it("矩形覆盖列一起对齐 → markdownIO 往返闭合", () => {
    // 1 header + 2 body,3 col。
    const md = [
      '| H0 | H1 | H2 |',
      '|---|---|---|',
      '| a | b | c |',
      '| d | e | f |',
    ].join('\n')
    const doc = fromMarkdown(md, schema)
    const { view, cleanup } = mount([doc.child(0), schema.node('paragraph')])
    const cells = collectCellPos(view)
    // buildTable(3,2): cells[0..2]=header,[3..5]=row0,[6..8]=row1。
    // 矩形覆盖 col0,col1: anchor(row0,col0)index3,head(row1,col1)index7。
    const anchor = view.state.doc.resolve(cells[3])
    const head = view.state.doc.resolve(cells[7])
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))
    // 右键点中矩形内 (row0,col1)=index4 → 对齐。
    const ok = setCellAlignment('center', cells[4])(view.state, view.dispatch)
    expect(ok).toBe(true)
    // round-trip:serialize → 解析 → 列对齐语义保留。
    const back = toMarkdown(view.state.doc)
    const doc2 = fromMarkdown(back, schema)
    // body 6 cells(row-major): col0,col1 = center(覆盖), col2 = left(未覆盖)。
    const aligns: string[] = []
    doc2.descendants((n) => {
      if (n.type.name === 'table_cell') aligns.push((n.attrs.alignment as string) || 'left')
      return true
    })
    expect(aligns).toEqual(['center', 'center', 'left', 'center', 'center', 'left'])
    cleanup()
  })
})

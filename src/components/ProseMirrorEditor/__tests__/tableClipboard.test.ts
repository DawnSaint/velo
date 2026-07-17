// CellSelection 剪贴板行为集成测试。
//
// 覆盖:
//   - content():矩形 CellSelection 产出 rows slice(openStart=1/openEnd=1)
//   - clipboardTextSerializer:tab 分隔列、换行分隔行(对齐 Excel/Sheets)
//   - cut(deleteSelection):清空矩形内所有 cell 内容,保留 cell 结构
//   - paste(handlePaste):整块 cell 粘贴覆盖选中区域
//   - paste:非表格纯文本 → 塞入首个 cell

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { Slice, Fragment } from 'prosemirror-model'
import { EditorView } from 'prosemirror-view'
import { CellSelection, tableEditing, handlePaste } from 'prosemirror-tables'
import { DOMParser, DOMSerializer } from 'prosemirror-model'
import { schema } from '../editor/schema'
import { createTableCellInputGuardPlugin } from '../plugins/tableCellInputGuard'

// ============================================================
//  辅助
// ============================================================

function mkText(t: string) {
  return schema.nodes.paragraph.create(null, t ? schema.text(t) : undefined)
}

// 构造 header + body 表格,每个 cell 含可辨识文本。
function buildTable(headerCols: number, bodyRows: number, prefix = 'R') {
  const h = Array.from({ length: headerCols }, (_, c) =>
    schema.nodes.table_header.create(null, mkText(`H${c}`)))
  const headerRow = schema.nodes.table_header_row.create(null, h)
  const body = Array.from({ length: bodyRows }, (_, r) =>
    schema.nodes.table_row.create(null,
      Array.from({ length: headerCols }, (_, c) =>
        schema.nodes.table_cell.create(null, mkText(`${prefix}${r}/C${c}`)))))
  return schema.nodes.table.create(null, [headerRow, ...body])
}

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

// 用 cells[start..end] 构造 CellSelection(矩形拖蓝)。
function selectRect(view: EditorView, start: number, end: number) {
  const cells = collectCellPos(view)
  view.dispatch(
    view.state.tr.setSelection(
      new CellSelection(view.state.doc.resolve(cells[start]), view.state.doc.resolve(cells[end])),
    ),
  )
}

function mount(blocks: ReturnType<typeof schema.node>[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, blocks)
  const view = new EditorView(host, {
    state: EditorState.create({
      schema,
      doc,
      plugins: [createTableCellInputGuardPlugin(), tableEditing()],
    }),
  })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

// 收集表格 body cell 文本(row-major)。
function bodyCellTexts(view: EditorView): string[] {
  const texts: string[] = []
  view.state.doc.descendants((n) => {
    if (n.type.name === 'table_cell') {
      texts.push(n.textContent)
    }
    return true
  })
  return texts
}

// ============================================================
//  content():矩形 slice
// ============================================================

describe('CellSelection content():矩形 cell 块', () => {
  it('2×2 矩形 → slice 含 2 rows,每行 2 cells,openStart=openEnd=1', () => {
    // 3 col × 3 body:cells[3..11] = body
    //   index 3=R0/C0 4=R0/C1 5=R0/C2
    //   index 6=R1/C0 7=R1/C1 8=R1/C2
    //   index 9=R2/C0 10=R2/C1 11=R2/C2
    // 矩形 R0/C0..R1/C1 = index 3..7
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    selectRect(view, 3, 7)
    const slice = view.state.selection.content()
    expect(slice.openStart).toBe(1)
    expect(slice.openEnd).toBe(1)
    // 2 rows
    expect(slice.content.childCount).toBe(2)
    // 每行 2 cells
    expect(slice.content.child(0).childCount).toBe(2)
    expect(slice.content.child(1).childCount).toBe(2)
    // 内容正确
    expect(slice.content.child(0).child(0).textContent).toBe('R0/C0')
    expect(slice.content.child(0).child(1).textContent).toBe('R0/C1')
    expect(slice.content.child(1).child(0).textContent).toBe('R1/C0')
    expect(slice.content.child(1).child(1).textContent).toBe('R1/C1')
    cleanup()
  })

  it('整行选中 → slice 含完整行', () => {
    // 2 col × 2 body:选中第一行 body (index 2..3)
    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    selectRect(view, 2, 3)
    const slice = view.state.selection.content()
    expect(slice.content.childCount).toBe(1)
    expect(slice.content.child(0).childCount).toBe(2)
    expect(slice.content.child(0).child(0).textContent).toBe('R0/C0')
    expect(slice.content.child(0).child(1).textContent).toBe('R0/C1')
    cleanup()
  })
})

// ============================================================
//  clipboardTextSerializer:tab 分隔
// ============================================================

describe('clipboardTextSerializer:CellSelection → tab 分隔文本', () => {
  it('2×2 矩形 → "R0/C0\\tR0/C1\\nR1/C0\\tR1/C1"', () => {
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    selectRect(view, 3, 7) // R0/C0..R1/C1
    const slice = view.state.selection.content()
    // 调 clipboardTextSerializer(通过 view.someProp)
    let text: string | undefined
    view.someProp('clipboardTextSerializer' as never, (f: (s: typeof slice) => string) => {
      text = f(slice)
      return text
    })
    expect(text).toBe('R0/C0\tR0/C1\nR1/C0\tR1/C1')
    cleanup()
  })

  it('整行选中(1×3)→ "H0\\tH1\\tH2"', () => {
    // 3 col × 1 body:header = index 0..2
    const { view, cleanup } = mount([buildTable(3, 1), schema.node('paragraph')])
    selectRect(view, 0, 2)
    const slice = view.state.selection.content()
    let text: string | undefined
    view.someProp('clipboardTextSerializer' as never, (f: (s: typeof slice) => string) => {
      text = f(slice)
      return text
    })
    expect(text).toBe('H0\tH1\tH2')
    cleanup()
  })

  it('TextSelection slice → 返回 undefined(走 PM 默认)', () => {
    const { view, cleanup } = mount([schema.node('paragraph', null, schema.text('hello')), schema.node('paragraph')])
    // 选中 "hello" 的前 3 个字符
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 4)))
    const slice = view.state.selection.content()
    let text: string | undefined
    view.someProp('clipboardTextSerializer' as never, (f: (s: typeof slice) => string) => {
      text = f(slice)
      return text
    })
    // TextSelection 的 slice openStart=0/openEnd=0 → 不匹配 → 返回 undefined
    expect(text).toBeUndefined()
    cleanup()
  })
})

// ============================================================
//  cut:deleteSelection 清空矩形内所有 cell
// ============================================================

describe('CellSelection cut:deleteSelection 清空选中 cell', () => {
  it('2×2 矩形 → 4 个 cell 被清空,其余保留', () => {
    // 3 col × 3 body
    const { view, cleanup } = mount([buildTable(3, 3), schema.node('paragraph')])
    selectRect(view, 3, 7) // R0/C0..R1/C1
    // deleteSelection = cut 的删除部分
    view.dispatch(view.state.tr.deleteSelection())
    const texts = bodyCellTexts(view)
    // body cells row-major: R0/C0, R0/C1, R0/C2, R1/C0, R1/C1, R1/C2, R2/C0, R2/C1, R2/C2
    // 矩形 R0/C0..R1/C1 清空 → index 0,1,3,4 为空
    expect(texts[0]).toBe('') // R0/C0 清空
    expect(texts[1]).toBe('') // R0/C1 清空
    expect(texts[2]).toBe('R0/C2') // 保留
    expect(texts[3]).toBe('') // R1/C0 清空
    expect(texts[4]).toBe('') // R1/C1 清空
    expect(texts[5]).toBe('R1/C2') // 保留
    expect(texts[6]).toBe('R2/C0') // 保留
    expect(texts[7]).toBe('R2/C1') // 保留
    expect(texts[8]).toBe('R2/C2') // 保留
    cleanup()
  })

  it('整行选中 → 整行清空', () => {
    // 2 col × 3 body:选中第二行 body (index 4..5)
    const { view, cleanup } = mount([buildTable(2, 3), schema.node('paragraph')])
    selectRect(view, 4, 5) // R1/C0..R1/C1
    view.dispatch(view.state.tr.deleteSelection())
    const texts = bodyCellTexts(view)
    // R0/C0, R0/C1, R1/C0(空), R1/C1(空), R2/C0, R2/C1
    expect(texts[0]).toBe('R0/C0')
    expect(texts[1]).toBe('R0/C1')
    expect(texts[2]).toBe('')
    expect(texts[3]).toBe('')
    expect(texts[4]).toBe('R2/C0')
    expect(texts[5]).toBe('R2/C1')
    cleanup()
  })
})

// ============================================================
//  paste:handlePaste 整块填充
// ============================================================

describe('CellSelection paste:handlePaste 整块填充', () => {
  it('2×2 矩形粘贴 2×2 cell 块 → 覆盖选中区域', () => {
    // 源表:2 col × 2 body,内容 X0/C0 等
    // 用 mount 拿到 view,从 doc 取 cell pos(已含 doc 偏移)
    const srcMount = mount([buildTable(2, 2, 'X'), schema.node('paragraph')])
    const srcCells = collectCellPos(srcMount.view)
    // body 2×2 = cells[2..5]
    const srcSel = new CellSelection(
      srcMount.view.state.doc.resolve(srcCells[2]),
      srcMount.view.state.doc.resolve(srcCells[5]),
    )
    const srcSlice = srcSel.content()
    expect(srcSlice.content.childCount).toBe(2) // 2 rows
    expect(srcSlice.content.child(0).childCount).toBe(2) // 2 cells per row

    // 目标表:2 col × 2 body,内容 R0/C0 等
    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    selectRect(view, 2, 5) // body 2×2 = cells[2]..cells[5]
    expect(view.state.selection instanceof CellSelection).toBe(true)

    // handlePaste(view, _event, slice) — event 参数未使用,传空对象即可
    const ok = handlePaste(view, {} as ClipboardEvent, srcSlice)
    expect(ok).toBe(true)

    const texts = bodyCellTexts(view)
    // 全部 4 个 body cell 被源表内容覆盖
    expect(texts[0]).toBe('X0/C0')
    expect(texts[1]).toBe('X0/C1')
    expect(texts[2]).toBe('X1/C0')
    expect(texts[3]).toBe('X1/C1')
    srcMount.cleanup()
    cleanup()
  })

  it('2×2 矩形粘贴 1×1 cell → 整块填同一个内容', () => {
    // 源:单 cell 内容 "SINGLE"
    const srcCell = schema.nodes.table_cell.create(null, mkText('SINGLE'))
    const srcRow = schema.nodes.table_row.create(null, [srcCell])
    // 构造一个 1×1 的 row slice(openStart=1/openEnd=1,content = single row with 1 cell)
    // handlePaste → pastedCells 返回 {width:1, height:1, rows:[Fragment(cell)]}
    // → clipCells 扩展到 2×2(重复填充)
    const singleCellSlice = new Slice(Fragment.from(srcRow), 1, 1)

    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    selectRect(view, 2, 5) // body 2×2
    const ok = handlePaste(view, {} as ClipboardEvent, singleCellSlice)
    expect(ok).toBe(true)

    const texts = bodyCellTexts(view)
    // clipCells 把 1×1 扩展到 2×2,每个 cell 填 "SINGLE"
    expect(texts[0]).toBe('SINGLE')
    expect(texts[1]).toBe('SINGLE')
    expect(texts[2]).toBe('SINGLE')
    expect(texts[3]).toBe('SINGLE')
    cleanup()
  })

  it('纯文本 slice(非表格)→ 塞入首个 cell', () => {
    // 纯文本 slice:openStart=0/openEnd=0,content = paragraph("plain")
    const textSlice = new Slice(
      Fragment.from(schema.nodes.paragraph.create(null, schema.text('plain'))),
      0, 0,
    )

    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    selectRect(view, 2, 5) // body 2×2
    const ok = handlePaste(view, {} as ClipboardEvent, textSlice)
    expect(ok).toBe(true)

    const texts = bodyCellTexts(view)
    // pastedCells 返回 null → handlePaste 走 fallback:fitSlice 塞入单 cell
    // clipCells 把 1×1 扩展到 2×2,但 fitSlice 只产出 1 个有内容的 cell + 空 cell
    // 实际行为:首个 cell 得到 "plain",其余被 clipCells 重复填充(但 fitSlice 产出的
    // 单 cell 有内容,clipCells 重复时会复制内容)
    // 验证至少首个 cell 有 "plain"
    expect(texts[0]).toContain('plain')
    cleanup()
  })

  it('单 cell 光标粘贴 2×1 cell 块 → 从当前 cell 开始填充', () => {
    // 目标:2 col × 2 body,光标在首个 body cell
    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, cells[2] + 2), // body 首格
    ))

    // 源:1 row × 2 cells
    const srcRow = schema.nodes.table_row.create(null, [
      schema.nodes.table_cell.create(null, mkText('A')),
      schema.nodes.table_cell.create(null, mkText('B')),
    ])
    const srcSlice = new Slice(Fragment.from(srcRow), 1, 1)

    const ok = handlePaste(view, {} as ClipboardEvent, srcSlice)
    expect(ok).toBe(true)

    const texts = bodyCellTexts(view)
    // 从当前 cell 开始填:A, B, 原内容保留
    expect(texts[0]).toBe('A')
    expect(texts[1]).toBe('B')
    // 第二行原内容保留
    expect(texts[2]).toBe('R1/C0')
    expect(texts[3]).toBe('R1/C1')
    cleanup()
  })
})

// ============================================================
//  copy → paste round-trip
// ============================================================

describe('CellSelection copy → paste round-trip', () => {
  it('从源表复制 2×2 → 粘贴到目标表 2×2 → 内容一致', () => {
    // 源表:3 col × 3 body,内容 S 前缀
    const srcMount = mount([buildTable(3, 3, 'S'), schema.node('paragraph')])
    selectRect(srcMount.view, 3, 7) // S0/C0..S1/C1
    const srcSlice = srcMount.view.state.selection.content()

    // 目标表:3 col × 3 body,内容 T 前缀
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 3, 7) // T0/C0..T1/C1
    handlePaste(view, {} as ClipboardEvent, srcSlice)

    const texts = bodyCellTexts(view)
    // 矩形内被源表覆盖
    expect(texts[0]).toBe('S0/C0')
    expect(texts[1]).toBe('S0/C1')
    expect(texts[2]).toBe('T0/C2') // 矩形外保留
    expect(texts[3]).toBe('S1/C0')
    expect(texts[4]).toBe('S1/C1')
    expect(texts[5]).toBe('T1/C2') // 矩形外保留
    expect(texts[6]).toBe('T2/C0') // 矩形外保留
    expect(texts[7]).toBe('T2/C1') // 矩形外保留
    expect(texts[8]).toBe('T2/C2') // 矩形外保留
    srcMount.cleanup()
    cleanup()
  })
})

// ============================================================
//  text/plain 路径粘贴(无 HTML,模拟 Tauri clipboard 丢失 HTML 的场景)
//  clipboardTextSerializer 产出 tab 分隔文本 → clipboardTextParser 解析回表格行
// ============================================================

describe('CellSelection text/plain 路径:tab 分隔文本 → 表格行', () => {
  it('列复制(1 col × 3 rows)→ 粘贴到空列 → 纵向填充(不横向加列)', () => {
    // 源表:3 col × 3 body,复制 col1 的 3 个 body cell
    const srcMount = mount([buildTable(3, 3, 'S'), schema.node('paragraph')])
    // col1 body = cells[4], cells[7], cells[10]
    selectRect(srcMount.view, 4, 10) // S0/C1..S2/C1 (列选)
    const slice = srcMount.view.state.selection.content()

    // 用 clipboardTextSerializer 把 slice 序列化为 tab 分隔文本
    let text: string | undefined
    srcMount.view.someProp('clipboardTextSerializer' as never, (f: (s: typeof slice) => string) => {
      text = f(slice)
      return text
    })
    expect(text).toBe('S0/C1\nS1/C1\nS2/C1') // 3 行 × 1 列

    // 目标表:3 col × 3 body,内容 T 前缀
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    // 选中目标表 col2 的 body(空列或待覆盖列)
    selectRect(view, 5, 11) // T0/C2..T2/C2 (列选)

    // 模拟 text/plain 路径:用 clipboardTextParser 解析文本 → handlePaste
    const $context = view.state.selection.$anchor
    let parsedSlice: Slice | undefined
    view.someProp('clipboardTextParser' as never, (f: (t: string, c: typeof $context, p: boolean, v: EditorView) => Slice) => {
      parsedSlice = f(text!, $context, false, view)
      return parsedSlice
    })
    expect(parsedSlice).toBeDefined()
    expect(parsedSlice!.openStart).toBe(1)
    expect(parsedSlice!.openEnd).toBe(1)
    // 3 行 × 1 列
    expect(parsedSlice!.content.childCount).toBe(3)
    expect(parsedSlice!.content.child(0).childCount).toBe(1)

    const ok = handlePaste(view, {} as ClipboardEvent, parsedSlice!)
    expect(ok).toBe(true)

    const texts = bodyCellTexts(view)
    // col2 (index 2, 5, 8) 被源数据纵向填充
    expect(texts[2]).toBe('S0/C1')
    expect(texts[5]).toBe('S1/C1')
    expect(texts[8]).toBe('S2/C1')
    // col0, col1 保留原内容
    expect(texts[0]).toBe('T0/C0')
    expect(texts[1]).toBe('T0/C1')
    expect(texts[3]).toBe('T1/C0')
    expect(texts[4]).toBe('T1/C1')
    expect(texts[6]).toBe('T2/C0')
    expect(texts[7]).toBe('T2/C1')
    srcMount.cleanup()
    cleanup()
  })

  it('行复制(3 col × 1 row)→ 粘贴到空行 → 横向填充', () => {
    // 源表:3 col × 3 body,复制 row0 的 3 个 body cell
    const srcMount = mount([buildTable(3, 3, 'S'), schema.node('paragraph')])
    selectRect(srcMount.view, 3, 5) // S0/C0..S0/C2 (行选)
    const slice = srcMount.view.state.selection.content()

    let text: string | undefined
    srcMount.view.someProp('clipboardTextSerializer' as never, (f: (s: typeof slice) => string) => {
      text = f(slice)
      return text
    })
    expect(text).toBe('S0/C0\tS0/C1\tS0/C2') // 1 行 × 3 列

    // 目标表:3 col × 3 body
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    // 选中目标表 row2 的 body
    selectRect(view, 9, 11) // T2/C0..T2/C2 (行选)

    const $context = view.state.selection.$anchor
    let parsedSlice: Slice | undefined
    view.someProp('clipboardTextParser' as never, (f: (t: string, c: typeof $context, p: boolean, v: EditorView) => Slice) => {
      parsedSlice = f(text!, $context, false, view)
      return parsedSlice
    })
    expect(parsedSlice).toBeDefined()
    // 1 行 × 3 列
    expect(parsedSlice!.content.childCount).toBe(1)
    expect(parsedSlice!.content.child(0).childCount).toBe(3)

    handlePaste(view, {} as ClipboardEvent, parsedSlice!)

    const texts = bodyCellTexts(view)
    // row2 (index 6, 7, 8) 被源数据横向填充
    expect(texts[6]).toBe('S0/C0')
    expect(texts[7]).toBe('S0/C1')
    expect(texts[8]).toBe('S0/C2')
    // row0, row1 保留
    expect(texts[0]).toBe('T0/C0')
    expect(texts[3]).toBe('T1/C0')
    srcMount.cleanup()
    cleanup()
  })

  it('纯单行文本(无 tab 无换行)→ clipboardTextParser 返回 null(走默认)', () => {
    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    const cells = collectCellPos(view)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, cells[2] + 2),
    ))
    const $context = view.state.selection.$anchor
    let result: Slice | undefined
    view.someProp('clipboardTextParser' as never, (f: (t: string, c: typeof $context, p: boolean, v: EditorView) => Slice) => {
      result = f('hello', $context, false, view)
      return result
    })
    expect(result).toBeNull()
    cleanup()
  })

  it('非表格上下文 → clipboardTextParser 返回 null', () => {
    const { view, cleanup } = mount([schema.node('paragraph', null, schema.text('x')), schema.node('paragraph')])
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    const $context = view.state.selection.$anchor
    let result: Slice | undefined
    view.someProp('clipboardTextParser' as never, (f: (t: string, c: typeof $context, p: boolean, v: EditorView) => Slice) => {
      result = f('A\tB\nC\tD', $context, false, view)
      return result
    })
    expect(result).toBeNull()
    cleanup()
  })
})

// ============================================================
//  HTML 路径粘贴(slice 无表格结构,clipboard text 有 TSV)
//  模拟:serializeForClipboard 产出 <table><tbody><tr>... HTML + tab 分隔 text/plain,
//  paste 时 HTML 路径被走(asText=false),DOMParser 用 table_cell context 解析 →
//  <tr>/<td> 被剥离 → slice 变成段落 → pastedCells 返回 null。
//  tableCellInputGuardPlugin 的 handlePaste 拦截:检测无 tableRole → 读 clipboard
//  text/plain → TSV 重建 table_row slice → 委托 tableEditing handlePaste 整块填充。
// ============================================================

describe('CellSelection HTML 路径:slice 无表格结构 → handlePaste 重建', () => {
  // 模拟 doPaste 的完整流程:parseFromClipboard 产出的 slice 是段落(无表格结构),
  // handlePaste(view, event, slice) 被调用,event.clipboardData 有 text/plain。
  function makeClipEvent(plainText: string): ClipboardEvent {
    return {
      clipboardData: {
        getData: (mime: string) => mime === 'text/plain' ? plainText : '',
      } as DataTransfer,
    } as unknown as ClipboardEvent
  }

  it('列复制(3 rows × 1 col)→ HTML 路径 slice 为段落 → 重建后纵向填充', () => {
    // 目标表:3 col × 3 body
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 5, 11) // T0/C2..T2/C2 (列选 col2 body)

    // 模拟 HTML 路径产出的 slice:3 个段落(DOMParser 剥离 <tr>/<td> 后的结果)
    const paragraphs = [
      schema.nodes.paragraph.create(null, schema.text('S0/C1')),
      schema.nodes.paragraph.create(null, schema.text('S1/C1')),
      schema.nodes.paragraph.create(null, schema.text('S2/C1')),
    ]
    const brokenSlice = new Slice(Fragment.from(paragraphs), 0, 0)

    // clipboard event 带 text/plain = "S0/C1\nS1/C1\nS2/C1"
    const event = makeClipEvent('S0/C1\nS1/C1\nS2/C1')

    // 调 someProp handlePaste(模拟 doPaste 的调用方式)
    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, event, brokenSlice)
      return handled
    })

    expect(handled).toBe(true)

    const texts = bodyCellTexts(view)
    // col2 被纵向填充(不是横向!)
    expect(texts[2]).toBe('S0/C1')
    expect(texts[5]).toBe('S1/C1')
    expect(texts[8]).toBe('S2/C1')
    // 其他列保留
    expect(texts[0]).toBe('T0/C0')
    expect(texts[1]).toBe('T0/C1')
    expect(texts[3]).toBe('T1/C0')
    expect(texts[4]).toBe('T1/C1')
    expect(texts[6]).toBe('T2/C0')
    expect(texts[7]).toBe('T2/C1')
    cleanup()
  })

  it('行复制(1 row × 3 cols)→ HTML 路径 slice 为段落 → 重建后横向填充', () => {
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 9, 11) // T2/C0..T2/C2 (行选 row2 body)

    // 模拟 HTML 路径:3 个段落
    const paragraphs = [
      schema.nodes.paragraph.create(null, schema.text('S0/C0')),
      schema.nodes.paragraph.create(null, schema.text('S0/C1')),
      schema.nodes.paragraph.create(null, schema.text('S0/C2')),
    ]
    const brokenSlice = new Slice(Fragment.from(paragraphs), 0, 0)

    // clipboard text = "S0/C0\tS0/C1\tS0/C2"(1 行 × 3 列)
    const event = makeClipEvent('S0/C0\tS0/C1\tS0/C2')

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, event, brokenSlice)
      return handled
    })

    expect(handled).toBe(true)

    const texts = bodyCellTexts(view)
    // row2 被横向填充
    expect(texts[6]).toBe('S0/C0')
    expect(texts[7]).toBe('S0/C1')
    expect(texts[8]).toBe('S0/C2')
    // 其他行保留
    expect(texts[0]).toBe('T0/C0')
    expect(texts[3]).toBe('T1/C0')
    cleanup()
  })

  it('2×2 矩形复制 → HTML 路径 slice 为段落 → 重建后矩形填充', () => {
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 3, 7) // T0/C0..T1/C1 (2×2 矩形)

    // 模拟 HTML 路径:4 个段落(2×2 = 4 cells)
    const paragraphs = [
      schema.nodes.paragraph.create(null, schema.text('S0/C0')),
      schema.nodes.paragraph.create(null, schema.text('S0/C1')),
      schema.nodes.paragraph.create(null, schema.text('S1/C0')),
      schema.nodes.paragraph.create(null, schema.text('S1/C1')),
    ]
    const brokenSlice = new Slice(Fragment.from(paragraphs), 0, 0)

    // clipboard text = "S0/C0\tS0/C1\nS1/C0\tS1/C1"(2 行 × 2 列)
    const event = makeClipEvent('S0/C0\tS0/C1\nS1/C0\tS1/C1')

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, event, brokenSlice)
      return handled
    })

    expect(handled).toBe(true)

    const texts = bodyCellTexts(view)
    expect(texts[0]).toBe('S0/C0')
    expect(texts[1]).toBe('S0/C1')
    expect(texts[3]).toBe('S1/C0')
    expect(texts[4]).toBe('S1/C1')
    // 矩形外保留
    expect(texts[2]).toBe('T0/C2')
    expect(texts[5]).toBe('T1/C2')
    expect(texts[6]).toBe('T2/C0')
    expect(texts[7]).toBe('T2/C1')
    expect(texts[8]).toBe('T2/C2')
    cleanup()
  })

  it('slice 已有表格结构 → handlePaste 直接交给 tableEditing(不重建)', () => {
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 3, 5) // T0/C0..T0/C2

    // 构造有表格结构的 slice(正常路径)
    const rows = [
      schema.nodes.table_row.create(null, [
        schema.nodes.table_cell.create(null, mkText('X0')),
        schema.nodes.table_cell.create(null, mkText('X1')),
        schema.nodes.table_cell.create(null, mkText('X2')),
      ]),
    ]
    const goodSlice = new Slice(Fragment.from(rows), 1, 1)

    // 即使 clipboard text 为空,有表格结构就不重建
    const event = makeClipEvent('')

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, event, goodSlice)
      return handled
    })

    expect(handled).toBe(true)
    const texts = bodyCellTexts(view)
    expect(texts[0]).toBe('X0')
    expect(texts[1]).toBe('X1')
    expect(texts[2]).toBe('X2')
    cleanup()
  })

  it('非 CellSelection → guard 返回 false,tableEditing 也返回 false(段落 slice)', () => {
    const { view, cleanup } = mount([buildTable(2, 2), schema.node('paragraph')])
    // 光标在 cell 内(非 CellSelection)
    const cells = collectCellPos(view)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, cells[0] + 2),
    ))

    const brokenSlice = new Slice(
      Fragment.from(schema.nodes.paragraph.create(null, schema.text('hello'))),
      0, 0,
    )
    const event = makeClipEvent('hello')

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, event, brokenSlice)
      return handled
    })
    // guard 返回 false(非 CellSelection)→ tableEditing 也返回 false
    // (pastedCells 返回 null + 非 CellSelection → return false)
    // → doPaste 走默认 replaceSelection
    expect(handled).toBe(false)
    cleanup()
  })
})

// ============================================================
//  包含表头的完整列复制粘贴(用户报告的 bug)
//  框选第一列(含表头)Ctrl+C → 选中第二列(含表头)Ctrl+V
//  表头 cell 是 table_header_row > table_header,
//  body cell 是 table_row > table_cell。
//  从 text/plain 重建的 slice 全是 table_cell → header 行替换失败。
// ============================================================

// 收集表格所有 cell 文本(header + body,row-major)。
function allCellTexts(view: EditorView): { type: string; text: string }[] {
  const cells: { type: string; text: string }[] = []
  view.state.doc.descendants((n) => {
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') {
      cells.push({ type: n.type.name, text: n.textContent })
    }
    return true
  })
  return cells
}

describe('包含表头的完整列复制粘贴', () => {
  // 3 col × 3 body 的表格,header + body 共 4 行:
  //   cells[0..2] = header H0,H1,H2
  //   cells[3..5] = body row0 R0/C0,R0/C1,R0/C2
  //   cells[6..8] = body row1 R1/C0,R1/C1,R1/C2
  //   cells[9..11] = body row2 R2/C0,R2/C1,R2/C2
  // 第一列(含表头)= cells[0]..cells[9] (H0..R2/C0)
  // 第二列(含表头)= cells[1]..cells[10] (H1..R2/C1)

  it('text/plain 路径:列复制(含表头)→ 粘贴到另一列(含表头)', () => {
    // 源表:3 col × 3 body,复制第一列(含表头)
    const srcMount = mount([buildTable(3, 3, 'S'), schema.node('paragraph')])
    selectRect(srcMount.view, 0, 9) // H0..R2/C0 (第一列含表头)
    const slice = srcMount.view.state.selection.content()

    // 序列化为 tab 分隔文本
    let text: string | undefined
    srcMount.view.someProp('clipboardTextSerializer' as never, (f: (s: typeof slice) => string) => {
      text = f(slice)
      return text
    })
    // 4 行 × 1 列(表头 + 3 body)
    expect(text).toBe('H0\nS0/C0\nS1/C0\nS2/C0')

    // 目标表:3 col × 3 body
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    // 选中第二列(含表头)
    selectRect(view, 1, 10) // H1..R2/C1

    // 模拟 text/plain 路径:clipboardTextParser → handlePaste
    const $context = view.state.selection.$anchor
    let parsedSlice: Slice | undefined
    view.someProp('clipboardTextParser' as never, (f: (t: string, c: typeof $context, p: boolean, v: EditorView) => Slice) => {
      parsedSlice = f(text!, $context, false, view)
      return parsedSlice
    })
    expect(parsedSlice).toBeDefined()

    const ok = handlePaste(view, {} as ClipboardEvent, parsedSlice!)
    expect(ok).toBe(true)

    const cells = allCellTexts(view)
    // 期望:第二列被第一列内容覆盖
    // header: H0, H0(被覆盖), H2
    // body:   T0/C0, S0/C0, T0/C2
    //         T1/C0, S1/C0, T1/C2
    //         T2/C0, S2/C0, T2/C2
    expect(cells[0].text).toBe('H0')       // col0 header 保留
    expect(cells[1].text).toBe('H0')       // col1 header 被覆盖
    expect(cells[2].text).toBe('H2')       // col2 header 保留
    expect(cells[3].text).toBe('T0/C0')    // col0 body 保留
    expect(cells[4].text).toBe('S0/C0')    // col1 body 被覆盖
    expect(cells[5].text).toBe('T0/C2')    // col2 body 保留
    expect(cells[6].text).toBe('T1/C0')
    expect(cells[7].text).toBe('S1/C0')
    expect(cells[8].text).toBe('T1/C2')
    expect(cells[9].text).toBe('T2/C0')
    expect(cells[10].text).toBe('S2/C0')
    expect(cells[11].text).toBe('T2/C2')
    srcMount.cleanup()
    cleanup()
  })

  it('HTML 路径(有表格结构):列复制(含表头)→ 粘贴到另一列(含表头)', () => {
    // 构造有表格结构的 slice(模拟 HTML 路径 DOMParser 正确解析出的结构)
    // header_row(table_header("H0")) + 3 × table_row(table_cell("S0/C0")等)
    const headerRow = schema.nodes.table_header_row.create(null,
      schema.nodes.table_header.create(null, mkText('H0')))
    const bodyRows = [0, 1, 2].map(r =>
      schema.nodes.table_row.create(null,
        schema.nodes.table_cell.create(null, mkText(`S${r}/C0`))))
    const goodSlice = new Slice(Fragment.from([headerRow, ...bodyRows]), 1, 1)

    // 目标表
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 1, 10) // 第二列(含表头)

    const ok = handlePaste(view, {} as ClipboardEvent, goodSlice)
    expect(ok).toBe(true)

    const cells = allCellTexts(view)
    expect(cells[0].text).toBe('H0')       // col0 header 保留
    expect(cells[1].text).toBe('H0')       // col1 header 被覆盖
    expect(cells[2].text).toBe('H2')       // col2 header 保留
    expect(cells[3].text).toBe('T0/C0')
    expect(cells[4].text).toBe('S0/C0')
    expect(cells[5].text).toBe('T0/C2')
    expect(cells[9].text).toBe('T2/C0')
    expect(cells[10].text).toBe('S2/C0')
    expect(cells[11].text).toBe('T2/C2')
    cleanup()
  })

  it('HTML 路径(无表格结构→重建):列复制(含表头)→ 粘贴到另一列(含表头)', () => {
    // 目标表
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 1, 10) // 第二列(含表头)

    // 模拟 HTML 路径:slice 为段落(无表格结构)
    const paragraphs = [
      schema.nodes.paragraph.create(null, schema.text('H0')),
      schema.nodes.paragraph.create(null, schema.text('S0/C0')),
      schema.nodes.paragraph.create(null, schema.text('S1/C0')),
      schema.nodes.paragraph.create(null, schema.text('S2/C0')),
    ]
    const brokenSlice = new Slice(Fragment.from(paragraphs), 0, 0)

    const event = {
      clipboardData: {
        getData: (mime: string) => mime === 'text/plain' ? 'H0\nS0/C0\nS1/C0\nS2/C0' : '',
      } as DataTransfer,
    } as unknown as ClipboardEvent

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, event, brokenSlice)
      return handled
    })

    expect(handled).toBe(true)

    const cells = allCellTexts(view)
    expect(cells[0].text).toBe('H0')       // col0 header 保留
    expect(cells[1].text).toBe('H0')       // col1 header 被覆盖
    expect(cells[2].text).toBe('H2')       // col2 header 保留
    expect(cells[3].text).toBe('T0/C0')
    expect(cells[4].text).toBe('S0/C0')
    expect(cells[5].text).toBe('T0/C2')
    expect(cells[9].text).toBe('T2/C0')
    expect(cells[10].text).toBe('S2/C0')
    expect(cells[11].text).toBe('T2/C2')
    cleanup()
  })
})

// ============================================================
//  真实 HTML round-trip(模拟 doPaste 的 parseFromClipboard 路径)
//  DOMSerializer 序列化 → innerHTML 解析 → DOMParser.parseSlice(context=$context)
//  验证真实 paste 路径下表头列复制粘贴的行为。
//  关键:DOMParser 用 table_cell context 解析 <tr> 会产出损坏的 slice,
//  handlePaste 必须检测并走 TSV 重建路径。
// ============================================================

describe('真实 HTML round-trip:列复制(含表头)→ DOMParser → handlePaste', () => {
  // 从 CellSelection slice 提取 TSV 文本(模拟 clipboardTextSerializer)
  function sliceToTsv(slice: Slice): string {
    const lines: string[] = []
    for (let i = 0; i < slice.content.childCount; i++) {
      const row = slice.content.child(i)
      const cells: string[] = []
      row.forEach((cell) => { cells.push(cell.textContent) })
      lines.push(cells.join('\t'))
    }
    return lines.join('\n')
  }

  // 模拟 serializeForClipboard + parseFromClipboard 的完整流程
  function simulateParseFromClipboard(
    view: EditorView,
    srcSlice: Slice,
  ): Slice | null {
    const serializer = DOMSerializer.fromSchema(view.state.schema)
    // 1. 序列化 slice content 为 HTML
    const wrap = document.createElement('div')
    wrap.appendChild(serializer.serializeFragment(srcSlice.content))
    const serializedHtml = wrap.innerHTML
    // 2. 模拟 wrapMap 包装 + data-pm-slice
    const html = `<table data-pm-slice="1 1 -2 []"><tbody>${serializedHtml}</tbody></table>`
    // 3. 模拟 readHTML
    const dom = document.createElement('div')
    dom.innerHTML = html
    // 4. 解包 data-pm-slice (wrappers=2 → div > table > tbody)
    let parsedDom: Node = dom
    const sliceDataEl = dom.querySelector('[data-pm-slice]')
    if (sliceDataEl) {
      const m = /^(\d+) (\d+)(?: -(\d+))?/.exec(sliceDataEl.getAttribute('data-pm-slice') || '')
      if (m && m[3]) {
        for (let i = 0; i < +m[3]; i++) {
          const child = (parsedDom as Element).firstElementChild
          if (!child) break
          parsedDom = child
        }
      }
    }
    // 5. DOMParser.parseSlice
    return DOMParser.fromSchema(view.state.schema).parseSlice(parsedDom as Element, {
      preserveWhitespace: true,
      context: view.state.selection.$from,
    })
  }

  // 创建带 clipboardData 的 mock ClipboardEvent
  function mockPasteEvent(plainText: string): ClipboardEvent {
    return {
      clipboardData: { getData: (type: string) => type === 'text/plain' ? plainText : '' },
    } as unknown as ClipboardEvent
  }

  it('列复制(含表头,4 rows × 1 col)→ 粘贴到另一列(含表头)', () => {
    // 源表:3 col × 3 body,复制第一列(含表头)
    const srcMount = mount([buildTable(3, 3, 'S'), schema.node('paragraph')])
    selectRect(srcMount.view, 0, 9) // H0..S2/C0 (第一列含表头)
    const srcSlice = srcMount.view.state.selection.content()
    expect(srcSlice.content.childCount).toBe(4) // header + 3 body

    // 模拟 clipboardTextSerializer 产出的 TSV 文本
    const tsv = sliceToTsv(srcSlice)

    // 目标表:3 col × 3 body
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 1, 10) // 第二列(含表头)

    // 模拟 parseFromClipboard → handlePaste
    const slice = simulateParseFromClipboard(view, srcSlice)
    expect(slice).not.toBeNull()

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, mockPasteEvent(tsv), slice!)
      return handled
    })
    expect(handled).toBe(true)

    const cells = allCellTexts(view)
    expect(cells[0].text).toBe('H0')       // col0 header 保留
    expect(cells[1].text).toBe('H0')       // col1 header 被覆盖
    expect(cells[2].text).toBe('H2')       // col2 header 保留
    expect(cells[3].text).toBe('T0/C0')
    expect(cells[4].text).toBe('S0/C0')
    expect(cells[5].text).toBe('T0/C2')
    expect(cells[9].text).toBe('T2/C0')
    expect(cells[10].text).toBe('S2/C0')
    expect(cells[11].text).toBe('T2/C2')
    srcMount.cleanup()
    cleanup()
  })

  it('列复制(不含表头,3 rows × 1 col)→ 粘贴到 body 列', () => {
    // 源表:3 col × 3 body,复制 col1 的 body(不含表头)
    const srcMount = mount([buildTable(3, 3, 'S'), schema.node('paragraph')])
    selectRect(srcMount.view, 4, 10) // S0/C1..S2/C1 (body 列选)
    const srcSlice = srcMount.view.state.selection.content()
    expect(srcSlice.content.childCount).toBe(3) // 3 body rows only

    // 模拟 clipboardTextSerializer 产出的 TSV 文本
    const tsv = sliceToTsv(srcSlice)

    // 目标表
    const { view, cleanup } = mount([buildTable(3, 3, 'T'), schema.node('paragraph')])
    selectRect(view, 4, 10) // T0/C1..T2/C1 (body 列选,不含表头)

    // 模拟 parseFromClipboard → handlePaste
    const slice = simulateParseFromClipboard(view, srcSlice)
    expect(slice).not.toBeNull()

    let handled = false
    view.someProp('handlePaste', (f: (v: EditorView, e: ClipboardEvent, s: Slice) => boolean | void) => {
      handled = !!f(view, mockPasteEvent(tsv), slice!)
      return handled
    })
    expect(handled).toBe(true)

    const cells = allCellTexts(view)
    expect(cells[1].text).toBe('H1')       // header 保留
    expect(cells[4].text).toBe('S0/C1')    // body 被覆盖
    expect(cells[7].text).toBe('S1/C1')
    expect(cells[10].text).toBe('S2/C1')
    srcMount.cleanup()
    cleanup()
  })
})

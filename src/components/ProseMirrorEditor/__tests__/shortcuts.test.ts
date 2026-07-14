// v0.4.4 快捷键 declarative registry 集成测试
//
// 覆盖:
//   - 注册表可重置 / 重新注册
//   - toggleMarkWithWrap:
//     * 选区非空 → toggle
//     * 选区空 + 未在 mark 内 + 有闭合符 → 插 `**...**` + setStoredMark
//     * 选区空 + 在 mark 内 → removeStoredMark
//     * code_block 内 → noop(黑名单)
//     * linkClick session 内 → 只 setStoredMark,不插包裹符
//   - blockCommands:
//     * setHeading(2) → heading 2;再按一次 setHeading(2) → 退化为段落
//     * setParagraph → paragraph
//     * insertHr → hr 节点
//   - listCommands:wrapIn 系列
//   - tableCommands:insertTable2x2 → 光标进第一个 cell
//   - linkCommands:triggerLinkEdit → 启动 linkClick session

import { describe, expect, it, beforeEach } from 'vitest'
import { EditorState, TextSelection, Plugin } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { linkClickPlugin, linkClickPluginKey } from '../plugins/linkClick'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'
import {
  registerShortcut,
  buildShortcutKeymap,
  getShortcuts,
  _resetShortcutRegistry,
  type ShortcutCommand,
} from '../editor/shortcuts/registry'
import { toggleMarkWithWrap, isMarkActive } from '../editor/shortcuts/commands/markCommands'
import { setHeading, setParagraph, insertHr } from '../editor/shortcuts/commands/blockCommands'
import { wrapInBulletList, wrapInBlockquote, wrapInCodeBlock } from '../editor/shortcuts/commands/listCommands'
import {
  insertTable2x2,
  cmdAddRowAfter,
  cmdAddRowBefore,
  cmdDeleteRow,
  cmdDeleteColumn,
  setCellAlignment,
} from '../editor/shortcuts/commands/tableCommands'
import { CellSelection } from 'prosemirror-tables'
import { createTableResizeCursorPlugin } from '../plugins/tableResizeCursor'
import { triggerLinkEdit } from '../editor/shortcuts/commands/linkCommands'

function mountView(blocks: ReturnType<typeof schema.node>[] = [schema.node('paragraph')], plugins: Plugin[] = [linkClickPlugin, syntaxAutoFormatPlugin]): {
  view: EditorView
  cleanup: () => void
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, blocks)
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins,
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

// ============================================================
//  registry / buildShortcutKeymap
// ============================================================

describe('shortcuts: registry', () => {
  beforeEach(() => {
    _resetShortcutRegistry()
  })

  it('registerShortcut + getShortcuts 双向一致', () => {
    const cmd: ShortcutCommand = () => true
    registerShortcut({ key: 'Mod-x', command: cmd, label: '测试', group: 'system' })
    const list = getShortcuts()
    expect(list.length).toBe(1)
    expect(list[0].key).toBe('Mod-x')
    expect(list[0].command).toBe(cmd)
  })

  it('同名 registerShortcut 覆盖(后注册覆盖前注册,HMR 友好)', () => {
    const cmd1: ShortcutCommand = () => false
    const cmd2: ShortcutCommand = () => true
    registerShortcut({ key: 'Mod-x', command: cmd1, label: 'v1', group: 'system' })
    registerShortcut({ key: 'Mod-x', command: cmd2, label: 'v2', group: 'system' })
    const list = getShortcuts()
    expect(list.length).toBe(1)
    expect(list[0].label).toBe('v2')
  })

  it('_resetShortcutRegistry 清空所有', () => {
    registerShortcut({ key: 'Mod-x', command: () => true, label: 'x', group: 'system' })
    expect(getShortcuts().length).toBe(1)
    _resetShortcutRegistry()
    expect(getShortcuts().length).toBe(0)
  })

  it('buildShortcutKeymap 返回 Plugin 实例', () => {
    registerShortcut({ key: 'Mod-x', command: () => true, label: 'x', group: 'system' })
    const plugin = buildShortcutKeymap()
    // prosemirror-keymap 内部把 keyMap 包成 handleKeyDown function,
    // 暴露在 plugin.props.handleKeyDown
    expect(plugin.props?.handleKeyDown).toBeTypeOf('function')
  })
})

// ============================================================
//  toggleMarkWithWrap
// ============================================================

describe('shortcuts: toggleMarkWithWrap', () => {
  it('选区非空 → toggle strong mark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('hello world')]),
    ])
    // 选区 "hello"
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 1, 6),
    ))
    const cmd = toggleMarkWithWrap(schema.marks.strong, '**')
    cmd(view.state, view.dispatch)
    const para = view.state.doc.firstChild!
    const bold = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find((c: any) => c.text === 'hello')
    expect(bold?.marks.some((m: any) => m.type.name === 'strong')).toBe(true)
    cleanup()
  })

  it('选区空 + 未在 mark 内 → 插 `****` + 光标居中 + setStoredMark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('hi')]),
    ])
    // selection at pos 3 (end of paragraph)
    const cmd = toggleMarkWithWrap(schema.marks.strong, '**')
    cmd(view.state, view.dispatch)
    expect(view.state.doc.textContent).toBe('hi****')
    // 光标在 `hi****` 中间(pos 5)
    expect(view.state.selection.from).toBe(5)
    // storedMarks 包含 strong
    expect(view.state.storedMarks?.some(m => m.type.name === 'strong')).toBe(true)
    cleanup()
  })

  it('选区空 + 已在 strong mark 内 → removeStoredMark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('bold', [schema.marks.strong.create()])]),
    ])
    // 光标在 "bold" 中间
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)))
    expect(isMarkActive(view.state, schema.marks.strong)).toBe(true)
    const cmd = toggleMarkWithWrap(schema.marks.strong, '**')
    cmd(view.state, view.dispatch)
    // 文档未变化(removeStoredMark 不改 doc)
    expect(view.state.doc.textContent).toBe('bold')
    // storedMarks 中 strong 被移除
    expect(view.state.storedMarks?.some(m => m.type.name === 'strong') ?? false).toBe(false)
    cleanup()
  })

  it('code_block 内 → noop(false)', () => {
    const { view, cleanup } = mountView([
      schema.node('code_block', { language: '' }, [schema.text('let x = 1')]),
    ])
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    const cmd = toggleMarkWithWrap(schema.marks.strong, '**')
    const before = view.state.doc.toString()
    const result = cmd(view.state, view.dispatch)
    expect(result).toBe(false)
    expect(view.state.doc.toString()).toBe(before)
    cleanup()
  })

  it('inline code mark 内 → noop(false)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [
        schema.text('code', [schema.marks.code.create()]),
        schema.text(' text'),
      ]),
    ])
    // 光标在 code 文本节点内
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)))
    const cmd = toggleMarkWithWrap(schema.marks.strong, '**')
    expect(cmd(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it('linkClick session 内 → 只 setStoredMark,不插 `**`', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('https://example.com')]),
    ])
    // 启动 linkClick session
    view.dispatch(view.state.tr.setMeta(linkClickPluginKey, {
      type: 'start',
      session: {
        editFrom: 1,
        editTo: view.state.doc.content.size - 1,
        href: 'https://example.com',
        originalSource: '[example](https://example.com)',
      },
    }))
    expect(linkClickPluginKey.getState(view.state)?.session).not.toBeNull()
    const before = view.state.doc.textContent
    const cmd = toggleMarkWithWrap(schema.marks.strong, '**')
    cmd(view.state, view.dispatch)
    // 文档不变(没插 `****`)
    expect(view.state.doc.textContent).toBe(before)
    // storedMarks 有 strong
    expect(view.state.storedMarks?.some(m => m.type.name === 'strong')).toBe(true)
    cleanup()
  })

  it('link mark(closingMarker=null)→ 只 setStoredMark', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('hi')]),
    ])
    const cmd = toggleMarkWithWrap(schema.marks.link, '[', null)
    cmd(view.state, view.dispatch)
    // 文档不变
    expect(view.state.doc.textContent).toBe('hi')
    // storedMarks 有 link
    expect(view.state.storedMarks?.some(m => m.type.name === 'link')).toBe(true)
    cleanup()
  })
})

// ============================================================
//  blockCommands
// ============================================================

describe('shortcuts: blockCommands', () => {
  it('setHeading(2) → heading 2', () => {
    const { view, cleanup } = mountView()
    const cmd = setHeading(schema, 2)
    cmd(view.state, view.dispatch)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('heading')
    expect(block.attrs.level).toBe(2)
    cleanup()
  })

  it('连续两次 setHeading(2) → 第二次退回段落', () => {
    const { view, cleanup } = mountView()
    const cmd = setHeading(schema, 2)
    cmd(view.state, view.dispatch)
    expect(view.state.doc.firstChild!.type.name).toBe('heading')
    cmd(view.state, view.dispatch)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    cleanup()
  })

  it('setParagraph 在 heading 上 → 转 paragraph', () => {
    const { view, cleanup } = mountView([
      schema.node('heading', { level: 1 }, [schema.text('h')]),
    ])
    const cmd = setParagraph(schema)
    cmd(view.state, view.dispatch)
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    cleanup()
  })

  it('insertHr → 插入 hr 节点', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('above')]),
      schema.node('paragraph', null, [schema.text('below')]),
    ])
    // selection at pos between paragraphs (e.g., start of second para)
    const cmd = insertHr(schema)
    cmd(view.state, view.dispatch)
    let foundHr = false
    view.state.doc.descendants((n) => {
      if (n.type.name === 'hr') foundHr = true
    })
    expect(foundHr).toBe(true)
    cleanup()
  })
})

// ============================================================
//  listCommands
// ============================================================

describe('shortcuts: listCommands', () => {
  it('wrapInBulletList → bullet_list + list_item', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('item')]),
    ])
    const cmd = wrapInBulletList(schema)
    cmd(view.state, view.dispatch)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('bullet_list')
    expect(block.firstChild!.type.name).toBe('list_item')
    cleanup()
  })

  it('wrapInBlockquote → blockquote', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('quote')]),
    ])
    const cmd = wrapInBlockquote(schema)
    cmd(view.state, view.dispatch)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('blockquote')
    cleanup()
  })

  it('wrapInCodeBlock → code_block', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('let x = 1')]),
    ])
    const cmd = wrapInCodeBlock(schema)
    cmd(view.state, view.dispatch)
    const block = view.state.doc.firstChild!
    expect(block.type.name).toBe('code_block')
    cleanup()
  })
})

// ============================================================
//  tableCommands
// ============================================================

describe('shortcuts: insertTable2x2', () => {
  it('空 paragraph → 插入 2x2 表格', () => {
    const { view, cleanup } = mountView()
    const cmd = insertTable2x2(schema)
    cmd(view.state, view.dispatch)
    let tableCount = 0
    view.state.doc.descendants((n) => {
      if (n.type.name === 'table') tableCount++
    })
    expect(tableCount).toBe(1)
    cleanup()
  })

  it('插入后光标进第一个 cell 的 paragraph 内', () => {
    const { view, cleanup } = mountView()
    const cmd = insertTable2x2(schema)
    cmd(view.state, view.dispatch)
    const $head = view.state.selection.$head
    // 光标应在某个 cell 的 paragraph 内
    let inCell = false
    for (let d = $head.depth; d > 0; d--) {
      const name = $head.node(d).type.name
      if (name === 'table_header' || name === 'table_cell') {
        inCell = true
        break
      }
    }
    expect(inCell).toBe(true)
    cleanup()
  })

  it('在已有 table 内 → noop', () => {
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, [
        schema.nodes.table_header.create(null, schema.nodes.paragraph.create()),
      ]),
    ])
    const { view, cleanup } = mountView([table])
    const cmd = insertTable2x2(schema)
    const before = view.state.doc.toString()
    const result = cmd(view.state, view.dispatch)
    expect(result).toBe(false)
    expect(view.state.doc.toString()).toBe(before)
    cleanup()
  })
})

// —— 辅助:创建 2x2 表格(1 header + 1 body,各 2 cells) 并挂载 ——
// 表后补一个空 paragraph:一方面反映「编辑器里表后总有段落」的真实场景,
//另一方面让 replaceWith(tablePos, tablePos + table.nodeSize, newTable) 在 splice
//后新表增大时,不会因 range end 超出 doc.content.size 而越界报错。
function mountTable() {
  const headerCells = [
    schema.nodes.table_header.create(null, schema.nodes.paragraph.create()),
    schema.nodes.table_header.create(null, schema.nodes.paragraph.create()),
  ]
  const bodyCells = [
    schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
    schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
  ]
  const table = schema.nodes.table.create(null, [
    schema.nodes.table_header_row.create(null, headerCells),
    schema.nodes.table_row.create(null, bodyCells),
  ])
  const result = mountView([table, schema.nodes.paragraph.create()])
  return { view: result.view, cleanup: result.cleanup }
}

// —— 辅助:找第一个 table_cell (非 header) 的 doc pos ——
function firstBodyCellPos(view: EditorView): number {
  let result = -1
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "table_cell" && result === -1) {
      result = pos
      return false
    }
    return true
  })
  return result
}



describe("shortcuts: table row/column operations", () => {
  it("cmd* 在表格内 → 消费(true)", () => {
    const { view, cleanup } = mountTable()
    const cellPos = firstBodyCellPos(view)
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cellPos + 1)
      )
    )
    // cmdAddRowAfter should succeed (returns true) when cursor is in body row
    const cmd = cmdAddRowAfter(schema)
    expect(cmd(view.state, undefined)).toBe(true)  // dry-run without dispatch
    cleanup()
  })

  it("cmd* 不在表格内 → noop(false)", () => {
    const { view, cleanup } = mountView() // paragraph only
    expect(cmdAddRowAfter(schema)(view.state, view.dispatch)).toBe(false)
    expect(cmdDeleteRow(schema)(view.state, view.dispatch)).toBe(false)
    cleanup()
  })

  it("cmdAddRowAfter 后光标落到新增行第一格 paragraph content start", () => {
    const { view, cleanup } = mountTable()
    const cellPos = firstBodyCellPos(view)
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cellPos + 1)
      )
    )
    // 修改前计数
    let headerRowCountBefore = 0
    let bodyRowCountBefore = 0
    view.state.doc.descendants((n) => {
      if (n.type.name === "table_header_row") headerRowCountBefore++
      if (n.type.name === "table_row") bodyRowCountBefore++
    })
    expect(headerRowCountBefore).toBe(1)
    expect(bodyRowCountBefore).toBe(1)
    const cmd = cmdAddRowAfter(schema)
    cmd(view.state, view.dispatch)
    // 光标深度里应经过 table_row 与 table_cell
    const $head = view.state.selection.$head
    let names: string[] = []
    for (let d = $head.depth; d > 0; d--) names.push($head.node(d).type.name)
    expect(names).toContain("table_row")
    expect(names).toContain("table_cell")
    // 表格应从 1 header + 1 body → 1 header + 2 body
    let headerRowCount = 0
    let bodyRowCount = 0
    view.state.doc.descendants((n) => {
      if (n.type.name === "table_header_row") headerRowCount++
      if (n.type.name === "table_row") bodyRowCount++
    })
    expect(headerRowCount).toBe(1)
    expect(bodyRowCount).toBe(2)
    cleanup()
  })

  it("cmdAddRowBefore 后光标落到新增行第一格 paragraph content start", () => {
    const { view, cleanup } = mountTable()
    const cellPos = firstBodyCellPos(view)
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, cellPos + 1)
      )
    )
    const cmd = cmdAddRowBefore(schema)
    cmd(view.state, view.dispatch)
    const $head = view.state.selection.$head
    let names: string[] = []
    for (let d = $head.depth; d > 0; d--) names.push($head.node(d).type.name)
    expect(names).toContain("table_row")
    expect(names).toContain("table_cell")
    cleanup()
  })

  it("cmdDeleteColumn 后光标落在同行相邻 cell 内(不漂离表格)", () => {
    // 构造 1 header + 1 body,各 3 cell,cell 内 paragraph 含一个文字(TextSelection 要求 inline)
    const headerCells = Array.from({ length: 3 },
      () => schema.nodes.table_header.create(null, schema.nodes.paragraph.create([schema.text("h")])))
    const bodyCells = Array.from({ length: 3 },
      (_, i) => schema.nodes.table_cell.create(null, schema.nodes.paragraph.create([schema.text(String(i + 1))])))
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, headerCells),
      schema.nodes.table_row.create(null, bodyCells),
    ])
    const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
    // 光标放最后一个 cell 的 paragraph 内
    let lastCellPos = -1
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "table_cell") lastCellPos = pos
    })
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, lastCellPos + 2)
    ))
    const cmd = cmdDeleteColumn(schema)
    const ok = cmd(view.state, view.dispatch)
    expect(ok).toBe(true)
    // 删后表格仍存在,且 body row 剩 2 个 cell
    let tableChildCells = 0
    view.state.doc.descendants((n) => {
      if (n.type.name === "table") {
        const row = n.child(1)
        row.forEach(() => tableChildCells++)
      }
    })
    expect(tableChildCells).toBe(2)
    // 光标应仍在 table 内的某个 cell 里(不漂到表外)
    const $head = view.state.selection.$head
    let names: string[] = []
    for (let d = $head.depth; d > 0; d--) names.push($head.node(d).type.name)
    expect(names).toContain("table")
    expect(names).toContain("table_row")
    expect(names).toContain("table_cell")
    cleanup()
  })

  // 辅助:计算 header/body 每行的列数
  function rowCellCounts(view: EditorView): { header: number; bodies: number[] } {
    let header = 0
    const bodies: number[] = []
    view.state.doc.descendants((n) => {
      if (n.type.name === "table_header_row") { let c = 0; n.forEach(() => c++); header = c }
      if (n.type.name === "table_row") { let c = 0; n.forEach(() => c++); bodies.push(c) }
    })
    return { header, bodies }
  }

  it("cmdDeleteColumn 后 header 与 body 列数对齐(用户 bug 场景)", () => {
    // 用户原始场景:3 列表格,删中间列 / 最后列
    const headerCells = Array.from({ length: 3 },
      () => schema.nodes.table_header.create(null, schema.nodes.paragraph.create()))
    const bodyCellsArr = Array.from({ length: 3 }, () => [
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
    ])
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, headerCells),
      ...bodyCellsArr.map((cs) => schema.nodes.table_row.create(null, cs)),
    ])
    // 场景 A:删中间列(col1)
    {
      const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
      let targetCellPos = -1, cnt = 0
      view.state.doc.descendants((n, pos) => {
        if (n.type.name === "table_cell" && cnt === 0) { targetCellPos = pos; cnt++ }
      })
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, targetCellPos + 2)))
      expect(cmdDeleteColumn(schema)(view.state, view.dispatch)).toBe(true)
      const counts = rowCellCounts(view)
      expect(counts.header).toBe(2)
      expect(counts.bodies).toEqual([2, 2, 2])
      cleanup()
    }
    // 场景 B:删最后列(col2)
    {
      const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
      let lastCellPos = -1
      view.state.doc.descendants((n, pos) => {
        if (n.type.name === "table_cell") lastCellPos = pos
      })
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, lastCellPos + 2)))
      expect(cmdDeleteColumn(schema)(view.state, view.dispatch)).toBe(true)
      const counts = rowCellCounts(view)
      expect(counts.header).toBe(2)
      expect(counts.bodies).toEqual([2, 2, 2])
      cleanup()
    }
  })

  it("cmdDeleteRow 删最后一行 → 光标回落到末行 cell 内", () => {
    // 构造 1 header + 3 body
    const headerCells = Array.from({ length: 2 },
      () => schema.nodes.table_header.create(null, schema.nodes.paragraph.create()))
    const bodyCellsArr = Array.from({ length: 3 }, () => [
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
    ])
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, headerCells),
      ...bodyCellsArr.map((cs) => schema.nodes.table_row.create(null, cs)),
    ])
    const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
    // 光标放最后一行的 cell 内
    let lastCellPos = -1
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "table_cell") lastCellPos = pos
    })
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, lastCellPos + 1)
    ))
    const cmd = cmdDeleteRow(schema)
    expect(cmd(view.state, view.dispatch)).toBe(true)
    // 删后剩 2 个 body row
    let bodyRowCount = 0
    view.state.doc.descendants((n) => { if (n.type.name === "table_row") bodyRowCount++ })
    expect(bodyRowCount).toBe(2)
    // 光标应在某个 table_cell 内(不漂到表外)
    const $head = view.state.selection.$head
    let names: string[] = []
    for (let d = $head.depth; d > 0; d--) names.push($head.node(d).type.name)
    expect(names).toContain("table_cell")
    expect(names).toContain("table_row")
    expect(names).toContain("table")
    cleanup()
  })

  it("cmdDeleteRow 删第一行 → 光标落到上移的那行 cell 内", () => {
    const headerCells = Array.from({ length: 2 },
      () => schema.nodes.table_header.create(null, schema.nodes.paragraph.create()))
    const bodyCellsArr = Array.from({ length: 3 }, () => [
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
      schema.nodes.table_cell.create(null, schema.nodes.paragraph.create()),
    ])
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, headerCells),
      ...bodyCellsArr.map((cs) => schema.nodes.table_row.create(null, cs)),
    ])
    const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
    let firstCellPos = -1
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "table_cell" && firstCellPos === -1) firstCellPos = pos
    })
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, firstCellPos + 1)
    ))
    const cmd = cmdDeleteRow(schema)
    expect(cmd(view.state, view.dispatch)).toBe(true)
    let bodyRowCount = 0
    view.state.doc.descendants((n) => { if (n.type.name === "table_row") bodyRowCount++ })
    expect(bodyRowCount).toBe(2)
    const $head = view.state.selection.$head
    let names: string[] = []
    for (let d = $head.depth; d > 0; d--) names.push($head.node(d).type.name)
    expect(names).toContain("table_cell")
    expect(names).toContain("table_row")
    cleanup()
  })
})

describe("shortcuts: tableResizeCursor plugin", () => {
  it("鼠标在 cell 右侧 8px 内 → table 加 class;离开 → 移除", () => {
    const plugin = createTableResizeCursorPlugin()
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, [
        schema.nodes.table_header.create(null, schema.nodes.paragraph.create()),
      ]),
    ])
    const { view, cleanup } = mountView([table], [plugin])
    const tblDom = view.dom.querySelector("table") as HTMLTableElement
    expect(tblDom).toBeTruthy()

    // mock cell rect 右侧 5px → 命中 resize zone
    const cell = tblDom.querySelector("th")!
    cell.getBoundingClientRect = () => ({
      right: 100, left: 0, top: 0, bottom: 20, width: 100, height: 20,
      x: 0, y: 0, toJSON: () => "",
    })
    const moveEvt = new MouseEvent("mousemove", {
      clientX: 95,
      clientY: 10,
      bubbles: true,
    })
    // dispatch 前,事件 handler 通过 plugin.props.handleDOMEvents.mousemove 捕获
    // prosemirror-view 会自动转发 view.dom 上的事件到 handler
    Object.defineProperty(moveEvt, "target", { value: cell })
    // 通过 props.handleDOMEvents 直接调用 handler,绕过 view 的事件路由,
    // 因此需要对 this 上下文做一次 as any 适配
    const domHandlers: any = plugin.props.handleDOMEvents
    const r1 = domHandlers.mousemove(view, moveEvt)
    expect(r1).toBe(false)
    expect(tblDom.classList.contains("velo-table-resize-active")).toBe(true)

    // mouseleave 时移除
    const leaveEvt = new MouseEvent("mouseleave", { bubbles: true })
    domHandlers.mouseleave(view, leaveEvt)
    expect(tblDom.classList.contains("velo-table-resize-active")).toBe(false)

    cleanup()
  })
})

describe("shortcuts: setCellAlignment", () => {
  // 收集整表每列的 alignment,按列优先(外层=列、内层=行,含 header)。
  // 返回 align[colIdx][rowIdx],方便断言"整列生效、其他列不变"。
  function collectAlignByColumn(view: EditorView): string[][] {
    const cols: string[][] = []
    view.state.doc.descendants((n) => {
      if (n.type.name === "table") {
        n.forEach((row) => {
          row.forEach((_cell, _off, colIdx) => {
            if (!cols[colIdx]) cols[colIdx] = []
            cols[colIdx].push((row.child(colIdx).attrs.alignment as string) || "left")
          })
        })
        return false
      }
      return true
    })
    return cols
  }

  // 找第 rowIdx 行(0-based,含 header)第 colIdx 列 cell 的"paragraph content start"位置,
  // 作为 TextSelection 光标落点。沿 table → rowOffset / cellOffset 算绝对位置:
  //   row descendantsPos = tablePos + 1(open token) + rowOffset
  //   cell paragraph content start = row descendantsPos + 1(row open) + cellOffset + 1(cell open)
  // 收集首个 table 的所有 cell 位置,按文档顺序(row-major)。
  // 返回第 index 个 cell 的 descendants pos(open token 前的 gap position)。
  // 注:descendants 回调返回 false 会停止下钻;只在 cell 叶子返回 false 跳过其 paragraph 子树。
  // 收集首个 table 所有 cell 的 descendants pos(open token 前 gap position),按文档顺序(row-major)。
  function collectCellDescendantsPos(view: EditorView): number[] {
    const cells: number[] = []
    view.state.doc.descendants((n, pos) => {
      if (n.type.name === "table_cell" || n.type.name === "table_header") {
        cells.push(pos)
        return false // cell 无需下钻到 paragraph
      }
      return true // doc / table / row 继续下钻
    })
    return cells
  }

  // 把光标放到第 index 个 cell 的 paragraph 内容位置(cellPos+2)。
  function setCursorInCell(view: EditorView, index: number): void {
    const cells = collectCellDescendantsPos(view)
    const cellPos = cells[index]
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, cellPos + 2))
    )
  }
  it("列级对齐 → 光标所在列(header + body)一起变,其他列不变", () => {
    const { view, cleanup } = mountTable() // 1 header + 1 body,各 2 cell
    // cell 文档顺序:h0,h1,b0,b1 → index 2 = body row0 col0
    setCursorInCell(view, 2)

    const result = setCellAlignment("center")(view.state, view.dispatch)
    expect(result).toBe(true)

    const cols = collectAlignByColumn(view)
    // 第 1 列整列(1 header + 1 body)= center;第 2 列不变(默认 left)
    expect(cols[0]).toEqual(["center", "center"])
    expect(cols[1]).toEqual(["left", "left"])
    cleanup()
  })

  it("对齐多行多列的末列 → 仅该列全部行变,两侧列不动", () => {
    // 1 header + 2 body,各 3 cell,各列预设不同 alignment。
    const makeCell = (a: string) =>
      schema.nodes.table_cell.create({ alignment: a }, schema.nodes.paragraph.create())
    const makeHeader = (a: string) =>
      schema.nodes.table_header.create({ alignment: a }, schema.nodes.paragraph.create())
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, [makeHeader("left"), makeHeader("center"), makeHeader("right")]),
      schema.nodes.table_row.create(null, [makeCell("left"), makeCell("center"), makeCell("right")]),
      schema.nodes.table_row.create(null, [makeCell("left"), makeCell("center"), makeCell("right")]),
    ])
    const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
    // cell 文档顺序:h0,h1,h2,b00,b01,b02,b10,b11,b12 → index 8 = body row1 col2(当前 right)
    setCursorInCell(view, 8)

    setCellAlignment("center")(view.state, view.dispatch)

    const cols = collectAlignByColumn(view)
    expect(cols[0]).toEqual(["left", "left", "left"])      // 第 1 列不动
    expect(cols[1]).toEqual(["center", "center", "center"]) // 第 2 列不动(本来就是 center)
    expect(cols[2]).toEqual(["center", "center", "center"]) // 第 3 列整列翻成 center
    cleanup()
  })

  it("不在表格内 → noop(false)", () => {
    const { view, cleanup } = mountView()
    const result = setCellAlignment("center")(view.state, view.dispatch)
    expect(result).toBe(false)
    cleanup()
  })

  // CellSelection 矩形内右键对齐:以右键点中格的 descendants pos 为 anchorPos 传入,
  // 矩形覆盖的所有列一起对齐(选项 A),非覆盖列不动。
  it("CellSelection 矩形内右键对齐 → 覆盖的所有列一起变,非覆盖列不动", () => {
    const makeCell = () => schema.nodes.table_cell.create(null, schema.nodes.paragraph.create())
    const makeHeader = () => schema.nodes.table_header.create(null, schema.nodes.paragraph.create())
    // 1 header + 3 body,各 4 cell。
    const table = schema.nodes.table.create(null, [
      schema.nodes.table_header_row.create(null, [makeHeader(), makeHeader(), makeHeader(), makeHeader()]),
      schema.nodes.table_row.create(null, [makeCell(), makeCell(), makeCell(), makeCell()]),
      schema.nodes.table_row.create(null, [makeCell(), makeCell(), makeCell(), makeCell()]),
      schema.nodes.table_row.create(null, [makeCell(), makeCell(), makeCell(), makeCell()]),
    ])
    const { view, cleanup } = mountView([table, schema.nodes.paragraph.create()])
    const cells = collectCellDescendantsPos(view) // h0..h3,b00..b33,共 16

    // 构造 CellSelection:anchor = b00 (index 4),head = b21 (index 13) → 覆盖 col0, col1 的 3 行。
    const anchorCellPos = cells[4]
    const headCellPos = cells[13]
    const anchor = view.state.doc.resolve(anchorCellPos)
    const head = view.state.doc.resolve(headCellPos)
    view.dispatch(view.state.tr.setSelection(new CellSelection(anchor, head)))

    // 右键点中矩形内 b10 (index 8) → anchorPos = 它的 descendants pos。
    const clickCellPos = cells[8]
    const ok = setCellAlignment("center", clickCellPos)(view.state, view.dispatch)
    expect(ok).toBe(true)

    const cols = collectAlignByColumn(view)
    // col0 / col1 = center(被矩形覆盖); col2 / col3 = left(未覆盖,默认)。
    expect(cols[0]).toEqual(["center", "center", "center", "center"])
    expect(cols[1]).toEqual(["center", "center", "center", "center"])
    expect(cols[2]).toEqual(["left", "left", "left", "left"])
    expect(cols[3]).toEqual(["left", "left", "left", "left"])
    cleanup()
  })
})

// ============================================================
//  linkCommands
// ============================================================

describe('shortcuts: triggerLinkEdit', () => {
  it('空选区 → 插入 [text](url) + 启动 linkClick session', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('hello')]),
    ])
    // 光标在 pos 1
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    triggerLinkEdit(view.state, view.dispatch)
    // 源码应该出现 [text](url)
    expect(view.state.doc.textContent).toContain('[text](url)')
    // linkClick session 启动了
    expect(linkClickPluginKey.getState(view.state)?.session).not.toBeNull()
    cleanup()
  })

  it('选中文本 → 用选中文本作 [text] 部分', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('click here for details')]),
    ])
    // 选中 "here"(pos 7-11)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 7, 11)))
    triggerLinkEdit(view.state, view.dispatch)
    expect(view.state.doc.textContent).toContain('[here](url)')
    expect(linkClickPluginKey.getState(view.state)?.session).not.toBeNull()
    cleanup()
  })

  it('插入的源码不被 syntaxAutoFormat 抢转 link mark(setMeta 防御)', () => {
    const { view, cleanup } = mountView([
      schema.node('paragraph', null, [schema.text('hi')]),
    ])
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    triggerLinkEdit(view.state, view.dispatch)
    // 文档里不应有 link mark —— 源码文字面量还在
    let hasLinkMark = false
    view.state.doc.descendants((n) => {
      if (n.marks.some((m: any) => m.type.name === 'link')) hasLinkMark = true
    })
    expect(hasLinkMark).toBe(false)
    cleanup()
  })
})
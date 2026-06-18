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
import { EditorState, TextSelection } from 'prosemirror-state'
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
import { insertTable2x2 } from '../editor/shortcuts/commands/tableCommands'
import { triggerLinkEdit } from '../editor/shortcuts/commands/linkCommands'

function mountView(blocks: ReturnType<typeof schema.node>[] = [schema.node('paragraph')]): {
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
    plugins: [linkClickPlugin, syntaxAutoFormatPlugin],
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
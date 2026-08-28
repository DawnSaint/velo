import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { splitListItem, liftListItem } from 'prosemirror-schema-list'
import { splitBlock, chainCommands, liftEmptyBlock } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { schema } from '../editor/schema'

// ── 复制 EditorInner.vue 的 codeBlockEnter / codeBlockExit(内部函数不 export) ──
function codeBlockEnter(state: any, dispatch?: any): boolean {
  const { $head } = state.selection
  if ($head.parent.type.name !== 'code_block') return false
  if (dispatch) dispatch(state.tr.insertText('\n'))
  return true
}

function codeBlockExit(state: any, dispatch?: any): boolean {
  const { $head } = state.selection
  if ($head.parent.type.name !== 'code_block') return false
  const end = $head.after()
  const paragraphType = state.schema.nodes.paragraph
  const tr = state.tr.replaceWith(end, end, paragraphType.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1))
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

// 复制 EditorInner.vue 的 splitInListItemNestedBlock(空段落时走 liftEmptyBlock)
function splitInListItemNestedBlock(state: any, dispatch?: any): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const { $from } = selection

  let listItemDepth = -1
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'list_item') {
      listItemDepth = d
      break
    }
  }
  if (listItemDepth < 0) return false

  const directChild = $from.node(listItemDepth + 1)
  if (directChild && directChild.type.name === 'paragraph') return false

  if ($from.parent.content.size === 0) return liftEmptyBlock(state, dispatch)
  return splitBlock(state, dispatch)
}

// 复制 EditorInner.vue 的 shiftEnterExitBlock(blockquote/alert 退出)
function shiftEnterExitBlock(state: any, dispatch?: any): boolean {
  const { $head } = state.selection
  let blockDepth = -1
  for (let d = $head.depth; d > 0; d--) {
    const name = $head.node(d).type.name
    if (name === 'blockquote' || name === 'alert') {
      blockDepth = d
      break
    }
  }
  if (blockDepth < 0) return false
  if ($head.parent.content.size === 0) return liftEmptyBlock(state, dispatch)
  const end = $head.after(blockDepth)
  const paragraphType = state.schema.nodes.paragraph
  const tr = state.tr.replaceWith(end, end, paragraphType.create())
  tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1))
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

// 复制 EditorInner.vue 的 shiftEnterListItem(list_item 内 splitBlock)
function shiftEnterListItem(state: any, dispatch?: any): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const { $from } = selection
  let listItemDepth = -1
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'list_item') {
      listItemDepth = d
      break
    }
  }
  if (listItemDepth < 0) return false
  const directChild = $from.node(listItemDepth + 1)
  if (!directChild || directChild.type.name !== 'paragraph') return false
  return splitBlock(state, dispatch)
}

// 复现 EditorInner.vue 的 Enter / Shift-Enter 链
function makeEnterPlugin() {
  return keymap({
    Enter: chainCommands(
      codeBlockEnter,
      splitListItem(schema.nodes.list_item),
      splitInListItemNestedBlock,
      liftListItem(schema.nodes.list_item),
      liftEmptyBlock,
      splitBlock,
    ),
    'Shift-Enter': chainCommands(
      codeBlockExit,
      shiftEnterExitBlock,
      shiftEnterListItem,
      splitBlock,
    ),
  })
}

function mount(initial: any): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({
    schema,
    doc: initial,
    plugins: [makeEnterPlugin()],
  })
  return new EditorView(host, { state })
}

function setCursorAtEnd(view: EditorView) {
  view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))
}

function dispatchEnter(view: EditorView) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
  view.dom.dispatchEvent(event)
}

function dispatchShiftEnter(view: EditorView) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })
  view.dom.dispatchEvent(event)
}

describe('exit block via Enter / Shift-Enter — blockquote / alert / code_block', () => {
  it('blockquote: 空段落 Enter → 退出 blockquote', () => {
    const doc = schema.node('doc', null, [
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text('a')]),
        schema.node('paragraph', null, []),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(blockquote(paragraph("a")), paragraph)')
    v.destroy()
  })

  it('alert: 空段落 Enter → 退出 alert', () => {
    const doc = schema.node('doc', null, [
      schema.node('alert', { variant: 'note' }, [
        schema.node('paragraph', null, [schema.text('note text')]),
        schema.node('paragraph', null, []),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(alert(paragraph("note text")), paragraph)')
    v.destroy()
  })

  it('blockquote 有内容段落末尾 Enter → 先在 blockquote 内分裂空段落,再 Enter 退出', () => {
    const doc = schema.node('doc', null, [
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text('a')]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(blockquote(paragraph("a"), paragraph))')
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(blockquote(paragraph("a")), paragraph)')
    v.destroy()
  })

  // ── code_block: Enter 只插 \n,Shift-Enter 退出 ──

  it('code_block: Enter → 只插 \\n(不退出)', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('console.log("a")\n')]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    // Enter 只插入 \n,不退出
    expect(v.state.doc.childCount).toBe(1)
    expect(v.state.doc.firstChild?.type.name).toBe('code_block')
    expect(v.state.doc.firstChild?.textContent).toBe('console.log("a")\n\n')
    v.destroy()
  })

  it('code_block: 空 code_block Enter → 只插 \\n(不退出)', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, []),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.childCount).toBe(1)
    expect(v.state.doc.firstChild?.type.name).toBe('code_block')
    expect(v.state.doc.firstChild?.textContent).toBe('\n')
    v.destroy()
  })

  it('code_block: 光标在代码中间 Enter → 插入换行(不退出)', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('console.log("a")')]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 6)))
    dispatchEnter(v)
    expect(v.state.doc.firstChild?.type.name).toBe('code_block')
    expect(v.state.doc.firstChild?.textContent).toBe('conso\nle.log("a")')
    v.destroy()
  })

  it('code_block: Shift-Enter → 退出 code_block(在后面创建段落)', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('console.log("a")')]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    // 应在 code_block 后创建段落
    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(0).type.name).toBe('code_block')
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
    v.destroy()
  })

  it('code_block: 光标在中间 Shift-Enter → 仍退出 code_block', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('abc\ndef')]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)))
    dispatchShiftEnter(v)
    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(0).type.name).toBe('code_block')
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
    v.destroy()
  })

  it('code_block: 空 code_block Shift-Enter → 退出 code_block', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, []),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(code_block, paragraph)')
    v.destroy()
  })

  // ── list_item 内嵌套 block 的退出 ──

  it('list_item > blockquote: 空段落 Enter → 退出 blockquote(留在 list_item 内)', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('item')]),
          schema.node('blockquote', null, [
            schema.node('paragraph', null, [schema.text('quote')]),
            schema.node('paragraph', null, []),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(bullet_list(list_item(paragraph("item"), blockquote(paragraph("quote")), paragraph)))')
    v.destroy()
  })

  it('list_item > alert: 空段落 Enter → 退出 alert(留在 list_item 内)', () => {
    const doc = schema.node('doc', null, [
      schema.node('ordered_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('item')]),
          schema.node('alert', { variant: 'warning' }, [
            schema.node('paragraph', null, [schema.text('warning!')]),
            schema.node('paragraph', null, []),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(ordered_list(list_item(paragraph("item"), alert(paragraph("warning!")), paragraph)))')
    v.destroy()
  })

  // ── 不回归 ──

  it('普通段落: Enter → 正常分裂(无回归)', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello world')]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)))
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(paragraph("hel"), paragraph("lo world"))')
    v.destroy()
  })

  it('顶层空段落: Enter → splitBlock(无法提升)', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchEnter(v)
    expect(v.state.doc.toString()).toBe('doc(paragraph("a"), paragraph, paragraph)')
    v.destroy()
  })
})

// ── Shift-Enter 多场景测试 ──

describe('Shift-Enter: blockquote / alert / list / 普通段落', () => {
  it('blockquote 有内容: Shift-Enter → 退出 blockquote(在后面创建空段落)', () => {
    const doc = schema.node('doc', null, [
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text('quote text')]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(blockquote(paragraph("quote text")), paragraph)')
    v.destroy()
  })

  it('blockquote 空段落: Shift-Enter → 退出 blockquote', () => {
    const doc = schema.node('doc', null, [
      schema.node('blockquote', null, [
        schema.node('paragraph', null, [schema.text('a')]),
        schema.node('paragraph', null, []),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(blockquote(paragraph("a")), paragraph)')
    v.destroy()
  })

  it('alert 有内容: Shift-Enter → 退出 alert', () => {
    const doc = schema.node('doc', null, [
      schema.node('alert', { variant: 'tip' }, [
        schema.node('paragraph', null, [schema.text('tip text')]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(alert(paragraph("tip text")), paragraph)')
    v.destroy()
  })

  it('alert 空段落: Shift-Enter → 退出 alert', () => {
    const doc = schema.node('doc', null, [
      schema.node('alert', { variant: 'note' }, [
        schema.node('paragraph', null, [schema.text('note')]),
        schema.node('paragraph', null, []),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(alert(paragraph("note")), paragraph)')
    v.destroy()
  })

  it('list_item 首层 paragraph: Shift-Enter → splitBlock(产生缩进段落,不创建新 list_item)', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    // 等同 Enter+Backspace: list_item 内追加空段落,不创建新 list_item
    expect(v.state.doc.toString()).toBe('doc(bullet_list(list_item(paragraph("foo"), paragraph)))')
    v.destroy()
  })

  it('ordered_list list_item: Shift-Enter → splitBlock(产生缩进段落)', () => {
    const doc = schema.node('doc', null, [
      schema.node('ordered_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('item')]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(ordered_list(list_item(paragraph("item"), paragraph)))')
    v.destroy()
  })

  it('list_item 光标在中间 Shift-Enter → splitBlock 在中间分裂', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('hello')]),
        ]),
      ]),
    ])
    const v = mount(doc)
    // 光标在 "hel" 之后: doc(0) > bullet_list(0,open) > list_item(1,open) > paragraph(2,open) > text(3..)
    // "hel" 占 pos 3,4,5 → 光标在 pos 6
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 6)))
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(bullet_list(list_item(paragraph("hel"), paragraph("lo"))))')
    v.destroy()
  })

  it('list_item 嵌套 blockquote: Shift-Enter → 退出 blockquote(不留在 list_item)', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('item')]),
          schema.node('blockquote', null, [
            schema.node('paragraph', null, [schema.text('quote')]),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    // shiftEnterExitBlock 先命中:退出 blockquote,在 list_item 内 blockquote 后创建段落
    expect(v.state.doc.toString()).toBe('doc(bullet_list(list_item(paragraph("item"), blockquote(paragraph("quote")), paragraph)))')
    v.destroy()
  })

  it('普通段落: Shift-Enter → 正常换行(splitBlock)', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello world')]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 4)))
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(paragraph("hel"), paragraph("lo world"))')
    v.destroy()
  })

  it('顶层空段落: Shift-Enter → splitBlock(分裂空段落)', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('a')]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    expect(v.state.doc.toString()).toBe('doc(paragraph("a"), paragraph, paragraph)')
    v.destroy()
  })

  it('heading: Shift-Enter → splitBlock(heading 内分裂段落)', () => {
    const doc = schema.node('doc', null, [
      schema.node('heading', { level: 2 }, [schema.text('Title')]),
    ])
    const v = mount(doc)
    setCursorAtEnd(v)
    dispatchShiftEnter(v)
    // splitBlock 在 heading 末尾分裂:第一个仍是 heading,第二个变成 paragraph(PM 默认行为)
    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(0).type.name).toBe('heading')
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
    v.destroy()
  })
})

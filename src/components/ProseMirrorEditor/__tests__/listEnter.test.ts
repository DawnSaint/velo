// 回归:list_item 内按 Enter 应该产生新 list_item(不是新 paragraph)
//
// v0.4.1 收尾时发现:baseKeymap 的 splitBlock 在 list_item 内只创建新 paragraph,
// 用户看到"光标缩进但没标识"。修复方式是在 Enter 链里把 splitListItem 排在
// splitBlock 之前,用户 list_item 时命中 splitListItem,非列表时仍走 splitBlock。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { splitListItem, liftListItem } from 'prosemirror-schema-list'
import { splitBlock, chainCommands } from 'prosemirror-commands'
import { schema } from '../editor/schema'

// 复现 EditorInner.vue 的 Enter 链
function makeEnterCmd() {
  return chainCommands(
    splitListItem(schema.nodes.list_item),
    liftListItem(schema.nodes.list_item),
    splitBlock,
  )
}

function mount(initial: any, plugins: any[] = []) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({ schema, doc: initial, plugins })
  return new EditorView(host, { state })
}

describe('list item Enter', () => {
  it('splitListItem:在 bullet_list 项尾按 Enter → 新增同 list_item', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
      ]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)))
    const cmd = splitListItem(schema.nodes.list_item)
    expect(cmd(v.state, v.dispatch.bind(v))).toBe(true)

    const list = v.state.doc.firstChild!
    expect(list.type.name).toBe('bullet_list')
    expect(list.childCount).toBe(2)
    expect(list.child(0).firstChild!.textContent).toBe('foo')
    expect(list.child(1).firstChild!.textContent).toBe('')
    // 第二个 list_item 继承 listType / spread 等 attr
    expect(list.child(1).attrs.listType).toBe('bullet')
  })

  it('splitListItem:在 ordered_list 项尾按 Enter → 新增同 list_item,order 不变', () => {
    const doc = schema.node('doc', null, [
      schema.node('ordered_list', { order: 5 }, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('a')]),
        ]),
      ]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)))
    const cmd = splitListItem(schema.nodes.list_item)
    cmd(v.state, v.dispatch.bind(v))

    const list = v.state.doc.firstChild!
    expect(list.type.name).toBe('ordered_list')
    expect(list.attrs.order).toBe(5)
    expect(list.childCount).toBe(2)
  })

  it('空 list_item 按 Enter → 提升为普通 paragraph(退出列表)', () => {
    // v0.4.1 收尾:用户反馈"空 list_item 还想 Enter 产生新 list_item,应该退出"
    // splitListItem 在空 list_item 里 return false,需要 chainCommands 退到
    // liftListItem 把当前项提升出 list。
    const pT = schema.nodes.paragraph
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
        schema.node('list_item', null, [pT.create()]),
      ]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)))
    const enter = makeEnterCmd()
    expect(enter(v.state, v.dispatch.bind(v))).toBe(true)

    // doc 顶层应该是:bullet_list(只有原 'foo' 项) + 1 个 paragraph
    const list = v.state.doc.firstChild!
    expect(list.type.name).toBe('bullet_list')
    expect(list.childCount).toBe(1)
    expect(list.child(0).firstChild!.textContent).toBe('foo')
    // 第二项被 lift 出 list,成顶层 paragraph
    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
  })

  it('非 list_item 的普通段落按 Enter → 走 splitBlock 换行', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('foo')]),
    ])
    const v = mount(doc)
    v.dispatch(v.state.tr.setSelection(TextSelection.atEnd(v.state.doc)))
    const enter = makeEnterCmd()
    expect(enter(v.state, v.dispatch.bind(v))).toBe(true)

    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(0).type.name).toBe('paragraph')
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
  })
})

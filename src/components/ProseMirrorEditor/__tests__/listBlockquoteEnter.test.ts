// 回归:list_item 内嵌套 block(blockquote / alert 等)的 paragraph 中按 Enter
// 应在嵌套 block 内分裂段落,而不是把 list_item 提升出 list(降级)。
//
// Bug 根因:Enter 链中 splitListItem 在嵌套 block 内不匹配
// ($from.node(-1) 是 blockquote 不是 list_item),接下来 liftListItem 的
// blockRange 谓词(首子是 list_item)会匹配到 bullet_list / ordered_list,
// 调 liftOutOfList 把整个 list_item 提升出 list —— 用户感知 "list 降了一级"。
//
// 修复:在 splitListItem 和 liftListItem 之间插入 splitInListItemNestedBlock
// 守卫:光标在 list_item 内的非首层 paragraph(嵌套 block 内)时直接走
// splitBlock,跳过 liftListItem。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { splitListItem, liftListItem } from 'prosemirror-schema-list'
import { splitBlock, chainCommands, liftEmptyBlock } from 'prosemirror-commands'
import { schema } from '../editor/schema'

// 复制 EditorInner.vue 的 splitInListItemNestedBlock(内部函数不 export,
// 用源码副本做测试,与 listEnter.test.ts / listBackspace.test.ts 同款策略)
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

// 复现 EditorInner.vue 的 Enter 链(只取 list 相关 + 守卫 + splitBlock)
function makeEnterCmd() {
  return chainCommands(
    splitListItem(schema.nodes.list_item),
    splitInListItemNestedBlock,
    liftListItem(schema.nodes.list_item),
    liftEmptyBlock,
    splitBlock,
  )
}

function mount(initial: any): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({ schema, doc: initial })
  return new EditorView(host, { state })
}

function setCursorAtEndOf(view: EditorView, text: string) {
  let pos = -1
  view.state.doc.descendants((node, nodePos) => {
    if (node.isText && node.text === text) {
      pos = nodePos + node.nodeSize
    }
    return true
  })
  if (pos < 0) throw new Error(`text "${text}" not found`)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

describe('list_item 内嵌套 block 的 Enter', () => {
  it('list_item > blockquote > paragraph 末尾 Enter → blockquote 内新增段落', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('b')]),
          schema.node('blockquote', null, [
            schema.node('paragraph', null, [schema.text('a')]),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEndOf(v, 'a')

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    // list 结构不变
    const first = v.state.doc.firstChild!
    expect(first.type.name).toBe('bullet_list')
    expect(first.childCount).toBe(1)
    // blockquote 内现在有两个 paragraph
    const li = first.firstChild!
    const bq = li.lastChild!
    expect(bq.type.name).toBe('blockquote')
    expect(bq.childCount).toBe(2)
    expect(bq.child(0).textContent).toBe('a')
    expect(bq.child(1).textContent).toBe('')
    v.destroy()
  })

  it('list_item > alert > paragraph 末尾 Enter → alert 内新增段落', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('b')]),
          schema.node('alert', { variant: 'note' }, [
            schema.node('paragraph', null, [schema.text('a')]),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEndOf(v, 'a')

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    const first = v.state.doc.firstChild!
    expect(first.type.name).toBe('bullet_list')
    expect(first.childCount).toBe(1)
    const alert = first.firstChild!.lastChild!
    expect(alert.type.name).toBe('alert')
    expect(alert.childCount).toBe(2)
    v.destroy()
  })

  it('ordered_list > list_item > blockquote > paragraph 末尾 Enter → 不降级', () => {
    const doc = schema.node('doc', null, [
      schema.node('ordered_list', { order: 1 }, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('b')]),
          schema.node('blockquote', null, [
            schema.node('paragraph', null, [schema.text('a')]),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEndOf(v, 'a')

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    const first = v.state.doc.firstChild!
    expect(first.type.name).toBe('ordered_list')
    expect(first.childCount).toBe(1)
    v.destroy()
  })

  it('list_item > blockquote 内空 paragraph Enter → 不降级', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('b')]),
          schema.node('blockquote', null, [
            schema.node('paragraph', null, []),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    const $pos = v.state.doc.resolve(v.state.doc.content.size - 2)
    v.dispatch(v.state.tr.setSelection(TextSelection.near($pos, -1)))

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    const first = v.state.doc.firstChild!
    expect(first.type.name).toBe('bullet_list')
    expect(first.childCount).toBe(1)
    v.destroy()
  })

  // ── 不回归 ──────────────────────────────────────────────

  it('普通 list_item paragraph 末尾 Enter → 仍新增 list_item', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEndOf(v, 'foo')

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    const list = v.state.doc.firstChild!
    expect(list.type.name).toBe('bullet_list')
    expect(list.childCount).toBe(2)
    expect(list.child(1).firstChild!.textContent).toBe('')
    v.destroy()
  })

  it('空 list_item Enter → 仍退出列表', () => {
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

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    const list = v.state.doc.firstChild!
    expect(list.type.name).toBe('bullet_list')
    expect(list.childCount).toBe(1)
    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
    v.destroy()
  })

  it('嵌套列表 list_item > bullet_list > list_item > paragraph 末尾 Enter → split 嵌套项', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('outer')]),
          schema.node('bullet_list', null, [
            schema.node('list_item', null, [
              schema.node('paragraph', null, [schema.text('inner')]),
            ]),
          ]),
        ]),
      ]),
    ])
    const v = mount(doc)
    setCursorAtEndOf(v, 'inner')

    makeEnterCmd()(v.state, v.dispatch.bind(v))

    const outerLi = v.state.doc.firstChild!.firstChild!
    const nestedList = outerLi.lastChild!
    expect(nestedList.type.name).toBe('bullet_list')
    expect(nestedList.childCount).toBe(2)
    v.destroy()
  })
})

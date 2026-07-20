// 回归:列表下方空段落按 Backspace 应直接删除空行,不应 join 到列表生成新 list_item。
//
// 根因:baseKeymap 的 joinBackward 在「空段落 + 前一个兄弟是列表」时会把空段落
// 合并进列表末尾 list_item,等价于扩展列表。用户需要按 3 次 Backspace 才能删掉
// 空行。修复:在 Backspace 链中 baseKeymap 之前插入 emptyParaBeforeListBackspace,
// 拦截此场景直接删除空段落。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, chainCommands } from 'prosemirror-commands'
import { schema } from '../editor/schema'

// 复制 EditorInner.vue 里的 emptyParaBeforeListBackspace(不 export 内部函数,
// 用源码副本做测试,与 listEnter.test.ts 复制 Enter 链同款策略)
function emptyParaBeforeListBackspace(state: any, dispatch?: any): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const $from = selection.$from
  if ($from.parentOffset !== 0) return false
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parent.content.size > 0) return false

  const parentDepth = $from.depth - 1
  if (parentDepth < 0) return false
  const paraIndex = $from.index(parentDepth)
  if (paraIndex === 0) return false

  const parent = $from.node(parentDepth)
  const prevSibling = parent.child(paraIndex - 1)
  if (prevSibling.type.name !== 'bullet_list' && prevSibling.type.name !== 'ordered_list') {
    return false
  }

  if (dispatch) {
    const tr = state.tr
    const paraStart = $from.before($from.depth)
    const paraEnd = paraStart + $from.parent.nodeSize
    tr.delete(paraStart, paraEnd)
    const $pos = tr.doc.resolve(Math.min(paraStart, tr.doc.content.size))
    tr.setSelection(TextSelection.near($pos, -1))
    dispatch(tr)
  }
  return true
}

// 复现 Backspace 链(只含 emptyParaBeforeListBackspace + baseKeymap)
const backspaceCmd = chainCommands(emptyParaBeforeListBackspace, baseKeymap['Backspace'])

function mount(doc: any): EditorView {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = EditorState.create({ schema, doc })
  return new EditorView(host, { state })
}

/** 把光标放到 doc 最后一个 block 的内容开头(适用于空段落)。 */
function selectStartOfLastBlock(view: EditorView) {
  const doc = view.state.doc
  const lastChild = doc.lastChild!
  // before(0) = 0(doc 开头);这里要的是最后一个子节点的内部起点
  const lastChildPos = doc.content.size - lastChild.nodeSize
  const contentStart = lastChildPos + 1 // 跳过 open token
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, contentStart)))
}

describe('列表下方空段落 Backspace', () => {
  it('bullet_list 下方空段落 → 删除空段落,不扩展列表', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
      ]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)

    expect(backspaceCmd(v.state, v.dispatch.bind(v))).toBe(true)

    // 空段落应被删除,doc 只剩 bullet_list
    expect(v.state.doc.childCount).toBe(1)
    expect(v.state.doc.child(0).type.name).toBe('bullet_list')
    expect(v.state.doc.child(0).childCount).toBe(1) // 列表项数量不变
    expect(v.state.doc.child(0).child(0).firstChild!.textContent).toBe('foo')
    v.destroy()
  })

  it('ordered_list 下方空段落 → 删除空段落,不扩展列表', () => {
    const doc = schema.node('doc', null, [
      schema.node('ordered_list', { order: 1 }, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('bar')]),
        ]),
      ]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)

    expect(backspaceCmd(v.state, v.dispatch.bind(v))).toBe(true)

    expect(v.state.doc.childCount).toBe(1)
    expect(v.state.doc.child(0).type.name).toBe('ordered_list')
    expect(v.state.doc.child(0).childCount).toBe(1)
    v.destroy()
  })

  it('列表下方空段落后面还有内容 → 只删空段落,后续内容保留', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
      ]),
      schema.node('paragraph', null, []),
      schema.node('paragraph', null, [schema.text('after')]),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)
    // selectStartOfLastBlock 放的是最后一个 block("after"),不对
    // 需要放到中间的空段落上
    const bulletList = v.state.doc.child(0)
    const emptyParaPos = bulletList.nodeSize + 1 // after bullet_list, inside empty para
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, emptyParaPos)))

    expect(backspaceCmd(v.state, v.dispatch.bind(v))).toBe(true)

    // doc: bullet_list + paragraph("after")
    expect(v.state.doc.childCount).toBe(2)
    expect(v.state.doc.child(0).type.name).toBe('bullet_list')
    expect(v.state.doc.child(1).type.name).toBe('paragraph')
    expect(v.state.doc.child(1).textContent).toBe('after')
    v.destroy()
  })

  it('多列表项 + 空段落 → 列表项数量不变', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('a')]),
        ]),
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('b')]),
        ]),
      ]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)

    expect(backspaceCmd(v.state, v.dispatch.bind(v))).toBe(true)

    expect(v.state.doc.childCount).toBe(1)
    expect(v.state.doc.child(0).type.name).toBe('bullet_list')
    expect(v.state.doc.child(0).childCount).toBe(2) // 列表项数量不变
    v.destroy()
  })

  it('空段落前面不是列表(普通段落) → 不拦截', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('foo')]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)

    // emptyParaBeforeListBackspace 应返回 false(前一个兄弟是 paragraph 不是 list)
    expect(emptyParaBeforeListBackspace(v.state, undefined)).toBe(false)
    v.destroy()
  })

  it('空段落前面是 heading → 不拦截(headingToParagraph 已在链前处理)', () => {
    const doc = schema.node('doc', null, [
      schema.node('heading', { level: 2 }, [schema.text('Title')]),
      schema.node('paragraph', null, []),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)

    expect(emptyParaBeforeListBackspace(v.state, undefined)).toBe(false)
    v.destroy()
  })

  it('列表下方非空段落开头 → 不拦截(走 joinBackward 合并内容)', () => {
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('foo')]),
        ]),
      ]),
      schema.node('paragraph', null, [schema.text('bar')]),
    ])
    const v = mount(doc)
    selectStartOfLastBlock(v)

    expect(emptyParaBeforeListBackspace(v.state, undefined)).toBe(false)
    v.destroy()
  })

  it('空段落前面是嵌套列表(list_item 内) → 拦截,删除空段落', () => {
    // 嵌套场景:外层 list_item 内有 paragraph + bullet_list + 空段落
    const doc = schema.node('doc', null, [
      schema.node('bullet_list', null, [
        schema.node('list_item', null, [
          schema.node('paragraph', null, [schema.text('outer')]),
          schema.node('bullet_list', null, [
            schema.node('list_item', null, [
              schema.node('paragraph', null, [schema.text('inner')]),
            ]),
          ]),
          schema.node('paragraph', null, []),
        ]),
      ]),
    ])
    const v = mount(doc)
    // 把光标放到空段落上:它在 list_item 的最后一个子节点
    // 用 resolve + TextSelection.near 安全定位到空段落
    const $end = v.state.doc.resolve(v.state.doc.content.size - 1) // 空段落 close 前
    // 往前找空段落的内容位置
    v.dispatch(v.state.tr.setSelection(TextSelection.near($end, -1)))

    expect(emptyParaBeforeListBackspace(v.state, v.dispatch.bind(v))).toBe(true)

    // 空段落被删除,list_item 只剩 paragraph("outer") + bullet_list
    const li = v.state.doc.child(0).child(0)
    expect(li.childCount).toBe(2)
    expect(li.child(0).textContent).toBe('outer')
    expect(li.child(1).type.name).toBe('bullet_list')
    v.destroy()
  })
})

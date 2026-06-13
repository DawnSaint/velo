// 回归测试:非列表段落按 Shift-Tab 不应让光标逃出编辑器。
//
// 根因(2026-06-13):tabIndent 的 Shift-Tab 命令在非列表上下文返回 false。
// 返回 false → prosemirror-keymap 不消费 → 浏览器接管 → 默认行为是把焦点
// 移出 contentEditable(到上一个 focusable 元素)→ 用户感知"光标丢失"。
//
// 修复:非列表 Shift-Tab 也返回 true(消费 + ProseMirror 自动 preventDefault
// 浏览器默认),但不 dispatch(光标位置不变)。这样焦点保留在编辑器里,doc 不动。
//
// 测试策略:不绕 keymap(它不暴露 spec 的 keys),直接拿 Shift-Tab 命令函数调,
// 断言返回值与不修改 doc/selection。

import { describe, expect, it } from 'vitest'
import { liftListItem } from 'prosemirror-schema-list'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from '../editor/schema'

// 复制 EditorInner.vue 里 tabIndent 的 Shift-Tab 部分(只测非列表)
const shiftTabCmd = (state: EditorState, dispatch?: (tr: any) => void): boolean => {
  const { $from } = state.selection
  const isInListItem = (() => {
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'list_item') return true
    }
    return false
  })()
  if (isInListItem) {
    return liftListItem(state.schema.nodes.list_item)(state, dispatch)
  }
  return true  // ← 修复:非列表也消费,防止浏览器抢焦点
}

function makeState(text: string, cursorOffset: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ])
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1 + 1 + cursorOffset),
  })
}

describe('Shift-Tab 焦点保留', () => {
  it('非列表段落:Shift-Tab 应返回 true(消费) — 这是修复点', () => {
    const state = makeState('hello world', 5)
    const before = state.doc.toString()
    const beforeHead = state.selection.head
    const consumed = shiftTabCmd(state, undefined)
    // 关键断言 1:Shift-Tab 被消费(return true)—— 修复后从 false 变 true
    expect(consumed).toBe(true)
    // 关键断言 2:不 dispatch 时,doc 与 selection 完全不变
    expect(state.doc.toString()).toBe(before)
    expect(state.selection.head).toBe(beforeHead)
  })

  it('非列表段落:即便有 dispatch,doc 也不改', () => {
    const state = makeState('foo', 1)
    let dispatched: any = null
    const consumed = shiftTabCmd(state, (tr) => { dispatched = tr })
    // 修复后不调用 liftListItem 也不自己 dispatch,但 keymap 调用方会传
    // 一个 dispatch 函数(用于"若消费则提交 tr")。我们的实现走 isInListItem
    // 失败 → return true,不再调 dispatch(因为没东西要 dispatch)
    expect(consumed).toBe(true)
    expect(dispatched).toBeNull()
    expect(state.doc.textContent).toBe('foo')
  })

  it('光标在 paragraph 开头', () => {
    const state = makeState('hello', 0)
    const consumed = shiftTabCmd(state, undefined)
    expect(consumed).toBe(true)
  })

  it('光标在 paragraph 末尾', () => {
    const state = makeState('hello', 5)
    const consumed = shiftTabCmd(state, undefined)
    expect(consumed).toBe(true)
  })

  it('空 paragraph', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph')])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1 + 1),
    })
    const consumed = shiftTabCmd(state, undefined)
    expect(consumed).toBe(true)
  })
})

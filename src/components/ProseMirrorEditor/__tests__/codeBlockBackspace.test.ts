// 回归:在 code_block 第一个位置按 Backspace,必须严格隔离 ——
//
//   1. 代码块有内容    → 吞掉事件,什么都不动(不允许影响外面)
//   2. 代码块无内容    → 转回 paragraph(等价"删除空代码块")
//   3. parentOffset !== 0 → 放行,baseKeymap 删一个字符
//
// 之前的 bug:baseKeymap 的 joinBackward 在 parentOffset === 0 时:
//   - 上一行是空 paragraph → 把上一行删掉
//   - 上一行有内容 → 把代码块降级合并到上一段
// 用户感知"代码块内的 Backspace 把外面的内容/行吃了"。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from '../editor/schema'
import { codeBlockBackspaceCommand } from '../syntax/block/codeBlock'

function stateWithDoc(doc: any, head: number): EditorState {
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, head),
  })
}

describe('codeBlockBackspaceCommand', () => {
  it('代码块有内容 + 光标在首位:吞掉事件,doc 不变', () => {
    // doc:paragraph("foo") + code_block("bar")
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('foo')]),
      schema.node('code_block', null, [schema.text('bar')]),
    ])
    // paragraph 'foo' nodeSize = 5(open + 3 + close);code_block 起 pos 5,内部 offset 0 = pos 6
    const head = 1 + 3 + 1 + 1 // 6
    const state = stateWithDoc(doc, head)

    let dispatched = false
    const ret = codeBlockBackspaceCommand(state, () => { dispatched = true })
    expect(ret).toBe(true)            // 必须返回 true 阻断后续命令
    expect(dispatched).toBe(false)    // 不能 dispatch 任何 tr
  })

  it('上一行有内容,代码块也有内容 + 首位 Backspace:不影响上一行', () => {
    // 同上场景,但显式断言 dispatch 没跑过 → 上一行 paragraph 不会被破坏
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello')]),
      schema.node('code_block', null, [schema.text('x')]),
    ])
    const codeBlockInnerStart = 1 + 5 + 1 + 1 // 8
    const state = stateWithDoc(doc, codeBlockInnerStart)

    let nextState: EditorState | null = null
    codeBlockBackspaceCommand(state, (tr) => { nextState = state.apply(tr) })
    expect(nextState).toBeNull() // 没 dispatch
  })

  it('上一行是空 paragraph,代码块有内容 + 首位 Backspace:不删除空行', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph'), // 空段
      schema.node('code_block', null, [schema.text('y')]),
    ])
    const codeBlockInnerStart = 1 + 0 + 1 + 1 // 3
    const state = stateWithDoc(doc, codeBlockInnerStart)

    let dispatched = false
    const ret = codeBlockBackspaceCommand(state, () => { dispatched = true })
    expect(ret).toBe(true)
    expect(dispatched).toBe(false)
    // 用户预期:上面的空行还在,代码块也还在
    expect(state.doc.childCount).toBe(2)
  })

  it('代码块为空 + 首位 Backspace:转回 paragraph', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('keep')]),
      schema.node('code_block'), // 空代码块
    ])
    // 空 code_block 内部首位 = paragraph 起 1 + 4 + 1 + 1 = 7
    const head = 1 + 4 + 1 + 1
    const state = stateWithDoc(doc, head)

    let next: EditorState | null = null
    const ret = codeBlockBackspaceCommand(state, (tr) => { next = state.apply(tr) })
    expect(ret).toBe(true)
    expect(next).not.toBeNull()
    expect(next!.doc.childCount).toBe(2)
    expect(next!.doc.child(0).type.name).toBe('paragraph')
    expect(next!.doc.child(0).textContent).toBe('keep')
    expect(next!.doc.child(1).type.name).toBe('paragraph') // code_block → paragraph
    expect(next!.doc.child(1).textContent).toBe('')
  })

  it('parentOffset !== 0:放行(返回 false,让 baseKeymap 接管)', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('abc')]),
    ])
    // code_block 内 offset 2 = 在 'b' 和 'c' 之间
    const head = 1 + 2
    const state = stateWithDoc(doc, head)

    expect(codeBlockBackspaceCommand(state, () => {})).toBe(false)
  })

  it('光标不在 code_block 内:放行', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('foo')]),
    ])
    const state = stateWithDoc(doc, 1) // paragraph 内首位
    expect(codeBlockBackspaceCommand(state, () => {})).toBe(false)
  })

  it('非 empty selection:放行', () => {
    const doc = schema.node('doc', null, [
      schema.node('code_block', null, [schema.text('abc')]),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1, 3), // 选中 'ab'
    })
    expect(codeBlockBackspaceCommand(state, () => {})).toBe(false)
  })
})

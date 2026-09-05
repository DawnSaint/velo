// math_block 降级为 paragraph 时光标位置:
//
//   $$
//   xxx \
//   $$        ← 删掉任意一个 $ → 降级为 paragraph
//             ← 空行(原本就在)
//
// 之前:降级后光标跳到下方空行。
// 现在:光标留在降级后 paragraph 内,对应删除位置的等价文本位置。
//
// content = "$$\nxxx \\\n$$" (12 字符)
// pos:    1=$ 2=$ 3=\n 4=x 5=x 6=x 7=" " 8=\ 9=\ 10=\n 11=$ 12=$
// 13=close tag 14=para open 15=para content

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { mathEditPlugin } from '../nodes/MathNodeViews'

beforeEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

const CONTENT = '$$\nxxx \\\\\n$$'

function mountView(cursorPos: number): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const doc = schema.node('doc', null, [
    schema.node('math_block', null, [schema.text(CONTENT)]),
    schema.node('paragraph'),
  ])
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, cursorPos),
    plugins: [mathEditPlugin],
  })
  return new EditorView(container, { state })
}

describe('math_block 降级后光标位置', () => {
  it('删首行第一个 $ → 光标留在删除点之后', () => {
    // 光标在 pos 3(首行第二个 $ 之前), Backspace 删 [2,3)
    const view = mountView(3)
    view.dispatch(view.state.tr.delete(2, 3))

    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(0).textContent).toBe('$\nxxx \\\\\n$$')
    // 光标在 pos 2(删除点)
    expect(view.state.selection.from).toBe(2)

    view.destroy()
  })

  it('删首行第二个 $ → 光标留在删除点之后', () => {
    // 光标在 pos 4(\n 之前), Backspace 删 [3,4)
    const view = mountView(4)
    view.dispatch(view.state.tr.delete(3, 4))

    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(0).textContent).toBe('$$xxx \\\\\n$$')
    expect(view.state.selection.from).toBe(3)

    view.destroy()
  })

  it('删末行倒数第二个 $ → 光标留在删除点之后', () => {
    // 光标在 pos 12(末行第二个 $ 之前), Backspace 删 [11,12)
    const view = mountView(12)
    view.dispatch(view.state.tr.delete(11, 12))

    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(0).textContent).toBe('$$\nxxx \\\\\n$')
    expect(view.state.selection.from).toBe(11)

    view.destroy()
  })

  it('删末行最后一个 $ → 光标留在删除点之后', () => {
    // 光标在 pos 13(close tag 之前), Backspace 删 [12,13)
    const view = mountView(13)
    view.dispatch(view.state.tr.delete(12, 13))

    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(0).textContent).toBe('$$\nxxx \\\\\n$')
    expect(view.state.selection.from).toBe(12)

    view.destroy()
  })

  it('math_inline 降级后光标同样留在原位', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    // math_inline: $x^2$ → 删掉尾 $ → $x^2 → 降级为普通 text
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('math_inline', null, [schema.text('$x^2$')]),
        schema.text(' after'),
      ]),
    ])
    // 光标在 math_inline 内尾 $ 之后 (pos = 1 + 1 + 5 = 7)
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 7),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    // 删掉尾 $
    view.dispatch(view.state.tr.delete(6, 7))

    // 降级为普通 text(math_inline 的 text 与后续 text 合并)
    const para = view.state.doc.child(0)
    expect(para.child(0).type.name).toBe('text')
    expect(para.textContent).toBe('$x^2 after')

    // 光标在 paragraph 内,不跳到段落外
    const sel = view.state.selection
    expect(sel.from).toBeGreaterThanOrEqual(1)
    expect(sel.from).toBeLessThanOrEqual(1 + para.content.size)

    view.destroy()
  })
})

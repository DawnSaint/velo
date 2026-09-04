// 块级公式:保留 display/edit 双态。
//   - display 态(光标在外):源码层隐藏,只显示 katex 预览
//   - edit   态(光标在内):显示源码 + 下方预览
// 结构破坏(删 $)时的行为见 mathBlockBrokenFence.test.ts —— 退回普通段落。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { mathEditPlugin, triggerNextMathBlockAutoEdit } from '../nodes/MathNodeViews'

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

describe('math_block $$+Enter 自动进 edit', () => {
  it('创建 math_block 后光标自动进入节点,切到 edit 态', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('$$')]),
      ]),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))

    const $from = view.state.selection.$from
    const mathBlock = schema.nodes.math_block.create(null, schema.text('$$\n\n$$'))
    triggerNextMathBlockAutoEdit(mathBlock)
    view.dispatch(view.state.tr.replaceWith($from.start(), $from.pos, mathBlock))

    await new Promise(r => setTimeout(r, 50))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement | null
    expect(mathBlockEl).not.toBeNull()
    expect(mathBlockEl!.dataset.mode).toBe('edit')
    const source = mathBlockEl!.querySelector('.math-block-source')
    expect(source).not.toBeNull()
    expect(mathBlockEl!.querySelector('textarea')).toBeNull()

    view.destroy()
  })
})

describe('math_block display 态渲染', () => {
  it('有内容的 math_block 在视口内渲染 katex', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text('$$\nx^2\n$$')]),
      schema.node('paragraph'),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 200))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement
    expect(mathBlockEl.dataset.mode).toBe('display')
    expect(mathBlockEl.querySelector('.katex')).not.toBeNull()

    view.destroy()
  })

  it('空 math_block 渲染占位(不走 katex)', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text('$$\n\n$$')]),
      schema.node('paragraph'),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 50))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement
    expect(mathBlockEl.querySelector('.math-empty-placeholder')).not.toBeNull()
    expect(mathBlockEl.querySelector('.katex')).toBeNull()

    view.destroy()
  })

  it('光标进入 math_block 后切到 edit 态,显示 source + 预览', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text('$$\nx^2\n$$')]),
      schema.node('paragraph'),
    ])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, doc.child(0).nodeSize + 1),
      plugins: [mathEditPlugin],
    })
    const view = new EditorView(container, { state })
    await new Promise(r => setTimeout(r, 200))

    const mathBlockEl = view.dom.querySelector('.math-block-node') as HTMLElement
    expect(mathBlockEl.dataset.mode).toBe('display')

    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    view.dom.ownerDocument.dispatchEvent(new Event('selectionchange'))

    expect(mathBlockEl.dataset.mode).toBe('edit')
    const source = mathBlockEl.querySelector('.math-block-source') as HTMLElement
    expect(source.textContent).toBe('$$\nx^2\n$$')

    view.destroy()
  })
})


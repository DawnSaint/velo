// math_block 内 Enter 行为:
//
//   1. 光标在末尾 $$ 之后(content 末尾)→ 跳出 math_block,在后面插入空段落
//      (防止 content 变成 `...$$\n` 被 appendTransaction 降级为 paragraph)
//   2. 光标在公式内容中间 → 只插 \n(保持一个块,同 codeBlockEnter)
//
// 复现场景:完整 math_block `$$\nx^2\n$$`,光标在末尾 $$ 后按 Enter →
//   之前:splitBlock 插入 \n,content 变 `$$\nx^2\n$$\n` → 不匹配 MATH_BLOCK_RE
//         → 整块降级为 paragraph,预览框消失
//   现在:mathBlockEnter 拦截,跳出 math_block 插入空段落,math_block 保持不变

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, splitBlock } from 'prosemirror-commands'
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

/** 复现 EditorInner.vue 的 Enter 链(精简版,含 mathBlockEnter 等价逻辑) */
function makeEnterPlugin() {
  function mathBlockEnter(state: any, dispatch?: any): boolean {
    const { $head } = state.selection
    if ($head.parent.type.name !== 'math_block') return false
    if ($head.parentOffset === $head.parent.content.size) {
      const end = $head.after()
      const paragraphType = state.schema.nodes.paragraph
      const tr = state.tr.replaceWith(end, end, paragraphType.create())
      tr.setSelection(TextSelection.near(tr.doc.resolve(end), 1))
      if (dispatch) dispatch(tr.scrollIntoView())
      return true
    }
    if (dispatch) dispatch(state.tr.insertText('\n'))
    return true
  }
  function codeBlockEnter(state: any, dispatch?: any): boolean {
    const { $head } = state.selection
    if ($head.parent.type.name !== 'code_block') return false
    if (dispatch) dispatch(state.tr.insertText('\n'))
    return true
  }
  return keymap({
    Enter: (state, dispatch) => {
      // 先试 mathBlockEnter,再走 splitBlock 兜底(模拟链式调用)
      if (mathBlockEnter(state, dispatch)) return true
      return splitBlock(state, dispatch)
    },
    'Shift-Enter': codeBlockEnter,
  })
}

function nodeTypes(doc: any): string[] {
  const out: string[] = []
  doc.descendants((n: any, _p: number) => {
    if (n.isTextblock) out.push(n.type.name)
    return true
  })
  return out
}

describe('math_block 内 Enter', () => {
  it('光标在末尾 $$ 之后按 Enter → 跳出 math_block,不降级', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const content = '$$\nx^2\n$$'
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(content)]),
      schema.node('paragraph'),
    ])
    // 光标在 $$ 之后(content 末尾)
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1 + content.length),
      plugins: [makeEnterPlugin(), keymap(baseKeymap), mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // math_block 应该还在
    expect(view.state.doc.child(0).type.name).toBe('math_block')
    expect(view.state.doc.child(0).textContent).toBe('$$\nx^2\n$$')
    // 后面应该有两个 paragraph(原来的 + 新插入的空段落)
    expect(nodeTypes(view.state.doc)).toEqual(['math_block', 'paragraph', 'paragraph'])

    view.destroy()
  })

  it('光标在公式内容中间按 Enter → 只插 \\n,不分裂', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const content = '$$\nx^2\n$$'
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(content)]),
      schema.node('paragraph'),
    ])
    // 光标在 x^2 的 x 之后 (pos 3,即 `$$\nx` 之后)
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3),
      plugins: [makeEnterPlugin(), keymap(baseKeymap), mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // math_block 应该还在,content 多了一个 \n
    expect(view.state.doc.child(0).type.name).toBe('math_block')
    expect(view.state.doc.child(0).textContent).toBe('$$\n\nx^2\n$$')
    expect(nodeTypes(view.state.doc)).toEqual(['math_block', 'paragraph'])

    view.destroy()
  })

  it('末尾 $$ 后 Enter 不产生降级:后续段落不被吞', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const content = '$$\nxxx \\\\\n$$'
    const doc = schema.node('doc', null, [
      schema.node('math_block', null, [schema.text(content)]),
      schema.node('paragraph', null, [schema.text('next')]),
    ])
    // 光标在末尾 $$ 之后
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1 + content.length),
      plugins: [makeEnterPlugin(), keymap(baseKeymap), mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    // math_block 保持不变,不被降级
    expect(view.state.doc.child(0).type.name).toBe('math_block')
    expect(view.state.doc.child(0).textContent).toBe('$$\nxxx \\\\\n$$')
    // 'next' 段落仍在
    const texts: string[] = []
    view.state.doc.forEach((n: any) => texts.push(n.textContent))
    expect(texts).toContain('next')

    view.destroy()
  })
})

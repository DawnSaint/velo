// 用户主诉场景:
//
//   $$
//   xxx \
//   $        ← 在 $ 后输入一个 $，段落文本变成 $$\nxxx \\\n$$
//
// 期望:段落 → math_block 转换，出现预览块。
// 之前:无视发生，需切源码模式 / 切 tab 再回来才解析。
//
// 根因:syntaxAutoFormat 的 block syntax 中没有检测 `$$\n...\n$$` 围栏的
// 检测器。dollarEnterCmd 只在 `$$` + Enter 时触发，不覆盖"段落中直接形成
// 完整围栏"的场景。

import { afterEach, beforeEach, describe, expect, it, beforeAll } from 'vitest'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { mathEditPlugin } from '../nodes/MathNodeViews'
import { syntaxAutoFormatPlugin } from '../plugins/syntaxAutoFormat'
import {
  registerBlockSyntax,
  registerInlineSyntax,
  _resetSyntaxRegistry,
} from '../editor/syntaxRegistry'
import { mathBlockSyntax } from '../syntax/block/mathBlock'
import { inlineMathSyntax } from '../syntax/inline/inlineMath'

beforeAll(() => {
  _resetSyntaxRegistry()
  registerBlockSyntax(mathBlockSyntax)
  registerInlineSyntax(inlineMathSyntax)
})

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

function nodeTypes(doc: any): string[] {
  const out: string[] = []
  doc.descendants((n: any, _p: number) => {
    if (n.isTextblock) out.push(n.type.name)
    return true
  })
  return out
}

describe('段落中 $$\\n...\\n$$ → math_block 实时转换', () => {
  it('在段落中逐行输入完整围栏后转换为 math_block', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph')]),
      plugins: [syntaxAutoFormatPlugin, mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    // 模拟用户输入:$$ + Shift-Enter + xxx \\ + Shift-Enter + $$ + 最后一个 $
    // 用 insertText 逐步输入,hard_break 用 schema.nodes.hardbreak 插入

    // 输入 $$
    view.dispatch(view.state.tr.insertText('$$'))
    // 光标在末尾(pos 3)
    // 插入 hard_break(Shift-Enter)
    view.dispatch(view.state.tr.insertText('\n'))
    // 输入 xxx \\
    view.dispatch(view.state.tr.insertText('xxx \\\\'))
    // 插入 hard_break
    view.dispatch(view.state.tr.insertText('\n'))
    // 输入 $ (此时段落文本为 $$\nxxx \\\n$，不匹配)
    view.dispatch(view.state.tr.insertText('$'))
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')

    // 输入最后一个 $ → 触发转换
    view.dispatch(view.state.tr.insertText('$'))

    // 应该已经变成 math_block
    expect(view.state.doc.firstChild!.type.name).toBe('math_block')
    expect(view.state.doc.firstChild!.textContent).toBe('$$\nxxx \\\\\n$$')

    await new Promise(r => setTimeout(r, 50))

    // NodeView 应该存在
    const mathBlockEl = view.dom.querySelector('.math-block-node')
    expect(mathBlockEl).not.toBeNull()

    view.destroy()
  })

  it('未闭合围栏($$\\nxxx\\n$)不触发转换', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph')]),
      plugins: [syntaxAutoFormatPlugin, mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    view.dispatch(view.state.tr.insertText('$$'))
    view.dispatch(view.state.tr.insertText('\n'))
    view.dispatch(view.state.tr.insertText('xxx'))
    view.dispatch(view.state.tr.insertText('\n'))
    view.dispatch(view.state.tr.insertText('$'))

    // 仍然是 paragraph
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph')
    expect(view.state.doc.firstChild!.textContent).toBe('$$\nxxx\n$')

    view.destroy()
  })

  it('粘贴完整围栏文本 $$\\n\\n$$ 也触发转换', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph')]),
      plugins: [syntaxAutoFormatPlugin, mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    // 模拟粘贴 $$\n\n$$ 整段(空 content)
    // \n 在段落里会变成 hard_break
    view.dispatch(view.state.tr.insertText('$$\n\n$$'))

    expect(view.state.doc.firstChild!.type.name).toBe('math_block')
    expect(view.state.doc.firstChild!.textContent).toBe('$$\n\n$$')

    await new Promise(r => setTimeout(r, 50))

    const mathBlockEl = view.dom.querySelector('.math-block-node')
    expect(mathBlockEl).not.toBeNull()

    view.destroy()
  })

  it('转换后 math_block 不被降级 appendTransaction 回退', () => {
    // mathEditPlugin 的 appendTransaction 会检查 math_block content 是否合法;
    // 合法格式 $$\n...\n$$ 不应被降级。
    const container = document.createElement('div')
    document.body.appendChild(container)
    const state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph')]),
      plugins: [syntaxAutoFormatPlugin, mathEditPlugin],
    })
    const view = new EditorView(container, { state })

    view.dispatch(view.state.tr.insertText('$$\nx^2\n$$'))

    expect(view.state.doc.firstChild!.type.name).toBe('math_block')
    expect(nodeTypes(view.state.doc)).toEqual(['math_block'])

    view.destroy()
  })
})

// markdownPastePlugin 集成测试
//
// 覆盖:
//  - 用户报告的核心 bug:paste `## H + blank + **strong**` 不被合并
//  - 多段 markdown(heading + paragraph + list + code_block) → 各自独立成段
//  - code_block 内粘贴 → 走 inCode fallback(行为不变)
//  - 空文本 / 仅空白 → return null 不报错
//  - 扩展节点(mermaid / footnote)粘贴

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { markdownPastePlugin } from '../plugins/markdownPastePlugin'
import { toMarkdown } from '../editor/markdownIO'

// clipboardTextParser 的签名是 `(this: P, text, $context, plain, view) => Slice`。
// 测试要拿 parser 直接调用 → 用 Function.prototype.call 显式传 this,
// 绕过 TS 类型对 this context 的检查。
function getParser(): NonNullable<NonNullable<typeof markdownPastePlugin.props>['clipboardTextParser']> {
  return markdownPastePlugin.props!.clipboardTextParser!
}

function mountView(initial?: { type: string, content?: string }): {
  view: EditorView
  cleanup: () => void
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  let doc
  if (initial?.type === 'paragraph') {
    doc = schema.node('doc', null, [
      schema.node('paragraph', null, initial.content ? [schema.text(initial.content)] : []),
    ])
  }
  else if (initial?.type === 'code_block') {
    doc = schema.node('doc', null, [
      schema.node('code_block', { language: '' }, []),
    ])
  }
  else {
    doc = schema.node('doc', null, [schema.node('paragraph')])
  }
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [markdownPastePlugin],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

/**
 * 模拟 ProseMirror clipboard 流程:取 plugin 的 clipboardTextParser,
 * 用同一份输入和当前 selection 的 $from 跑一遍,把返回 Slice 用
 * tr.replaceSelection 插入。这覆盖 plugin 拿到 text + context 的完整路径,
 * 不依赖浏览器的 clipboardData。
 */
function paste(view: EditorView, text: string, plain = false) {
  const parser = getParser()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const slice = (parser as any).call(markdownPastePlugin, text, view.state.selection.$from, plain, view) as ReturnType<typeof parser> | null
  expect(slice).not.toBeNull()
  view.dispatch(view.state.tr.replaceSelection(slice!))
}

describe('markdownPastePlugin: 核心 bug 回归', () => {
  it('paste "## H + blank + **strong**" → heading + paragraph(strong)各自独立', () => {
    const { view, cleanup } = mountView()
    paste(view, '## 执行摘要 (TL;DR)\n\n**结论：不换。**')
    const doc = view.state.doc
    // doc 结构应该是 doc(heading, paragraph(strong)) 两个 top-level block
    expect(doc.childCount).toBe(2)
    expect(doc.child(0).type.name).toBe('heading')
    expect(doc.child(0).attrs.level).toBe(2)
    expect(doc.child(0).textContent).toBe('执行摘要 (TL;DR)')
    expect(doc.child(1).type.name).toBe('paragraph')
    const p = doc.child(1)
    let foundStrong = false
    p.forEach((c) => {
      if (c.marks.some(m => m.type.name === 'strong')) foundStrong = true
    })
    expect(foundStrong).toBe(true)
    // toMarkdown round-trip 保留原 markdown 结构
    const md = toMarkdown(doc)
    expect(md).toContain('## 执行摘要 (TL;DR)')
    expect(md).toContain('**结论：不换。**')
    expect(md).not.toContain('TL;DR**')
    cleanup()
  })
})

describe('markdownPastePlugin: 多段 paste', () => {
  it('heading + paragraph + list 多段 → 三段独立', () => {
    const { view, cleanup } = mountView()
    paste(view, '# Title\n\nPara line.\n\n- item 1\n- item 2')
    const doc = view.state.doc
    expect(doc.childCount).toBe(3)
    expect(doc.child(0).type.name).toBe('heading')
    expect(doc.child(1).type.name).toBe('paragraph')
    expect(doc.child(2).type.name).toBe('bullet_list')
    cleanup()
  })

  it('含 mermaid fence 解析为 mermaid 节点', () => {
    const { view, cleanup } = mountView()
    paste(view, '```mermaid\ngraph TD\n  A-->B\n```')
    const doc = view.state.doc
    expect(doc.childCount).toBe(1)
    expect(doc.child(0).type.name).toBe('mermaid')
    cleanup()
  })

  it('含 fenced code 解析为 code_block', () => {
    const { view, cleanup } = mountView()
    paste(view, '```js\nconst x = 1\n```')
    const doc = view.state.doc
    expect(doc.childCount).toBe(1)
    expect(doc.child(0).type.name).toBe('code_block')
    expect((doc.child(0) as unknown as { attrs: { language: string } }).attrs.language).toBe('js')
    cleanup()
  })
})

describe('markdownPastePlugin: code_block 内粘贴', () => {
  it('光标在 code_block 内 → return null(走 ProseMirror 默认 inCode 分支)', () => {
    const { view, cleanup } = mountView({ type: 'code_block' })
    const parser = getParser()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slice = (parser as any).call(markdownPastePlugin, 'const x = 1\nconst y = 2', view.state.selection.$from, false, view)
    expect(slice).toBeNull() // 让 inCode fallback 接管
    cleanup()
  })

  it('光标在 mermaid 等 code 类容器内 → 同样 return null', () => {
    // mermaid 节点本身就是 spec.code,验证 schema.spec.code 字段判断覆盖它
    const mermaid = schema.nodes.mermaid.create({ value: '' })
    const doc = schema.node('doc', null, [mermaid])
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
      plugins: [markdownPastePlugin],
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view2 = new EditorView(host, { state })
    const parser = getParser()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slice = (parser as any).call(markdownPastePlugin, 'graph TD\n  A-->B', view2.state.selection.$from, false, view2)
    expect(slice).toBeNull()
    view2.destroy()
    host.remove()
  })
})

describe('markdownPastePlugin: 边界 / 异常', () => {
  it('空字符串 → return null', () => {
    const { view, cleanup } = mountView()
    const parser = getParser()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slice = (parser as any).call(markdownPastePlugin, '', view.state.selection.$from, false, view)
    expect(slice).toBeNull()
    cleanup()
  })

  it('仅空白 → return null', () => {
    const { view, cleanup } = mountView()
    const parser = getParser()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slice = (parser as any).call(markdownPastePlugin, '   \n\n  \t', view.state.selection.$from, false, view)
    expect(slice).toBeNull()
    cleanup()
  })

  it('plain (Shift+paste) 仍走 fromMarkdown —— Velo 是 md 编辑器,plain 仍是 md', () => {
    const { view, cleanup } = mountView()
    const parser = getParser()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slice = (parser as any).call(markdownPastePlugin, '## x', view.state.selection.$from, true, view)
    expect(slice).not.toBeNull()
    cleanup()
  })

  it('扩展节点:含 highlight mark `==xx==`', () => {
    const { view, cleanup } = mountView()
    paste(view, '这是 ==重要== 文本。')
    const doc = view.state.doc
    expect(doc.childCount).toBe(1)
    const para = doc.child(0)
    let foundHighlight = false
    para.forEach((c) => {
      if (c.marks.some(m => m.type.name === 'highlight')) foundHighlight = true
    })
    expect(foundHighlight).toBe(true)
    cleanup()
  })

  it('含 table / footnote definition', () => {
    const { view, cleanup } = mountView()
    paste(view, '| a | b |\n| - | - |\n| 1 | 2 |\n\nSee note[^x].\n\n[^x]: Hi.')
    const doc = view.state.doc
    expect(doc.childCount).toBe(3)
    expect(doc.child(0).type.name).toBe('table')
    expect(doc.child(1).type.name).toBe('paragraph')
    expect(doc.child(2).type.name).toBe('footnote_definition')
    cleanup()
  })
})
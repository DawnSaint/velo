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
import { DOMParser, DOMSerializer } from 'prosemirror-model'
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

  it('含 mermaid fence 解析为 code_block lang=mermaid(v0.4.6+;MermaidDecoration widget 渲染 SVG)', () => {
    const { view, cleanup } = mountView()
    paste(view, '```mermaid\ngraph TD\n  A-->B\n```')
    const doc = view.state.doc
    expect(doc.childCount).toBe(1)
    expect(doc.child(0).type.name).toBe('code_block')
    expect((doc.child(0) as unknown as { attrs: { language: string } }).attrs.language).toBe('mermaid')
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
     
    const slice = (parser as any).call(markdownPastePlugin, 'const x = 1\nconst y = 2', view.state.selection.$from, false, view)
    expect(slice).toBeNull() // 让 inCode fallback 接管
    cleanup()
  })

  it('光标在 code_block { language: "mermaid" } 等 code 类容器内 → 同样 return null', () => {
    // v0.4.6+ mermaid 走 code_block { language: 'mermaid' },spec.code 字段判断覆盖它
    const cb = schema.nodes.code_block.create({ language: 'mermaid' }, [schema.text('graph TD\n  A-->B')])
    const doc = schema.node('doc', null, [cb])
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
     
    const slice = (parser as any).call(markdownPastePlugin, '', view.state.selection.$from, false, view)
    expect(slice).toBeNull()
    cleanup()
  })

  it('仅空白 → return null', () => {
    const { view, cleanup } = mountView()
    const parser = getParser()
     
    const slice = (parser as any).call(markdownPastePlugin, '   \n\n  \t', view.state.selection.$from, false, view)
    expect(slice).toBeNull()
    cleanup()
  })

  it('plain (Shift+paste) 仍走 fromMarkdown —— Velo 是 md 编辑器,plain 仍是 md', () => {
    const { view, cleanup } = mountView()
    const parser = getParser()
     
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

// 脚注剪贴板 HTML round-trip 回归(parseDOM priority)
//
// 复现路径:复制 footnote_reference → serializeForClipboard 走 DOMSerializer
// (toDOM,含 data-type)→ 剪贴板 text/html = <sup data-type="footnote_reference">;
// 粘贴时 parseFromClipboard 有 html → asText=false → DOMParser.fromSchema HTML
// 路径。superscript mark 的 parseDOM `sup` 是通配规则,与 footnote_reference 的
// `sup[data-type="footnote_reference"]` 冲突;schemaRules 同 priority(默认 50)时
// mark 排在 node 前 → matchTag 先命中 superscript mark → 脚注被吞成上标文本。
// footnote_reference parseDOM 设 priority:100 后 node 规则优先命中,脚注原样还原。
describe('footnote_reference 剪贴板 HTML round-trip(parseDOM priority)', () => {
  it('serialize → DOMParser.parseSlice 还原为 footnote_reference(非 superscript mark 文本)', () => {
    const fnRef = schema.nodes.footnote_reference.create(null, [schema.text('1')])
    const para = schema.node('paragraph', null, [fnRef])

    // 1. DOMSerializer 序列化(同 serializeForClipboard 路径,走 toDOM 而非 NodeView)
    const serializer = DOMSerializer.fromSchema(schema)
    const wrap = document.createElement('div')
    wrap.appendChild(serializer.serializeFragment(schema.node('doc', null, [para]).content))
    const html = wrap.innerHTML
    // HTML 必须带 data-type(来自 schema toDOM),否则 parseDOM 根本无法匹配 footnote_reference
    expect(html).toContain('data-type="footnote_reference"')

    // 2. DOMParser.parseSlice 回解析(同 parseFromClipboard 的 HTML 路径)
    const dom = document.createElement('div')
    dom.innerHTML = html
    const slice = DOMParser.fromSchema(schema).parseSlice(dom)

    // 3. 解析结果应是 footnote_reference 节点,而非带 superscript mark 的普通文本
    const top = slice.content.firstChild!
    expect(top.type.name).toBe('paragraph')
    expect(top.childCount).toBe(1)
    const child = top.child(0)
    expect(child.type.name).toBe('footnote_reference')
    expect(child.textContent).toBe('1')
    // 被吞成上标时 child 会是 text 节点且带 superscript mark —— 两条断言同时守住
    expect(child.marks.some(m => m.type.name === 'superscript')).toBe(false)
  })
})
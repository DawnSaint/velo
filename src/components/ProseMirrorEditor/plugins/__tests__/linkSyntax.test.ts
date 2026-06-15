// link syntax 集成测试 —— 覆盖 linkSyntax(syntax/inline/link.ts)经
// syntaxAutoFormatPlugin 调度后的所有用户场景。
//
// 合并自原 linkInputRule.test.ts(单字触发)+ linkAutoFormat.test.ts(粘贴 /
// 中间编辑补回 / 链接末尾输入不吸附 / 不重复转换)。
//
// linkClickPlugin 一并挂上,用于测"编辑态 session 范围跳过"的契约 ——
// 但当前用例不直接进编辑态(不可在 jsdom 环境模拟单击),靠框架默认行为兜底。

import { describe, expect, it, beforeAll } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../../editor/schema'
import { linkClickPlugin } from '../linkClick'
import { syntaxAutoFormatPlugin } from '../syntaxAutoFormat'
import { registerInlineSyntax, _resetSyntaxRegistry } from '../../editor/syntaxRegistry'
import { linkSyntax } from '../../syntax/inline/link'

beforeAll(() => {
  _resetSyntaxRegistry()
  registerInlineSyntax(linkSyntax)
})

function mountView(docText: string): { view: EditorView, cleanup: () => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, docText ? [schema.text(docText)] : []),
  ])
  const state = EditorState.create({
    schema,
    doc,
    selection: TextSelection.atEnd(doc),
    plugins: [linkClickPlugin, syntaxAutoFormatPlugin],
  })
  const view = new EditorView(host, { state })
  return { view, cleanup: () => { view.destroy(); host.remove() } }
}

describe('linkSyntax: 单字触发', () => {
  it('"[CommonMark](https://commonmark.org)" 紧贴光标 → 替换为带 link mark 的 text', () => {
    const { view, cleanup } = mountView('')
    const source = '[CommonMark](https://commonmark.org)'
    view.dispatch(view.state.tr.insertText(source, 1))

    const para = view.state.doc.firstChild!
    expect(para.childCount).toBe(1)
    const child = para.firstChild!
    expect(child.type.name).toBe('text')
    expect(child.text).toBe('CommonMark')
    const linkMark = child.marks.find(m => m.type.name === 'link')
    expect(linkMark).toBeDefined()
    expect(linkMark!.attrs.href).toBe('https://commonmark.org')
    cleanup()
  })

  it('空 text "[](url)" 不转换', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[](url)', 1))
    expect(view.state.doc.textContent).toBe('[](url)')
    cleanup()
  })

  it('空 url "[x]()" 不转换', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[x]()', 1))
    expect(view.state.doc.textContent).toBe('[x]()')
    cleanup()
  })

  it('regex:跨行 [text\\n](url) 不匹配', () => {
    const matched = /\[([^\]\n]+)\]\(([^()\s]+)\)/.exec('para[a\nb](url)')
    expect(matched).toBeNull()
  })

  it('regex:url 含空格不匹配', () => {
    const matched = /\[([^\]\n]+)\]\(([^()\s]+)\)/.exec('[x](u rl)')
    expect(matched).toBeNull()
  })
})

describe('linkSyntax: 粘贴 / 中间编辑 / 不吸附', () => {
  it('粘贴整段含 [text](url) → 自动转换为 link mark', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('See [CommonMark](https://commonmark.org).', 1))

    const para = view.state.doc.firstChild!
    const linkText = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.text === 'CommonMark')
    expect(linkText).toBeDefined()
    expect(linkText!.marks.find(m => m.type.name === 'link')?.attrs.href).toBe('https://commonmark.org')
    expect(view.state.doc.textContent).toBe('See CommonMark.')
    cleanup()
  })

  it('删除链接末尾的 ) 再补回 → 自动重新转换', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[X](https://x.com)', 1))
    expect(view.state.doc.textContent).toBe('X')

    const para = view.state.doc.firstChild!
    const paraStart = 1
    const paraEnd = paraStart + para.content.size
    view.dispatch(view.state.tr.replaceWith(paraStart, paraEnd, schema.text('[Y](https://y.com')))
    expect(view.state.doc.textContent).toBe('[Y](https://y.com')

    const insertPos = view.state.doc.firstChild!.content.size + 1
    view.dispatch(view.state.tr.insertText(')', insertPos))

    expect(view.state.doc.textContent).toBe('Y')
    const newPara = view.state.doc.firstChild!
    const linkChild = newPara.firstChild!
    expect(linkChild.text).toBe('Y')
    expect(linkChild.marks.find(m => m.type.name === 'link')?.attrs.href).toBe('https://y.com')
    cleanup()
  })

  it('链接末尾输入 → 新字符不带 link mark', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[X](https://x.com)', 1))
    expect(view.state.doc.textContent).toBe('X')

    const para = view.state.doc.firstChild!
    const linkEnd = 1 + para.content.size
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, linkEnd)))

    view.dispatch(view.state.tr.insertText('Z'))

    expect(view.state.doc.textContent).toBe('XZ')
    const newPara = view.state.doc.firstChild!
    expect(newPara.childCount).toBe(2)
    const link = Array.from({ length: newPara.childCount }, (_, i) => newPara.child(i))
      .find(c => c.text === 'X')
    const tail = Array.from({ length: newPara.childCount }, (_, i) => newPara.child(i))
      .find(c => c.text === 'Z')
    expect(link?.marks.find(m => m.type.name === 'link')).toBeDefined()
    expect(tail?.marks.find(m => m.type.name === 'link')).toBeUndefined()
    cleanup()
  })

  it('已带 link mark 的文本不被重复转换', () => {
    const { view, cleanup } = mountView('')
    view.dispatch(view.state.tr.insertText('[X](https://x.com)', 1))
    const docBefore = view.state.doc.toString()

    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)))

    expect(view.state.doc.toString()).toBe(docBefore)
    cleanup()
  })
})

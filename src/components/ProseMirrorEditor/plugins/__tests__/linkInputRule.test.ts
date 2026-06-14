// 回归测试:[text](url) 实时键入 → text + link mark
//
// 根因:markdownIO 只走外部 markdown 解析,EditorView 实时键入不经过 unified
// pipeline。手动敲完 [text](url) 必须靠 prosemirror-inputrules 转换。
//
// 同 inlineMathInputRule 的测试形状,但直接 import linkInputRule(不复制实现)。

import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { schema } from '../../editor/schema'
import { linkInputRule } from '../linkClick'

// InputRule 的 handler 字段在公开类型里不导出 —— 同 inlineMathInputRule.test.ts 的处理
function applyRule(state: EditorState, match: RegExpMatchArray, start: number, end: number): Transaction | null {
  // @ts-expect-error InputRule 内部字段不在公开类型
  return linkInputRule.handler(state, match, start, end) ?? null
}

function stateWithText(text: string, cursorOffset: number): EditorState {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text(text)]),
  ])
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1 + cursorOffset),
  })
}

describe('linkInputRule', () => {
  it('"[CommonMark](https://commonmark.org)" 紧贴光标 → 替换为带 link mark 的 text', () => {
    const source = '[CommonMark](https://commonmark.org)'
    const state = stateWithText(source, source.length)
    const tr = applyRule(state, [source, 'CommonMark', 'https://commonmark.org'], 1, 1 + source.length)
    expect(tr).not.toBeNull()

    const para = tr!.doc.firstChild!
    expect(para.childCount).toBe(1)
    const child = para.firstChild!
    expect(child.type.name).toBe('text')
    expect(child.text).toBe('CommonMark')
    const linkMark = child.marks.find(m => m.type.name === 'link')
    expect(linkMark).toBeDefined()
    expect(linkMark!.attrs.href).toBe('https://commonmark.org')
  })

  it('空 text 不转换', () => {
    // 实际 regex 不会匹配 [](url),但显式校验防 future regression
    const state = stateWithText('para[](url)', 11)
    const match = ['[](url)', '', 'url'] as unknown as RegExpMatchArray
    const tr = applyRule(state, match, 1 + 4, 1 + 11)
    expect(tr).toBeNull()
  })

  it('空 url 不转换', () => {
    const state = stateWithText('para[x]()', 9)
    const match = ['[x]()', 'x', ''] as unknown as RegExpMatchArray
    const tr = applyRule(state, match, 1 + 4, 1 + 9)
    expect(tr).toBeNull()
  })

  it('regex:跨行 [text\\n](url) 不匹配', () => {
    // text 内含换行不应触发(应该交给段落分隔)
    const matched = /\[([^\]\n]+)\]\(([^()\s]+)\)$/.exec('para[a\nb](url)')
    expect(matched).toBeNull()
  })

  it('regex:url 含空格不匹配', () => {
    // url 字段不能含空格(GFM 行为一致)
    const matched = /\[([^\]\n]+)\]\(([^()\s]+)\)$/.exec('[x](u rl)')
    expect(matched).toBeNull()
  })
})
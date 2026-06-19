import { describe, expect, it } from 'vitest'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'
import { EditorState } from 'prosemirror-state'
import { tocSyntax } from '../syntax/block/toc'

describe('TOC', () => {
  // === markdownIO round-trip ===
  it('round-trip: standalone [TOC]', () => {
    const doc = fromMarkdown('[TOC]', schema)
    const block = doc.firstChild
    expect(block?.type.name).toBe('toc')
    const back = toMarkdown(doc)
    expect(back.trim()).toBe('[TOC]')
  })

  it('round-trip: [TOC] with surrounding blank lines', () => {
    const md = 'hello\n\n[TOC]\n\nworld'
    const doc = fromMarkdown(md, schema)
    expect(doc.childCount).toBe(3)
    expect(doc.child(1).type.name).toBe('toc')
    const back = toMarkdown(doc)
    expect(back.trim()).toBe('hello\n\n[TOC]\n\nworld')
  })

  it('round-trip: [TOC] with leading/trailing whitespace', () => {
    const md = '  [TOC]  '
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('toc')
    const back = toMarkdown(doc)
    expect(back.trim()).toBe('[TOC]')
  })

  it('negative: inline [TOC] in paragraph does not convert', () => {
    const md = 'See [TOC] for details.'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('paragraph')
  })

  it('negative: lowercase [toc] does not convert', () => {
    const md = '[toc]'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('paragraph')
    const back = toMarkdown(doc)
    expect(back.trim()).not.toBe('[TOC]')
  })

  it('negative: [TOC] with trailing text does not convert', () => {
    const md = '[TOC] here'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('paragraph')
  })

  it('round-trip: multiple [TOC] markers in one doc', () => {
    const md = '# H1\n\n[TOC]\n\n## H2\n\n[TOC]\n\n### H3'
    const doc = fromMarkdown(md, schema)
    const tocBlocks = doc.children.filter(c => c.type.name === 'toc')
    expect(tocBlocks.length).toBe(2)
    const back = toMarkdown(doc)
    const tocCount = (back.match(/\[TOC\]/g) || []).length
    expect(tocCount).toBe(2)
  })

  // === syntaxAutoFormat 实时键入路径 ===

  it('tocSyntax.apply converts paragraph([TOC]) to toc via replaceRangeWith', () => {
    // 构造 doc:h1 + paragraph([TOC]) + h2
    // paragraph 在位置 8(open tag),text [TOC] 在 9-13,close tag 在 14
    const doc = schema.node('doc', null, [
      schema.node('heading', { level: 1 }, [schema.text('H1')]),
      schema.node('paragraph', null, [schema.text('[TOC]')]),
      schema.node('heading', { level: 2 }, [schema.text('H2')]),
    ])

    const state = EditorState.create({ doc, schema })
    const tr = state.tr

    // blockStart = paragraph content start = 9(paraPos 8 + 1)
    const blockStart = 9
    // 用 regex.exec 生成合法的 RegExpMatchArray 类型
    const match = /^\[TOC\]\s*$/.exec('[TOC]') as RegExpMatchArray
    const result = tocSyntax.apply(tr, {
      schema,
      blockStart,
      blockEnd: 14,
      match,
    })

    expect(result).toBe(true)
    expect(tr.doc.childCount).toBe(3)
    expect(tr.doc.child(1).type.name).toBe('toc')
    expect(tr.doc.child(1).childCount).toBe(0) // toc 无内容
  })
})

import { describe, expect, it } from 'vitest'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'

describe('Frontmatter', () => {
  // === fromMarkdown: 解析 ===

  it('fromMarkdown: basic frontmatter → frontmatter node', () => {
    const md = '---\ntitle: Hello\ndate: 2026-07-10\n---\n\n# Heading'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('frontmatter')
    expect(doc.firstChild?.textContent).toBe('title: Hello\ndate: 2026-07-10')
    expect(doc.child(1).type.name).toBe('heading')
  })

  it('fromMarkdown: frontmatter with tags array', () => {
    const md = '---\ntags:\n  - markdown\n  - velo\n---\n\nbody text'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('frontmatter')
    expect(doc.firstChild?.textContent).toContain('tags:')
    expect(doc.firstChild?.textContent).toContain('- markdown')
  })

  it('fromMarkdown: no frontmatter → doc starts with block', () => {
    const md = '# Heading\n\nbody'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('heading')
  })

  it('fromMarkdown: frontmatter only (no body)', () => {
    const md = '---\ntitle: Only\n---'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('frontmatter')
    // doc content 'frontmatter? block+' 要求 frontmatter 后至少一个 block,
    // fromMarkdown 自动补一个空 paragraph
    expect(doc.childCount).toBe(2)
    expect(doc.child(1).type.name).toBe('paragraph')
  })

  it('fromMarkdown: --- not at doc start is thematicBreak, not frontmatter', () => {
    const md = 'text\n\n---\n\nmore text'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('paragraph')
    // --- 在正文中间 → hr 节点
    const hrNode = doc.children.find(c => c.type.name === 'hr')
    expect(hrNode).toBeDefined()
  })

  // === toMarkdown: 序列化 ===

  it('toMarkdown: frontmatter → ---\n...\n---', () => {
    const doc = schema.node('doc', null, [
      schema.node('frontmatter', null, [schema.text('title: Hello')]),
      schema.node('heading', { level: 1 }, [schema.text('Heading')]),
    ])
    const md = toMarkdown(doc)
    expect(md).toContain('---\ntitle: Hello\n---')
    expect(md).toContain('# Heading')
  })

  // === round-trip ===

  it('round-trip: basic frontmatter', () => {
    const md = '---\ntitle: Hello\ndate: 2026-07-10\n---\n\n# Heading\n\nbody'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(back.trim()).toBe(md.trim())
  })

  it('round-trip: frontmatter with complex YAML', () => {
    const md = '---\ntitle: Test\ntags:\n  - a\n  - b\nauthor:\n  name: Velo\n---\n\nContent here.'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(back.trim()).toBe(md.trim())
  })

  it('round-trip: frontmatter only', () => {
    // frontmatter 无正文时 fromMarkdown 补一个空 paragraph;
    // toMarkdown 输出 `---\n...\n---\n\n`(尾部空段 = 一个空行)
    const md = '---\ntitle: Only\n---'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(back.trim()).toBe('---\ntitle: Only\n---')
  })

  it('round-trip: empty frontmatter', () => {
    const md = '---\n---\n\ntext'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('frontmatter')
    const back = toMarkdown(doc)
    expect(back.trim()).toBe('---\n---\n\ntext')
  })

  it('round-trip: double round-trip stability', () => {
    const md = '---\ntitle: Hello\n---\n\n# H1\n\nbody'
    const doc1 = fromMarkdown(md, schema)
    const md1 = toMarkdown(doc1)
    const doc2 = fromMarkdown(md1, schema)
    const md2 = toMarkdown(doc2)
    expect(md2).toBe(md1)
  })

  // === doc content 约束 ===

  it('schema: doc content allows frontmatter? block+', () => {
    // 只有 block(无 frontmatter)也应合法
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('hello')]),
    ])
    expect(doc.type.validContent(doc.content)).toBe(true)
  })

  it('schema: frontmatter can only be first child', () => {
    // frontmatter 在第二个位置不合法 —— schema.node 会 throw
    expect(() => {
      schema.node('doc', null, [
        schema.node('paragraph', null, [schema.text('hello')]),
        schema.node('frontmatter', null, [schema.text('title: X')]),
      ])
    }).toThrow()
  })
})

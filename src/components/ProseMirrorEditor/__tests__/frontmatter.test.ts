import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'
import {
  frontmatterFenceKind,
  isFrontmatterFenceLine,
  isFrontmatterFenceSpaceTrigger,
  frontmatterEnterCommand,
} from '../syntax/block/frontmatter'

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

  // === toml frontmatter: +++ 分隔符 ===

  it('fromMarkdown: toml frontmatter(+++)→ frontmatter 节点(lang=toml)', () => {
    const md = '+++\ntitle = "Hello"\ndate = 2026-07-10\n+++\n\n# Heading'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('frontmatter')
    expect(doc.firstChild?.attrs.lang).toBe('toml')
    expect(doc.firstChild?.textContent).toBe('title = "Hello"\ndate = 2026-07-10')
    expect(doc.child(1).type.name).toBe('heading')
  })

  it('fromMarkdown: +++ 不在文档首行 → 不解析为 frontmatter(无 closing fence 回退)', () => {
    // remark-frontmatter 只在文档起始位置识别 frontmatter;正文中的 +++ 不构成 fence。
    // 该场景下 fromMarkdown 不产生 frontmatter 节点(走普通 paragraph)。
    const md = 'text\n\n+++\n\nmore text'
    const doc = fromMarkdown(md, schema)
    expect(doc.firstChild?.type.name).toBe('paragraph')
  })

  it('toMarkdown: toml frontmatter → +++ 分隔符', () => {
    const doc = schema.node('doc', null, [
      schema.node('frontmatter', { lang: 'toml' }, [schema.text('title = "Hello"')]),
      schema.node('heading', { level: 1 }, [schema.text('Heading')]),
    ])
    const md = toMarkdown(doc)
    expect(md).toContain('+++\ntitle = "Hello"\n+++')
    expect(md).toContain('# Heading')
  })

  it('toMarkdown: frontmatter 默认 lang=yaml 时仍走 ---', () => {
    // 兼容旧节点(无 lang 属性):默认 yaml。
    const doc = schema.node('doc', null, [
      schema.node('frontmatter', null, [schema.text('title: X')]),
      schema.node('paragraph', null, [schema.text('body')]),
    ])
    const md = toMarkdown(doc)
    expect(md).toContain('---\ntitle: X\n---')
  })

  it('round-trip: toml frontmatter', () => {
    const md = '+++\ntitle = "Hello"\ndate = 2026-07-10\n+++\n\n# Heading\n\nbody'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(back.trim()).toBe(md.trim())
  })

  it('round-trip: toml frontmatter only', () => {
    const md = '+++\ntitle = "Only"\n+++'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(back.trim()).toBe('+++\ntitle = "Only"\n+++')
  })

  it('round-trip: toml double round-trip stability', () => {
    const md = '+++\ntitle = "Hello"\n+++\n\n# H1\n\nbody'
    const doc1 = fromMarkdown(md, schema)
    const md1 = toMarkdown(doc1)
    const doc2 = fromMarkdown(md1, schema)
    const md2 = toMarkdown(doc2)
    expect(md2).toBe(md1)
  })
})

// === 实时键入检测(frontmatterFenceKind + frontmatterEnterCommand) ===

describe('frontmatterFenceKind 检测器', () => {
  it('--- → yaml', () => {
    expect(frontmatterFenceKind('---')).toBe('yaml')
  })

  it('+++ → toml', () => {
    expect(frontmatterFenceKind('+++')).toBe('toml')
  })

  it('前导空格 ≤3 容忍', () => {
    expect(frontmatterFenceKind('  ---')).toBe('yaml')
    expect(frontmatterFenceKind('   +++')).toBe('toml')
  })

  it('非恰好 3 根不匹配(跟 parser 一致,防 round-trip 丢失)', () => {
    expect(frontmatterFenceKind('----')).toBeNull()
    expect(frontmatterFenceKind('++++')).toBeNull()
    expect(frontmatterFenceKind('--')).toBeNull()
    expect(frontmatterFenceKind('++')).toBeNull()
  })

  it('*** / ___ 不是 frontmatter(应归 hr)', () => {
    expect(frontmatterFenceKind('***')).toBeNull()
    expect(frontmatterFenceKind('___')).toBeNull()
  })

  it('isFrontmatterFenceLine / SpaceTrigger', () => {
    expect(isFrontmatterFenceLine('---')).toBe(true)
    expect(isFrontmatterFenceLine('+++')).toBe(true)
    expect(isFrontmatterFenceLine('***')).toBe(false)
    expect(isFrontmatterFenceSpaceTrigger('--- ')).toBe(true)
    expect(isFrontmatterFenceSpaceTrigger('---')).toBe(false)
  })
})

describe('frontmatterEnterCommand: 文档首段 `+++`+Enter → toml frontmatter', () => {
  // 构造:文档首段 = 唯一 paragraph,光标在段尾。
  // Selection 必须落在 paragraph 内($from.parent === paragraph),否则 command
  // 第一道 paragraph 守卫即返回 false;故显式用 TextSelection 定位到段尾。
  function stateWithFirstParagraph(text: string, extra: any[] = []) {
    const para = schema.node('paragraph', null, [schema.text(text)])
    const doc = schema.node('doc', null, [para, ...extra])
    const paraEnd = 1 + para.content.size // doc open(1) + paragraph 内容尾
    const sel = TextSelection.create(doc, paraEnd)
    return EditorState.create({ schema, doc, selection: sel })
  }

  it('首段 `---`+Enter → yaml frontmatter', () => {
    const state = stateWithFirstParagraph('---')
    let resultDoc = state.doc
    const dispatch = (tr: Transaction) => { resultDoc = tr.doc }
    expect(frontmatterEnterCommand(state, dispatch)).toBe(true)
    expect(resultDoc.firstChild?.type.name).toBe('frontmatter')
    expect(resultDoc.firstChild?.attrs.lang).toBe('yaml')
  })

  it('首段 `+++`+Enter → toml frontmatter', () => {
    const state = stateWithFirstParagraph('+++')
    let resultDoc = state.doc
    const dispatch = (tr: Transaction) => { resultDoc = tr.doc }
    expect(frontmatterEnterCommand(state, dispatch)).toBe(true)
    expect(resultDoc.firstChild?.type.name).toBe('frontmatter')
    expect(resultDoc.firstChild?.attrs.lang).toBe('toml')
  })

  it('首段 `***`+Enter → 不转 frontmatter(应归 hr)', () => {
    const state = stateWithFirstParagraph('***')
    expect(frontmatterEnterCommand(state, undefined)).toBe(false)
  })

  it('非首段 `---`+Enter → 不转 frontmatter', () => {
    const state = stateWithFirstParagraph('intro', [
      schema.node('paragraph', null, [schema.text('---')]),
    ])
    expect(frontmatterEnterCommand(state, undefined)).toBe(false)
  })

  it('已有 frontmatter 时不再转', () => {
    // 首子已是 frontmatter → 即使第二段是 `---`,也不再转。
    const para = schema.node('paragraph', null, [schema.text('---')])
    const doc = schema.node('doc', null, [
      schema.node('frontmatter', { lang: 'yaml' }, [schema.text('title: X')]),
      para,
    ])
    const sel = TextSelection.create(doc, 1 /*doc*/ + 1 /*fm open*/ + 3 /*title: X*/ + 1 /*fm close*/ + 1 /*para open*/ + 3 /*---*/)
    const state = EditorState.create({ schema, doc, selection: sel })
    expect(frontmatterEnterCommand(state, undefined)).toBe(false)
  })
})

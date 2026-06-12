import { describe, expect, it } from 'vitest'
import { Schema } from '@milkdown/prose/model'
import { computeNumbering } from '../FootnoteNodeViews'

// 构造一个最小 schema,只装 footnote_reference / footnote_definition 两个节点
// (不需要 remark 全套,这里只测纯算法)
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    footnote_reference: {
      inline: true,
      atom: true,
      group: 'inline',
      attrs: { label: { default: '' } },
      parseDOM: [{ tag: 'sup[data-type="footnote_reference"]', getAttrs: dom => ({ label: (dom as HTMLElement).dataset.label ?? '' }) }],
      toDOM: node => ['sup', { 'data-type': 'footnote_reference', 'data-label': node.attrs.label }, node.attrs.label],
    },
    footnote_definition: {
      group: 'block',
      content: 'paragraph',
      attrs: { label: { default: '' } },
      parseDOM: [{ tag: 'dl[data-type="footnote_definition"]', getAttrs: dom => ({ label: (dom as HTMLElement).dataset.label ?? '' }) }],
      toDOM: node => ['dl', { 'data-type': 'footnote_definition', 'data-label': node.attrs.label }, ['dt', node.attrs.label], ['dd', 0]],
    },
  },
})

function mkRef(label: string) {
  return schema.nodes.footnote_reference.create({ label })
}

function mkDef(label: string, content = 'content') {
  return schema.nodes.footnote_definition.create(
    { label },
    schema.nodes.paragraph.create(null, schema.text(content)),
  )
}

function mkDoc(...nodes: any[]) {
  return schema.nodes.doc.create(null, nodes)
}

describe('computeNumbering', () => {
  it('空文档返回空 map', () => {
    const doc = mkDoc(schema.nodes.paragraph.create())
    const r = computeNumbering(doc)
    expect(r.refs.size).toBe(0)
    expect(r.defs.size).toBe(0)
  })

  it('单个 reference 出现在 refs', () => {
    const p = schema.nodes.paragraph.create(null, [mkRef('a')])
    const r = computeNumbering(mkDoc(p))
    expect(r.refs.get('a')?.length).toBe(1)
  })

  it('同一 label 多次引用合并到同一 refs 数组', () => {
    const p1 = schema.nodes.paragraph.create(null, [mkRef('x')])
    const p2 = schema.nodes.paragraph.create(null, [mkRef('x'), mkRef('x')])
    const r = computeNumbering(mkDoc(p1, p2))
    expect(r.refs.get('x')?.length).toBe(3)
  })

  it('defs 映射正确', () => {
    const p = schema.nodes.paragraph.create(null, [mkRef('k')])
    const d = mkDef('k')
    const r = computeNumbering(mkDoc(p, d))
    expect(r.defs.get('k')).toBeGreaterThanOrEqual(0)
  })

  it('孤儿 reference 仍出现在 refs', () => {
    // 没有对应的 definition
    const p = schema.nodes.paragraph.create(null, [mkRef('ghost')])
    const r = computeNumbering(mkDoc(p))
    expect(r.refs.has('ghost')).toBe(true)
    expect(r.defs.has('ghost')).toBe(false)
  })

  it('孤儿 definition 不在 refs 中', () => {
    const d = mkDef('orphan')
    const r = computeNumbering(mkDoc(d))
    expect(r.refs.has('orphan')).toBe(false)
    expect(r.defs.has('orphan')).toBe(true)
  })

  it('混合场景:ref + def + 孤儿', () => {
    const p = schema.nodes.paragraph.create(null, [mkRef('a'), mkRef('b')])
    const d1 = mkDef('a')
    const d2 = mkDef('orphan')
    const r = computeNumbering(mkDoc(p, d1, d2))
    expect(r.refs.has('a')).toBe(true)
    expect(r.refs.has('b')).toBe(true)
    expect(r.refs.has('orphan')).toBe(false)
    expect(r.defs.has('a')).toBe(true)
    expect(r.defs.has('orphan')).toBe(true)
  })
})

// ============================================================
//  输入规则 regex 的语义测试(纯字符串匹配,不实例化编辑器)
// ============================================================

// 与 FootnoteNodeViews.ts 里 $inputRule 的 regex 保持完全一致
const FOOTNOTE_REF_RULE = /\[\^([^\s\]]+)\]$/

function tryMatch(text: string): { label: string; full: string } | null {
  const m = text.match(FOOTNOTE_REF_RULE)
  if (!m) return null
  return { label: m[1], full: m[0] }
}

describe('footnote reference input rule regex', () => {
  it('匹配 [^id]', () => {
    const r = tryMatch('[^syntax]')
    expect(r).not.toBeNull()
    expect(r!.label).toBe('syntax')
  })

  it('匹配带前文的 [^id]', () => {
    const r = tryMatch('Hello [^id]')
    expect(r).not.toBeNull()
    expect(r!.label).toBe('id')
  })

  it('id 可以含数字、下划线、连字符', () => {
    expect(tryMatch('[^a-1_b]')?.label).toBe('a-1_b')
  })

  it('id 不能含空白', () => {
    expect(tryMatch('[^bad id]')).toBeNull()
  })

  it('id 不能含 ]', () => {
    expect(tryMatch('[^bad]id]')).toBeNull()
  })

  it('不匹配普通 link [text]', () => {
    expect(tryMatch('[text]')).toBeNull()
  })

  it('不匹配空的 [^]', () => {
    expect(tryMatch('[^]')).toBeNull()
  })

  it('不匹配未闭合的 [^id', () => {
    expect(tryMatch('[^id')).toBeNull()
  })

  it('[^id] 后跟空格时不匹配(规则在 ] 输入瞬间触发,空格属于下一次输入)', () => {
    expect(tryMatch('[^id] ')).toBeNull()
  })

  it('[^id] 后跟其它字符时不匹配', () => {
    expect(tryMatch('[^id]a')).toBeNull()
  })
})

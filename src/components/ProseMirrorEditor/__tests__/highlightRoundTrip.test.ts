// ==xxx== 高亮 mark round-trip 测试
//
// 覆盖:
//  - fromMarkdown:`==xx==` / `==**bold**==` / `text ==hi== more` 各种形态
//    都能正确加 highlight mark
//  - toMarkdown:highlight mark 的 PM doc 序列化回 `==xxx==`(可含嵌套 strong)
//  - 双向:from → to → from 后 mark 仍在(不丢)
//  - live keystroke(`==hi==`)→ highlight mark(syntax/inline/highlight.ts 已在 syntaxAutoFormat.test.ts 覆盖)
//
// 不覆盖:跨 atom 节点(image / math_inline / footnote_ref / hardbreak)的
// highlight —— schema 不允许 atom 带 mark,实际不会触发;round-trip 这类
// 复杂结构 markdownIO 会退化为丢 highlight(见 docs/architecture/editor.md)。

import { describe, expect, it } from 'vitest'
import { schema } from '../editor/schema'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'

function textOf(node: any): string {
  return node.textContent
}

function hasHighlightMark(node: any): boolean {
  if (node.marks?.some((m: any) => m.type.name === 'highlight')) return true
  if (node.childCount > 0) {
    let found = false
    node.descendants((n: any) => {
      if (n.marks?.some((m: any) => m.type.name === 'highlight')) found = true
    })
    return found
  }
  return false
}

function findHighlightSpan(para: any): { text: string, marks: any[] } | null {
  let result: { text: string, marks: any[] } | null = null
  para.descendants((n: any) => {
    if (result) return false
    if (n.isText && n.marks.some((m: any) => m.type.name === 'highlight')) {
      result = { text: n.text, marks: n.marks }
    }
  })
  return result
}

describe('highlight: fromMarkdown', () => {
  it('"==xx==" → highlight mark 加在 xx 上', () => {
    const doc = fromMarkdown('==xx==', schema)
    const para = doc.firstChild!
    const span = findHighlightSpan(para)
    expect(span).not.toBeNull()
    expect(span!.text).toBe('xx')
    // 没有 `==` 字面量残留
    expect(textOf(para)).toBe('xx')
  })

  it('"text ==hi== more" → 只 "hi" 有 highlight', () => {
    const doc = fromMarkdown('text ==hi== more', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('text hi more')
    const span = findHighlightSpan(para)
    expect(span?.text).toBe('hi')
  })

  it('"==**bold**==" → highlight + strong 嵌套', () => {
    const doc = fromMarkdown('==**bold**==', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('bold')
    const span = findHighlightSpan(para)
    expect(span?.text).toBe('bold')
    expect(span!.marks.some(m => m.type.name === 'strong')).toBe(true)
    expect(span!.marks.some(m => m.type.name === 'highlight')).toBe(true)
  })

  it('"==bold and **strong**==" → highlight 包 strong(跨节点模式)', () => {
    const doc = fromMarkdown('==bold and **strong**==', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('bold and strong')
    // "bold and " 应该有 highlight(text 节点实际有尾随空格)
    const boldAnd = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find((c: any) => c.text === 'bold and ')
    expect(boldAnd?.marks.some((m: any) => m.type.name === 'highlight')).toBe(true)
    // "strong" 应该有 highlight + strong
    const strong = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find((c: any) => c.text === 'strong')
    expect(strong?.marks.some((m: any) => m.type.name === 'highlight')).toBe(true)
    expect(strong?.marks.some((m: any) => m.type.name === 'strong')).toBe(true)
  })

  it('"==a *b* c==" → highlight 包 emphasis', () => {
    const doc = fromMarkdown('==a *b* c==', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('a b c')
    // "b" 应该有 highlight + emphasis
    const b = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find((c: any) => c.text === 'b')
    expect(b?.marks.some((m: any) => m.type.name === 'highlight')).toBe(true)
    expect(b?.marks.some((m: any) => m.type.name === 'emphasis')).toBe(true)
  })

  it('"==*x*==" → highlight 包 emphasis(纯 emphasis 在 highlight 内)', () => {
    const doc = fromMarkdown('==*x*==', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('x')
    const span = findHighlightSpan(para)
    expect(span?.text).toBe('x')
    expect(span!.marks.some(m => m.type.name === 'emphasis')).toBe(true)
    expect(span!.marks.some(m => m.type.name === 'highlight')).toBe(true)
  })

  it('空 highlight `====` inner 为空,regex 至少要 1 字符 → 不识别', () => {
    const doc = fromMarkdown('====', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('====')
    expect(hasHighlightMark(para)).toBe(false)
  })

  it('"text==hi=="(word 字符紧邻 ==)→ 识别为 highlight(允许 word==hl==word)', () => {
    const doc = fromMarkdown('text==hi==', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('texthi')
    const span = findHighlightSpan(para)
    expect(span?.text).toBe('hi')
  })
})

describe('highlight: toMarkdown', () => {
  it('PM doc 含 highlight mark → 输出 ==xx==', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('xx', [schema.marks.highlight.create()]),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('==xx==')
  })

  it('PM doc 含 highlight + strong → 输出 ==**bold**==', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('bold', [schema.marks.highlight.create(), schema.marks.strong.create({ marker: '*' })]),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('==**bold**==')
  })

  it('PM doc 含 highlight 包混合内容(plain + strong)→ 正确合并输出', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('bold and ', [schema.marks.highlight.create()]),
        schema.text('strong', [schema.marks.highlight.create(), schema.marks.strong.create({ marker: '*' })]),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('==bold and **strong**==')
  })

  it('PM doc 含 highlight + 后续 plain text → 边界正确(不丢后续 text)', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hi', [schema.marks.highlight.create()]),
        schema.text(' rest'),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('==hi== rest')
  })
})

describe('highlight: round-trip', () => {
  function roundTrip(md: string): string {
    const doc = fromMarkdown(md, schema)
    return toMarkdown(doc).trim()
  }

  it('"==xx==" → 加载 → 序列化 → "==xx=="', () => {
    expect(roundTrip('==xx==')).toBe('==xx==')
  })

  it('"==**bold**==" round-trip 完整(highlight + strong 都不丢)', () => {
    expect(roundTrip('==**bold**==')).toBe('==**bold**==')
  })

  it('"==bold and **strong**==" round-trip(用户最关心的跨 mark-set 场景)', () => {
    expect(roundTrip('==bold and **strong**==')).toBe('==bold and **strong**==')
  })

  it('"text ==hi== more" round-trip', () => {
    expect(roundTrip('text ==hi== more')).toBe('text ==hi== more')
  })

  it('"text==hi==" round-trip(word 字符紧邻 ==,无空格边界)', () => {
    expect(roundTrip('text==hi==')).toBe('text==hi==')
  })

  it('"==a *b* c==" round-trip(emphasis marker 保真: `*` 保留)', () => {
    expect(roundTrip('==a *b* c==')).toBe('==a *b* c==')
  })

  it('"==*x*==" round-trip(纯 emphasis 在 highlight 内,marker 保真输出 `==*x*==`)', () => {
    expect(roundTrip('==*x*==')).toBe('==*x*==')
  })

  it('"==xx==" + 普通段落 + "==yy==" 多段都 round-trip', () => {
    const md = '==xx==\n\nparagraph\n\n==yy=='
    const doc = fromMarkdown(md, schema)
    // 3 个 block
    expect(doc.childCount).toBe(3)
    expect(toMarkdown(doc).trim()).toBe(md)
  })
})
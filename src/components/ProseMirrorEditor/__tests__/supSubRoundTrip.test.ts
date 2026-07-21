// `^text^` 上标 / `~text~` 下标 mark round-trip 测试
//
// 覆盖:
//  - fromMarkdown:`^x^` / `~x~` / `^**bold**^` / `~_it_~` 各种形态
//    都能正确加 superscript / subscript mark
//  - toMarkdown:sup/sub mark 的 PM doc 序列化回 `^x^` / `~x~`
//  - 双向:from → to → from 后 mark 仍在(不丢)
//  - 嵌套:sup 包 sub / sub 包 sup / sup 包 strong 等
//  - `~~text~~` 删除线不被当下标误切
//  - 空 `^^` / `~~`(inner 为空)不识别
//
// 不覆盖:跨 atom 节点(image / math_inline / footnote_ref / hardbreak)的
// sup/sub —— schema 不允许 atom 带 mark,实际不会触发。

import { describe, expect, it } from 'vitest'
import { schema } from '../editor/schema'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'

function textOf(node: any): string {
  return node.textContent
}

function hasMark(node: any, markName: string): boolean {
  if (node.marks?.some((m: any) => m.type.name === markName)) return true
  if (node.childCount > 0) {
    let found = false
    node.descendants((n: any) => {
      if (n.marks?.some((m: any) => m.type.name === markName)) found = true
    })
    return found
  }
  return false
}

function findMarkSpan(para: any, markName: string): { text: string, marks: any[] } | null {
  let result: { text: string, marks: any[] } | null = null
  para.descendants((n: any) => {
    if (result) return false
    if (n.isText && n.marks.some((m: any) => m.type.name === markName)) {
      result = { text: n.text, marks: n.marks }
    }
  })
  return result
}

describe('superscript: fromMarkdown', () => {
  it('"^x^" → superscript mark 加在 x 上', () => {
    const doc = fromMarkdown('^x^', schema)
    const para = doc.firstChild!
    const span = findMarkSpan(para, 'superscript')
    expect(span).not.toBeNull()
    expect(span!.text).toBe('x')
    expect(textOf(para)).toBe('x')
  })

  it('"~x~" → subscript mark 加在 x 上', () => {
    const doc = fromMarkdown('~x~', schema)
    const para = doc.firstChild!
    const span = findMarkSpan(para, 'subscript')
    expect(span).not.toBeNull()
    expect(span!.text).toBe('x')
    expect(textOf(para)).toBe('x')
  })

  it('"^**bold**^" → superscript + strong 嵌套', () => {
    const doc = fromMarkdown('^**bold**^', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('bold')
    const span = findMarkSpan(para, 'superscript')
    expect(span?.text).toBe('bold')
    expect(span!.marks.some(m => m.type.name === 'strong')).toBe(true)
  })

  it('"~_it_~" → subscript 包 emphasis', () => {
    const doc = fromMarkdown('~_it_~', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('it')
    const span = findMarkSpan(para, 'subscript')
    expect(span?.text).toBe('it')
    expect(span!.marks.some(m => m.type.name === 'emphasis')).toBe(true)
  })

  it('空 "^^" inner 为空 → 不识别', () => {
    const doc = fromMarkdown('^^', schema)
    const para = doc.firstChild!
    expect(hasMark(para, 'superscript')).toBe(false)
  })

  it('"a^b^c" → b 为上标(Obsidian 行为,允许单词紧邻)', () => {
    const doc = fromMarkdown('a^b^c', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('abc')
    // "b" 应有 superscript mark
    const b = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find((c: any) => c.text === 'b')
    expect(b?.marks.some((m: any) => m.type.name === 'superscript')).toBe(true)
  })

  it('"text ^x^ more" → 只有 x 有 superscript', () => {
    const doc = fromMarkdown('text ^x^ more', schema)
    const para = doc.firstChild!
    expect(textOf(para)).toBe('text x more')
    const span = findMarkSpan(para, 'superscript')
    expect(span?.text).toBe('x')
  })
})

describe('subscript vs strike: fromMarkdown', () => {
  it('"~~text~~" → 删除线(strike),不是下标', () => {
    const doc = fromMarkdown('~~text~~', schema)
    const para = doc.firstChild!
    // 应有 strike_through mark,无 subscript mark
    expect(hasMark(para, 'strike_through')).toBe(true)
    expect(hasMark(para, 'subscript')).toBe(false)
  })

  it('"~text~" → 下标,不是删除线', () => {
    const doc = fromMarkdown('~text~', schema)
    const para = doc.firstChild!
    expect(hasMark(para, 'subscript')).toBe(true)
    expect(hasMark(para, 'strike_through')).toBe(false)
  })
})

describe('superscript/subscript: toMarkdown', () => {
  it('PM doc 含 superscript mark → 输出 ^x^', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('x', [schema.marks.superscript.create()]),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('^x^')
  })

  it('PM doc 含 subscript mark → 输出 ~x~', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('x', [schema.marks.subscript.create()]),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('~x~')
  })

  it('PM doc 含 sup + strong → 输出 ^**bold**^', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('bold', [schema.marks.superscript.create(), schema.marks.strong.create({ marker: '*' })]),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('^**bold**^')
  })

  it('PM doc 含 sub + 后续 plain text → 边界正确', () => {
    const pmDoc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('H', []),
        schema.text('2', [schema.marks.subscript.create()]),
        schema.text('O', []),
      ]),
    ])
    expect(toMarkdown(pmDoc).trim()).toBe('H~2~O')
  })
})

describe('sup/sub: round-trip', () => {
  function roundTrip(md: string): string {
    const doc = fromMarkdown(md, schema)
    return toMarkdown(doc).trim()
  }

  it('"^x^" → 加载 → 序列化 → "^x^"', () => {
    expect(roundTrip('^x^')).toBe('^x^')
  })

  it('"~x~" → 加载 → 序列化 → "~x~"', () => {
    expect(roundTrip('~x~')).toBe('~x~')
  })

  it('"^**bold**^" round-trip 完整', () => {
    expect(roundTrip('^**bold**^')).toBe('^**bold**^')
  })

  it('"~_it_~" round-trip(markdown emphasis,不丢 mark)', () => {
    expect(roundTrip('~_it_~')).toBe('~_it_~')
  })

  it('"H~2~O" round-trip', () => {
    expect(roundTrip('H~2~O')).toBe('H~2~O')
  })

  it('"x^2^ + y^3^" 多处 sup round-trip', () => {
    expect(roundTrip('x^2^ + y^3^')).toBe('x^2^ + y^3^')
  })

  it('sup 包 sub 嵌套 round-trip', () => {
    expect(roundTrip('^x~y~z^')).toBe('^x~y~z^')
  })

  it('"~~text~~" 删除线 round-trip 完整(不被当下标)', () => {
    expect(roundTrip('~~text~~')).toBe('~~text~~')
  })
})

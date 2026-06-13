import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from 'prosemirror-model'
import { buildPattern, escapeRegex, findMatchesInDoc, replaceInText } from '../findMatches'

// 最小 schema:doc / paragraph / heading / text,够测位置计算即可
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'inline*',
      group: 'block',
      parseDOM: [{ tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }],
      toDOM: node => [`h${node.attrs.level}`, 0],
    },
    text: { group: 'inline' },
  },
})

function mkDoc(...nodes: PMNode[]): PMNode {
  return schema.nodes.doc.create(null, nodes)
}
function mkP(text: string): PMNode {
  return schema.nodes.paragraph.create(null, schema.text(text))
}
function mkH(text: string, level = 1): PMNode {
  return schema.nodes.heading.create({ level }, schema.text(text))
}

const opt = (overrides: Partial<{ caseSensitive: boolean, wholeWord: boolean, regex: boolean }> = {}) => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...overrides,
})

describe('escapeRegex', () => {
  it('转义所有元字符', () => {
    expect(escapeRegex('a.b*c+d')).toBe('a\\.b\\*c\\+d')
    expect(escapeRegex('(test)[?]')).toBe('\\(test\\)\\[\\?\\]')
  })

  it('纯字母数字不变', () => {
    expect(escapeRegex('hello123')).toBe('hello123')
  })
})

describe('buildPattern', () => {
  it('空 query → null', () => {
    expect(buildPattern('', opt())).toBeNull()
  })

  it('普通字符串 → 转义后全局匹配,默认大小写不敏感', () => {
    const pat = buildPattern('hello.world', opt())!
    expect(pat.global).toBe(true)
    expect(pat.flags).toContain('i')
    expect(pat.test('hello.world')).toBe(true)
    expect(pat.test('hello world')).toBe(false)
  })

  it('caseSensitive 关掉 i flag', () => {
    const cs = buildPattern('hello', opt({ caseSensitive: true }))!
    expect(cs.flags).not.toContain('i')
    cs.lastIndex = 0
    expect(cs.exec('HELLO')).toBeNull()
    cs.lastIndex = 0
    expect(cs.exec('hello')?.[0]).toBe('hello')
  })

  it('regex 模式不转义', () => {
    // 用 exec() 测,避免全局 regex 的 lastIndex 在 test() 之间累积
    expect(buildPattern('h.llo', opt({ regex: true }))!.exec('hello')?.[0]).toBe('hello')
    expect(buildPattern('h.llo', opt({ regex: true }))!.exec('hxllo')?.[0]).toBe('hxllo')
  })

  it('wholeWord 加 \\b 边界', () => {
    const pat = buildPattern('cat', opt({ wholeWord: true }))!
    pat.lastIndex = 0
    expect(pat.exec('cat')?.[0]).toBe('cat')
    pat.lastIndex = 0
    expect(pat.exec('a cat is here')?.[0]).toBe('cat')
    pat.lastIndex = 0
    expect(pat.exec('caterpillar')).toBeNull()
  })

  it('wholeWord + regex 同时生效', () => {
    const pat = buildPattern('\\w+', opt({ wholeWord: true, regex: true }))!
    pat.lastIndex = 0
    expect(pat.exec('foo')?.[0]).toBe('foo')
    pat.lastIndex = 0
    // 'foo bar' 里有 'foo' 和 'bar' 两个整词,exec 取第一个
    expect(pat.exec('foo bar')?.[0]).toBe('foo')
  })

  it('invalid regex → null,不抛', () => {
    expect(buildPattern('[', opt({ regex: true }))).toBeNull()
    expect(buildPattern('*', opt({ regex: true }))).toBeNull()
  })
})

describe('findMatchesInDoc', () => {
  it('空 query → 空数组', () => {
    const doc = mkDoc(mkP('hello'))
    expect(findMatchesInDoc(doc, '', opt())).toEqual([])
  })

  it('单个段落内的多次匹配,位置正确', () => {
    // doc opens at 0, paragraph opens at 0, text starts at 1
    const doc = mkDoc(mkP('hello world hello'))
    const matches = findMatchesInDoc(doc, 'hello', opt())
    expect(matches).toHaveLength(2)
    expect(matches[0]).toEqual({ from: 1, to: 6 })
    expect(matches[1]).toEqual({ from: 13, to: 18 })
  })

  it('跨多个 block 找全', () => {
    const doc = mkDoc(mkP('foo'), mkP('foo bar'), mkP('baz'))
    const matches = findMatchesInDoc(doc, 'foo', opt())
    expect(matches).toHaveLength(2)
  })

  it('跨 heading / paragraph 找全', () => {
    const doc = mkDoc(mkH('Title with foo'), mkP('foo bar'))
    const matches = findMatchesInDoc(doc, 'foo', opt())
    expect(matches).toHaveLength(2)
  })

  it('case-sensitive 区分大小写', () => {
    const doc = mkDoc(mkP('Hello hello'))
    const ci = findMatchesInDoc(doc, 'hello', opt())
    const cs = findMatchesInDoc(doc, 'hello', opt({ caseSensitive: true }))
    expect(ci).toHaveLength(2)
    expect(cs).toHaveLength(1)
  })

  it('whole word 排除子串', () => {
    const doc = mkDoc(mkP('cat caterpillar cat'))
    const matches = findMatchesInDoc(doc, 'cat', opt({ wholeWord: true }))
    // 第 1 个 cat 是整词,第 2 个 caterpillar 里的 cat 不算,第 3 个 cat 是整词
    expect(matches).toHaveLength(2)
  })

  it('regex 匹配', () => {
    const doc = mkDoc(mkP('foo123 bar456 baz'))
    const matches = findMatchesInDoc(doc, '\\w+\\d+', opt({ regex: true }))
    expect(matches).toHaveLength(2)
  })

  it('invalid regex → 空数组,不抛', () => {
    const doc = mkDoc(mkP('foo'))
    expect(findMatchesInDoc(doc, '[', opt({ regex: true }))).toEqual([])
  })

  it('零宽匹配不死循环,正常推进', () => {
    const doc = mkDoc(mkP('abc'))
    // '^' 是零宽匹配 (匹配位置 0,长度 0),必须手动推进 lastIndex 防止死循环。
    // 这个测试主要验证:函数在合理时间内返回(没死循环),不抛错,返回的是数组。
    const t0 = Date.now()
    const result = findMatchesInDoc(doc, '^', opt({ regex: true }))
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(Array.isArray(result)).toBe(true)
  })

  it('中文也能匹配', () => {
    const doc = mkDoc(mkP('你好 世界 你好'))
    const matches = findMatchesInDoc(doc, '你好', opt())
    expect(matches).toHaveLength(2)
  })
})

describe('replaceInText', () => {
  it('普通模式:替换所有出现', () => {
    expect(
      replaceInText('foo bar foo', 'foo', opt(), 'baz'),
    ).toBe('baz bar baz')
  })

  it('regex 模式:支持 $1 $2 反向引用', () => {
    expect(
      replaceInText('hello world', '(\\w+) (\\w+)', opt({ regex: true }), '$2 $1'),
    ).toBe('world hello')
  })

  it('无匹配 → 原样返回', () => {
    expect(replaceInText('foo', 'bar', opt(), 'baz')).toBe('foo')
  })

  it('case-insensitive 替换所有大小写变体', () => {
    expect(
      replaceInText('Foo FOO foo', 'foo', opt(), 'X'),
    ).toBe('X X X')
  })

  it('wholeWord 只替换整词', () => {
    expect(
      replaceInText('cat caterpillar cat', 'cat', opt({ wholeWord: true }), 'dog'),
    ).toBe('dog caterpillar dog')
  })

  it('空 query → 原样返回', () => {
    expect(replaceInText('foo', '', opt(), 'X')).toBe('foo')
  })
})

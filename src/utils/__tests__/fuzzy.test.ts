import { describe, expect, it } from 'vitest'
import { fuzzyScore } from '../fuzzy'

describe('fuzzyScore', () => {
  it('空 query → score 0 / indices 空', () => {
    const r = fuzzyScore('anything', '')
    expect(r).toEqual({ score: 0, indices: [] })
  })

  it('大小写不敏感', () => {
    expect(fuzzyScore('Introduction', 'intro')).not.toBeNull()
    expect(fuzzyScore('INTRODUCTION', 'intro')).not.toBeNull()
    expect(fuzzyScore('introduction', 'INTRO')).not.toBeNull()
  })

  it('严格子序列(非子串)', () => {
    expect(fuzzyScore('Introduction', 'irc')).not.toBeNull() // i-r-c
    expect(fuzzyScore('aXbYc', 'abc')).not.toBeNull()
  })

  it('顺序错乱或字符不全 → null', () => {
    expect(fuzzyScore('abc', 'cba')).toBeNull()
    expect(fuzzyScore('hi', 'hello')).toBeNull()
  })

  it('indices 长度等于 query.length,按 query 顺序', () => {
    const r = fuzzyScore('Introduction', 'irc')!
    expect(r.indices).toHaveLength(3)
    expect(r.indices[0]).toBeLessThan(r.indices[1])
    expect(r.indices[1]).toBeLessThan(r.indices[2])
    // 字符核对:对应 indices 拼回去应等于 query(忽略大小写)
    const text = 'Introduction'
    const picked = r.indices.map(i => text[i].toLowerCase()).join('')
    expect(picked).toBe('irc')
  })

  it('连续匹配 score 高于跳跃匹配', () => {
    // text 都是 "abc...",query 都是 "abc" —— 一个连续命中、一个 a-b-c 跨字符
    const cont = fuzzyScore('abcxyz', 'abc')!
    const jump = fuzzyScore('aXbYcZ', 'abc')!
    expect(cont.score).toBeGreaterThan(jump.score)
  })

  it('词首字符命中(分隔符 / 路径分隔后)拿 bonus', () => {
    // "docs/architecture.md" 里搜 "a" 应命中 'a'(位置 5,前一个是 '/' → 词首)
    // "ddddda" 里搜 "a" 命中位置 5,前一个是 'd' → 非词首,且首字符惩罚
    const wordHead = fuzzyScore('docs/architecture.md', 'a')!
    const insideWord = fuzzyScore('ddddda', 'a')!
    expect(wordHead.score).toBeGreaterThan(insideWord.score)
  })

  it('前缀命中 score 高于中部命中(START_PENALTY 生效)', () => {
    const prefix = fuzzyScore('README.md', 're')!
    const middle = fuzzyScore('aaaareXX', 're')!
    expect(prefix.score).toBeGreaterThan(middle.score)
  })

  it('ARCHITECTURE.md 搜 "arch" 优于带其它字符的同 4 字符连续命中', () => {
    // 主要验证连续 + 词首 bonus 在常见使用场景下的有序性
    const ideal = fuzzyScore('ARCHITECTURE.md', 'arch')!
    const noisier = fuzzyScore('xxARCHxx.md', 'arch')!
    expect(ideal.score).toBeGreaterThan(noisier.score)
  })
})

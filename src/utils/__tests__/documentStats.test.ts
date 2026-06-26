import { describe, expect, it } from 'vitest'
import { computeDocumentStats } from '../documentStats'

describe('computeDocumentStats', () => {
  it('空文档统计为 0', () => {
    expect(computeDocumentStats('')).toEqual({
      words: 0,
      characters: 0,
      paragraphs: 0,
      estimatedReadingMinutes: 0,
      latinWords: 0,
      cjkChars: 0,
    })
  })

  it('空白文档无字符无段落', () => {
    const stats = computeDocumentStats('  \n\t  ')

    expect(stats.words).toBe(0)
    expect(stats.characters).toBe(0)
    expect(stats.paragraphs).toBe(0)
    expect(stats.estimatedReadingMinutes).toBe(0)
  })

  it('统计英文和数字 token', () => {
    const stats = computeDocumentStats('Hello Velo 0.5.4')

    expect(stats.latinWords).toBe(3)
    expect(stats.cjkChars).toBe(0)
    expect(stats.words).toBe(3)
  })

  it('把 CJK 字符计入字数', () => {
    const stats = computeDocumentStats('你好 Velo')

    expect(stats.latinWords).toBe(1)
    expect(stats.cjkChars).toBe(2)
    expect(stats.words).toBe(3)
  })

  it('字符数不计空白且支持 Unicode', () => {
    const stats = computeDocumentStats('你 好\nVelo')

    expect(stats.characters).toBe(6)
  })

  it('按空行分段并归一化 CRLF', () => {
    const stats = computeDocumentStats('one\r\n\r\ntwo\r\nthree')

    expect(stats.paragraphs).toBe(2)
  })

  it('非空文档阅读时长至少 1 分钟并向上取整', () => {
    expect(computeDocumentStats('short').estimatedReadingMinutes).toBe(1)
    expect(computeDocumentStats(`${'word '.repeat(201)}`).estimatedReadingMinutes).toBe(2)
  })
})

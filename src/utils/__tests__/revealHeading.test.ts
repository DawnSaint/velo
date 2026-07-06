import { describe, expect, it } from 'vitest'
import { findLineOffset, getLineText, getLineCount } from '@/utils/revealHeading'

describe('findLineOffset', () => {
  // 'aaa\nbbb\nccc' → 0:aaa / 4:bbb / 8:ccc / 11:文末
  const content = 'aaa\nbbb\nccc'

  it('line <= 1 返回 0(首行起始)', () => {
    expect(findLineOffset(content, 1)).toBe(0)
    expect(findLineOffset(content, 0)).toBe(0)
    expect(findLineOffset(content, -3)).toBe(0)
  })

  it('返回第 N 行起始的 char offset(1-based)', () => {
    expect(findLineOffset(content, 2)).toBe(4)
    expect(findLineOffset(content, 3)).toBe(8)
  })

  it('行号超过总行数夹到文末(content.length)', () => {
    expect(findLineOffset(content, 99)).toBe(content.length)
  })

  it('NaN 行号返回 0', () => {
    expect(findLineOffset(content, Number.NaN)).toBe(0)
  })

  it('空串:任意行号都返回 0', () => {
    expect(findLineOffset('', 1)).toBe(0)
    expect(findLineOffset('', 5)).toBe(0)
  })
})

describe('getLineText', () => {
  const content = 'aaa\nbbb\nccc'

  it('返回第 N 行文本与 exists:true', () => {
    expect(getLineText(content, 1)).toEqual({ text: 'aaa', exists: true })
    expect(getLineText(content, 2)).toEqual({ text: 'bbb', exists: true })
    expect(getLineText(content, 3)).toEqual({ text: 'ccc', exists: true })
  })

  it('空行返回 exists:true + text:""', () => {
    expect(getLineText('a\n\nb', 2)).toEqual({ text: '', exists: true })
  })

  it('行号越界返回 exists:false', () => {
    expect(getLineText(content, 4)).toEqual({ text: '', exists: false })
    expect(getLineText(content, 99)).toEqual({ text: '', exists: false })
  })

  it('无效行号(<1 / NaN)返回 exists:false', () => {
    expect(getLineText(content, 0)).toEqual({ text: '', exists: false })
    expect(getLineText(content, Number.NaN)).toEqual({ text: '', exists: false })
  })
})

describe('getLineCount', () => {
  it('无换行 → 1 行', () => {
    expect(getLineCount('aaa')).toBe(1)
    expect(getLineCount('')).toBe(1) // 空文档仍算第 1 行
  })

  it('N 个换行 → N+1 行(尾随 \\n 也算一行)', () => {
    expect(getLineCount('aaa\nbbb')).toBe(2)
    expect(getLineCount('aaa\nbbb\nccc')).toBe(3)
    expect(getLineCount('aaa\nbbb\n')).toBe(3) // 尾随 \n 产生第 3 个空行
  })
})

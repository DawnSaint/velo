import { describe, expect, it } from 'vitest'
import { preprocessBlankLines } from '../preserveEmptyLine'

// 新公式:blankLineCount = match.length / 2 - 1
// for 循环 `i < blankLineCount` 在 blankLineCount 非整数时是 ceil 行为:
//   N=3 (1 空行) → 0.5 → ceil 1 个 <br />
//   N=4 (2 空行) → 1   → 1 个 <br />
//   N=5 (3 空行) → 1.5 → ceil 2 个 <br />
//   N=6 (4 空行) → 2   → 2 个 <br />
//   N=7 (5 空行) → 2.5 → ceil 3 个 <br />
//   N=8 (6 空行) → 3   → 3 个 <br />
// 简化公式: <br /> 数 = ceil((N-2) / 2) = floor((N+1) / 2)
// 设计意图:每多 1 对 \n 多 1 个 <br /> 占位,比旧公式(每多 1 个 \n 多 1 个)
// 占用率减半,避免后续链路 1 空段 → 2 空段翻倍。

describe('preprocessBlankLines', () => {
  it('单个空行不变(无连续 \\n)', () => {
    expect(preprocessBlankLines('a\n\nb')).toBe('a\n\nb')
  })

  it('1 个空行(3 \\n):1 个 <br /> 占位(ceil(0.5)=1)', () => {
    expect(preprocessBlankLines('a\n\n\nb')).toBe('a\n\n<br />\n\nb')
  })

  it('2 个空行(4 \\n):1 个 <br /> 占位', () => {
    expect(preprocessBlankLines('a\n\n\n\nb')).toBe('a\n\n<br />\n\nb')
  })

  it('3 个空行(5 \\n):2 个 <br /> 占位(ceil(1.5)=2)', () => {
    expect(preprocessBlankLines('a\n\n\n\n\nb')).toBe('a\n\n<br />\n\n<br />\n\nb')
  })

  it('4 个空行(6 \\n):2 个 <br /> 占位', () => {
    expect(preprocessBlankLines('a\n\n\n\n\n\nb')).toBe('a\n\n<br />\n\n<br />\n\nb')
  })

  it('5 个空行(7 \\n):3 个 <br /> 占位(ceil(2.5)=3)', () => {
    expect(preprocessBlankLines('a\n\n\n\n\n\n\nb')).toBe('a\n\n<br />\n\n<br />\n\n<br />\n\nb')
  })

  it('6 个空行(8 \\n):3 个 <br /> 占位', () => {
    expect(preprocessBlankLines('a\n\n\n\n\n\n\n\nb')).toBe('a\n\n<br />\n\n<br />\n\n<br />\n\nb')
  })

  it('文档开头 2 个空行:1 个 <br /> 占位', () => {
    expect(preprocessBlankLines('\n\n\n\npara1')).toBe('\n\n<br />\n\npara1')
  })

  it('文档末尾 2 个空行:1 个 <br /> 占位', () => {
    expect(preprocessBlankLines('para1\n\n\n\n')).toBe('para1\n\n<br />\n\n')
  })

  it('多组空行独立处理', () => {
    // a-b:1 空行(N=3)→ 1 个 <br />
    // b-c:2 空行(N=4)→ 1 个 <br />
    expect(preprocessBlankLines('a\n\n\nb\n\n\n\nc')).toBe('a\n\n<br />\n\nb\n\n<br />\n\nc')
  })

  it('连续应用稳定 round-trip', () => {
    // 一次应用后没有 3+ 连续 \n,二次应用保持不变
    const input = 'a\n\n\n\nb'
    const once = preprocessBlankLines(input)
    const twice = preprocessBlankLines(once)
    expect(twice).toBe(once)
  })
})

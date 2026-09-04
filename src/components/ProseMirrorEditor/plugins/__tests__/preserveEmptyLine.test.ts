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

  it('CRLF 行尾被规范化成 LF 后,多空行仍能识别(Windows / 网络盘文件)', () => {
    // 修复前:`\r\n\r\n\r\n` 含 \r,旧正则 `\n\n\n+` 不匹配
    // 修复后:先 \r\n → \n,3 个 \n 触发 1 个 <br /> 占位
    expect(preprocessBlankLines('a\r\n\r\n\r\nb')).toBe('a\n\n<br />\n\nb')
    expect(preprocessBlankLines('a\r\n\r\n\r\n\r\nb')).toBe('a\n\n<br />\n\nb')
    expect(preprocessBlankLines('a\r\n\r\n\r\n\r\n\r\nb')).toBe('a\n\n<br />\n\n<br />\n\nb')
  })

  it('老 Mac 风格 CR 单独行尾也能规范化', () => {
    expect(preprocessBlankLines('a\r\rb')).toBe('a\n\nb')
    // a\r\r\rb → a\n\n\nb,3 个 \n 触发 1 个 <br /> 占位
    // (0.5 * 1 < 0.5 在 JS 里走 1 次,等效 ceil;见源文件注释)
    expect(preprocessBlankLines('a\r\r\rb')).toBe('a\n\n<br />\n\nb')
  })

  it('CRLF 与 LF 混用也能正确处理', () => {
    // 不一致行尾:解析时按 \r 拆分,可能有空 token,这里验证不会破坏正常段落
    expect(preprocessBlankLines('para1\r\n\r\npara2')).toBe('para1\n\npara2')
  })
})

// 逐字区里的空行是内容不是分隔符 —— 注入 <br /> 会把占位当成代码写回源码,
// round-trip 后永久污染磁盘文件(见 v0.7.13 代码块空行 bug)。
describe('preprocessBlankLines: 逐字区保护', () => {
  it('围栏代码块内的多空行不动', () => {
    expect(preprocessBlankLines('# t\n\n```\na\n\n\n\nb\n```\n'))
      .toBe('# t\n\n```\na\n\n\n\nb\n```\n')
  })

  it('带语言 + 波浪号围栏同样保护', () => {
    expect(preprocessBlankLines('```js\nlet a = 1\n\n\n\n\nlet b = 2\n```\n'))
      .toBe('```js\nlet a = 1\n\n\n\n\nlet b = 2\n```\n')
    expect(preprocessBlankLines('~~~\na\n\n\n\nb\n~~~\n'))
      .toBe('~~~\na\n\n\n\nb\n~~~\n')
  })

  it('未闭合围栏保护到文档末尾', () => {
    expect(preprocessBlankLines('```\na\n\n\n\nb\n')).toBe('```\na\n\n\n\nb\n')
  })

  it('围栏块前后的多空行仍注入占位', () => {
    expect(preprocessBlankLines('before\n\n\n\n```\nx\n```\n\n\n\nafter\n'))
      .toBe('before\n\n<br />\n\n```\nx\n```\n\n<br />\n\nafter\n')
  })

  // strictMath 的 A2 规则:围栏内遇到空行 → 围栏失败,退化成普通段落。
  // 因此 $$ 后面有空行的内容不再是数学块,逐字区保护不应覆盖它。
  // 空行照常注入 <br />,与普通段落行为一致。
  it('strictMath:围栏内含空行 → 围栏失败,空行照常注入', () => {
    expect(preprocessBlankLines('$$\nx = 1\n\n\n\ny = 2\n$$\n'))
      .toBe('$$\nx = 1\n\n<br />\n\ny = 2\n$$\n')
  })

  it('合法数学块(无空行)内的多空行不动', () => {
    // $$\nx = 1\ny = 2\n$$ 是合法数学块(无空行),内容受逐字区保护
    expect(preprocessBlankLines('$$\nx = 1\ny = 2\n$$\n'))
      .toBe('$$\nx = 1\ny = 2\n$$\n')
  })

  it('frontmatter 内的多空行不动(否则污染 YAML)', () => {
    expect(preprocessBlankLines('---\ntitle: a\n\n\n\ntags: b\n---\n\nbody\n'))
      .toBe('---\ntitle: a\n\n\n\ntags: b\n---\n\nbody\n')
  })

  it('缩进代码块内的多空行不动,块外照常注入', () => {
    expect(preprocessBlankLines('para\n\n    a\n\n\n\n    b\n\npara2\n'))
      .toBe('para\n\n    a\n\n\n\n    b\n\npara2\n')
    expect(preprocessBlankLines('para\n\n    a\n\n\n\n    b\n\n\n\npara2\n'))
      .toBe('para\n\n    a\n\n\n\n    b\n\n<br />\n\npara2\n')
  })

  it('缩进代码不能打断段落:lazy continuation 行后的多空行仍注入', () => {
    expect(preprocessBlankLines('para\n    lazy\n\n\n\n    more\n'))
      .toBe('para\n    lazy\n\n<br />\n\n    more\n')
  })

  it('标题 / 分割线是块边界:紧随其后的缩进代码内多空行不动', () => {
    // heading / hr 同样终结段落,后面的 4 空格行是缩进代码块而非 lazy continuation
    expect(preprocessBlankLines('# Title\n    a\n\n\n\n    b\n'))
      .toBe('# Title\n    a\n\n\n\n    b\n')
    expect(preprocessBlankLines('---\n    a\n\n\n\n    b\n'))
      .toBe('---\n    a\n\n\n\n    b\n')
  })

  it('列表项内 4 空格缩进的围栏代码块内多空行不动', () => {
    expect(preprocessBlankLines('- item\n\n  ```\n  a\n\n\n  b\n  ```\n'))
      .toBe('- item\n\n  ```\n  a\n\n\n  b\n  ```\n')
  })

  it('原始 HTML 块(pre / 注释)内的多空行不动', () => {
    expect(preprocessBlankLines('<pre>\na\n\n\n\nb\n</pre>\n'))
      .toBe('<pre>\na\n\n\n\nb\n</pre>\n')
    expect(preprocessBlankLines('<!--\na\n\n\n\nb\n-->\n'))
      .toBe('<!--\na\n\n\n\nb\n-->\n')
  })
})

// strictMath 改变了 $$ 围栏的逐字区保护行为。
// strictMath 的 A2 规则:围栏内遇到空行 → 围栏失败,退化成普通段落。
// findVerbatimRanges 必须与之保持一致,否则 $$ 后面的空行不会被注入 <br />,
// 导致空段在 toMarkdown → fromMarkdown round-trip 中丢失。
describe('preprocessBlankLines: strictMath 一致性', () => {
  it('未闭合 $$ (空行终止): 空行照常注入 <br />', () => {
    // strictMath: $$ 后紧跟空行 → 围栏失败 → 退化成普通段落
    // findVerbatimRanges 不应把 $$ 后的内容标记为逐字区
    expect(preprocessBlankLines('$$\n\n\n\nxxx\n'))
      .toBe('$$\n\n<br />\n\nxxx\n')
  })

  it('未闭合 $$ (EOF 终止): 不保护到 EOF', () => {
    // strictMath A1: $$ 到 EOF 未闭合 → 围栏失败
    // $$ 行本身是普通文本,后面的空行照常注入
    expect(preprocessBlankLines('$$\nxxx\n\n\n\nyyy\n'))
      .toBe('$$\nxxx\n\n<br />\n\nyyy\n')
  })

  it('合法数学块(无空行)仍受逐字区保护', () => {
    // $$\nx\ny\n$$ 是合法数学块,内容受保护
    expect(preprocessBlankLines('$$\nx = 1\ny = 2\n$$\n'))
      .toBe('$$\nx = 1\ny = 2\n$$\n')
  })

  it('$$ 段落间多空行:空段在 round-trip 中保留', () => {
    // 用户场景:PM doc 有 $$ 段落 + 空段 + 内容段 + 空段 + $ 段落
    // toMarkdown 产出 3+ 连续 \n,preprocessBlankLines 必须注入 <br />
    // 否则 fromMarkdown 解析时空段丢失
    const md = '$$\n\n\n\nxxx\n\n\n\n$\n'
    const processed = preprocessBlankLines(md)
    expect(processed).toContain('<br />')
    // $$ 行不在逐字区内,空行被正确注入
    expect(processed).toBe('$$\n\n<br />\n\nxxx\n\n<br />\n\n$\n')
  })
})

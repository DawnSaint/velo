import { describe, it, expect } from 'vitest'
import {
  formatMarkdown,
  formatSelection,
  createDefaultFormatting,
  type CJKFormattingSettings,
  type RuleScopes,
} from '@/lib/cjkFormatter'
import { findProtectedRegions } from '@/lib/cjkFormatter/markdownParser'
import { verifyIntegrity } from '@/lib/cjkFormatter/integrity'
import { applyContextualQuotes } from '@/lib/cjkFormatter/quotePairing'
import {
  addCJKEnglishSpacing,
  fixCurrencySpacing,
} from '@/lib/cjkFormatter/rules/spacing'
import { normalizeFullwidthPunctuation } from '@/lib/cjkFormatter/rules/fullwidth'
import { normalizeEllipsis } from '@/lib/cjkFormatter/rules/universal'
import { limitConsecutivePunctuation } from '@/lib/cjkFormatter/rules/cleanup'
import { convertNestedCornerQuotes } from '@/lib/cjkFormatter/rules/dashesQuotes'
import { containsCJK } from '@/lib/cjkFormatter/rules/shared'

const config: CJKFormattingSettings = createDefaultFormatting()

function customConfig(overrides: Partial<CJKFormattingSettings>): CJKFormattingSettings {
  return { ...createDefaultFormatting(), ...overrides }
}

// ============================================================
//  Group 1: 中英文间距
// ============================================================

describe('CJK-English spacing', () => {
  it('adds space between CJK and Latin', () => {
    expect(addCJKEnglishSpacing('中文English')).toBe('中文 English')
    expect(addCJKEnglishSpacing('English中文')).toBe('English 中文')
  })

  it('adds space between CJK and numbers', () => {
    expect(addCJKEnglishSpacing('长度100米')).toBe('长度 100 米')
  })

  it('does not duplicate existing spaces', () => {
    expect(addCJKEnglishSpacing('中文 English')).toBe('中文 English')
  })

  it('does not add space for Korean', () => {
    expect(addCJKEnglishSpacing('한국어English')).toBe('한국어English')
  })
})

// ============================================================
//  Group 2: 全角标点上下文
// ============================================================

describe('fullwidth punctuation', () => {
  it('converts comma to fullwidth when CJK adjacent', () => {
    expect(normalizeFullwidthPunctuation('中文,英文')).toBe('中文，英文')
  })

  it('keeps ASCII comma in pure Latin text', () => {
    expect(normalizeFullwidthPunctuation('hello, world')).toBe('hello, world')
  })

  it('protects punctuation in technical subspans (URL)', () => {
    const result = normalizeFullwidthPunctuation('访问https://example.com/page,看')
    // URL should be protected
    expect(result).toContain('https://example.com/page')
  })

  it('protects ordered list markers', () => {
    expect(normalizeFullwidthPunctuation('1. 列表项')).toBe('1. 列表项')
    expect(normalizeFullwidthPunctuation('10. 列表项')).toBe('10. 列表项')
  })
})

// ============================================================
//  Group 3: 直角引号转换
// ============================================================

describe('quote conversion', () => {
  it('contextual mode: CJK pairs get curly, Latin stays straight', () => {
    const result = applyContextualQuotes('"中文内容" and "Latin"', 'contextual')
    expect(result).toContain('\u201c') // opening curly "
    expect(result).toContain('\u201d') // closing curly "
    // Latin quotes should stay straight
    expect(result).toContain('"Latin"')
  })

  it('corner-for-cjk mode: CJK pairs get corner brackets', () => {
    const result = applyContextualQuotes('"中文"', 'corner-for-cjk')
    expect(result).toContain('「')
    expect(result).toContain('」')
  })

  it('off mode: no conversion', () => {
    const result = applyContextualQuotes('"text"', 'off')
    expect(result).toBe('"text"')
  })

  it('nested corner quotes: inner curly single → double corner', () => {
    const input = '「外层\u2018内层\u2019外层」'
    const result = convertNestedCornerQuotes(input)
    expect(result).toContain('『')
    expect(result).toContain('』')
  })
})

// ============================================================
//  Group 4: 货币单位 / 省略号 / 连续标点
// ============================================================

describe('currency spacing', () => {
  it('binds prefix currency to number', () => {
    expect(fixCurrencySpacing('$ 100')).toBe('$100')
  })

  it('binds unit symbol to number', () => {
    expect(fixCurrencySpacing('50 %')).toBe('50%')
  })

  it('spaces postfix currency code from number', () => {
    expect(fixCurrencySpacing('100USD')).toBe('100 USD')
  })
})

describe('ellipsis normalization', () => {
  it('collapses spaced dots to standard ellipsis', () => {
    expect(normalizeEllipsis('. . .')).toBe('...')
  })

  it('ensures space after ellipsis when followed by text', () => {
    expect(normalizeEllipsis('...text')).toBe('... text')
  })
})

describe('consecutive punctuation limit', () => {
  it('limits to 2', () => {
    expect(limitConsecutivePunctuation('！！！', 2)).toBe('！！')
    expect(limitConsecutivePunctuation('。。。', 2)).toBe('。。')
  })

  it('limits to 1', () => {
    expect(limitConsecutivePunctuation('！！', 1)).toBe('！')
  })

  it('0 means no limit', () => {
    expect(limitConsecutivePunctuation('！！！', 0)).toBe('！！！')
  })
})

// ============================================================
//  Group 5: 保护区不被破坏
// ============================================================

describe('protected regions', () => {
  it('protects fenced code blocks', () => {
    const md = '中文English\n```\ncode, here\n```\n更多中文'
    const result = formatMarkdown(md, config)
    expect(result).toContain('code, here') // code content preserved
  })

  it('protects inline code', () => {
    const md = '这是`code, snippet`中文'
    const result = formatMarkdown(md, config)
    expect(result).toContain('code, snippet')
  })

  it('protects URLs in links', () => {
    const md = '[链接文本](https://example.com/path,query)中文'
    const result = formatMarkdown(md, config)
    expect(result).toContain('https://example.com/path,query')
  })

  it('protects math blocks', () => {
    const md = '中文\n$$\na, b = c\n$$\n更多'
    const result = formatMarkdown(md, config)
    expect(result).toContain('a, b = c')
  })

  it('protects frontmatter', () => {
    const md = '---\ntitle: Test, Item\n---\n\n正文,内容'
    const result = formatMarkdown(md, config)
    expect(result).toContain('title: Test, Item') // frontmatter preserved
  })

  it('protects footnote references', () => {
    const md = '脚注[^1]内容\n\n[^1]: 脚注,内容'
    const regions = findProtectedRegions(md)
    // footnote ref and def should be protected
    expect(regions.some(r => r.type === 'footnote_ref')).toBe(true)
    expect(regions.some(r => r.type === 'footnote_def')).toBe(true)
  })

  it('protects thematic breaks from dash conversion', () => {
    const md = '中文\n---\n更多中文'
    const result = formatMarkdown(md, config)
    expect(result).toContain('\n---\n')
  })

  it('formats link display text', () => {
    const md = '[中文English](https://example.com)'
    const result = formatMarkdown(md, config)
    // Display text should be formatted (space between CJK and Latin)
    expect(result).toContain('中文 English')
  })
})

// ============================================================
//  Group 6: 完整性校验回滚
// ============================================================

describe('integrity check', () => {
  it('passes when patterns are preserved', () => {
    const text = '```code```'
    const result = verifyIntegrity(text, text)
    expect(result.ok).toBe(true)
  })

  it('fails when backtick count changes', () => {
    const before = '`code`'
    const after = 'code'
    const result = verifyIntegrity(before, after)
    expect(result.ok).toBe(false)
    expect(result.details['`']).toBeDefined()
  })

  it('fails when code block count changes', () => {
    const before = '```\ncode\n```'
    const after = 'code'
    const result = verifyIntegrity(before, after)
    expect(result.ok).toBe(false)
  })
})

// ============================================================
//  Group 7: formatMarkdown 端到端
// ============================================================

describe('formatMarkdown end-to-end', () => {
  it('formats mixed CJK/Latin text', () => {
    const md = '这是Markdown文档,使用GitHub风格.'
    const result = formatMarkdown(md, config)
    expect(result).toContain('，') // fullwidth comma
    expect(result).toContain('。') // fullwidth period
    expect(result).toContain('Markdown') // Latin preserved
  })

  it('preserves code blocks during formatting', () => {
    const md = [
      '前文,内容',
      '',
      '```js',
      'const x = "hello, world";',
      '```',
      '',
      '后文,内容',
    ].join('\n')
    const result = formatMarkdown(md, config)
    expect(result).toContain('const x = "hello, world";')
    expect(result).toContain('前文，内容')
    expect(result).toContain('后文，内容')
  })

  it('formats table cells without breaking structure', () => {
    const md = [
      '| 名称 | 值 |',
      '| --- | --- |',
      '| 苹果,数 | 100 |',
    ].join('\n')
    const result = formatMarkdown(md, config)
    expect(result).toContain('苹果，数')
    expect(result).toContain('| --- |')
    // Table structure preserved
    expect(result).toMatch(/\|.*\|/)
  })

  it('does not modify pure ASCII text', () => {
    const md = 'Hello, world! This is pure ASCII.'
    const result = formatMarkdown(md, config)
    // No CJK context, so punctuation should stay ASCII
    expect(result).toBe('Hello, world! This is pure ASCII.')
  })

  it('formatSelection works without markdown structure', () => {
    const text = '中文English,混合'
    const result = formatSelection(text, config)
    expect(result).toContain('中文 English')
    expect(result).toContain('，')
  })

  it('all-disabled config returns text unchanged (except universal rules)', () => {
    const off = (): RuleScopes => ({ auto: false, format: false })
    const offConfig = customConfig({
      ellipsisNormalization: off(),
      newlineCollapsing: off(),
      fullwidthAlphanumeric: off(),
      fullwidthPunctuation: off(),
      cjkEnglishSpacing: off(),
      cjkParenthesisSpacing: off(),
      currencySpacing: off(),
      slashSpacing: off(),
      spaceCollapsing: off(),
      dashConversion: off(),
      emdashSpacing: off(),
      smartQuoteConversion: off(),
      contextualQuotes: off(),
      quoteSpacing: off(),
      singleQuoteSpacing: off(),
      cjkNestedQuotes: off(),
      trailingSpaceRemoval: off(),
      consecutivePunctuationLimit: 0,
    })
    const md = '中文English,混合'
    const result = formatMarkdown(md, offConfig)
    expect(result).toBe('中文English,混合')
  })
})

// ============================================================
//  Group 8: containsCJK
// ============================================================

describe('containsCJK', () => {
  it('detects Chinese', () => {
    expect(containsCJK('中文')).toBe(true)
  })

  it('detects Japanese', () => {
    expect(containsCJK('こんにちは')).toBe(true)
  })

  it('detects Korean', () => {
    expect(containsCJK('한국어')).toBe(true)
  })

  it('returns false for pure ASCII', () => {
    expect(containsCJK('Hello, world!')).toBe(false)
  })
})

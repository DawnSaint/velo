/**
 * Group 4 — 破折号与引号转换 / 间距规则。
 */

import type { QuoteStyle } from '../types'
import {
  CJK_NO_KOREAN,
  CJK_CHARS_PATTERN,
  CJK_CLOSING_BRACKETS,
  CJK_OPENING_BRACKETS,
  CJK_TERMINAL_PUNCTUATION,
} from './shared'

/** 2+ 连续短横线在 CJK 上下文转为 ——（破折号）。 */
export function convertDashes(text: string): string {
  const cjkBothPattern = new RegExp(
    `(${CJK_CHARS_PATTERN})[ \\t]*-{2,}[ \\t]*(${CJK_CHARS_PATTERN})`,
    'g',
  )
  const cjkLeftPattern = new RegExp(
    `(${CJK_CHARS_PATTERN})[ \\t]*-{2,}[ \\t]*([A-Za-z0-9])`,
    'g',
  )
  const cjkRightPattern = new RegExp(
    `([A-Za-z0-9])[ \\t]*-{2,}[ \\t]*(${CJK_CHARS_PATTERN})`,
    'g',
  )

  const replacer = (_: string, before: string, after: string) => {
    const leftSpace = CJK_CLOSING_BRACKETS.includes(before) ? '' : ' '
    const rightSpace = CJK_OPENING_BRACKETS.includes(after) ? '' : ' '
    return `${before}${leftSpace}——${rightSpace}${after}`
  }

  text = text.replace(cjkBothPattern, replacer)
  text = text.replace(cjkLeftPattern, replacer)
  text = text.replace(cjkRightPattern, replacer)

  return text
}

/** 修复已有 —— 的间距。 */
export function fixEmdashSpacing(text: string): string {
  return text.replace(/([^\s])[ \t]*——[ \t]*([^\s])/g, (_, before, after) => {
    const leftSpace = CJK_CLOSING_BRACKETS.includes(before) ? '' : ' '
    const rightSpace = CJK_OPENING_BRACKETS.includes(after) ? '' : ' '
    return `${before}${leftSpace}——${rightSpace}${after}`
  })
}

/** 通用引号间距修复。 */
function fixQuoteSpacing(
  text: string,
  openingQuote: string,
  closingQuote: string,
): string {
  const noSpaceBefore = CJK_CLOSING_BRACKETS + CJK_TERMINAL_PUNCTUATION
  const noSpaceAfter = CJK_OPENING_BRACKETS + CJK_TERMINAL_PUNCTUATION

  text = text.replace(
    new RegExp(
      `([A-Za-z0-9${CJK_NO_KOREAN}${CJK_CLOSING_BRACKETS}${CJK_TERMINAL_PUNCTUATION}]|——)${openingQuote}`,
      'g',
    ),
    (_, before) => {
      if (noSpaceBefore.includes(before)) {
        return `${before}${openingQuote}`
      }
      return `${before} ${openingQuote}`
    },
  )

  text = text.replace(
    new RegExp(
      `${closingQuote}([A-Za-z0-9${CJK_NO_KOREAN}${CJK_OPENING_BRACKETS}${CJK_TERMINAL_PUNCTUATION}]|——)`,
      'g',
    ),
    (_, after) => {
      if (noSpaceAfter.includes(after)) {
        return `${closingQuote}${after}`
      }
      return `${closingQuote} ${after}`
    },
  )

  return text
}

/** 双引号间距修复。 */
export function fixDoubleQuoteSpacing(text: string): string {
  return fixQuoteSpacing(text, '\u201c', '\u201d')
}

/** 单引号间距修复。 */
export function fixSingleQuoteSpacing(text: string): string {
  return fixQuoteSpacing(text, '\u2018', '\u2019')
}

const QUOTE_STYLES: Record<QuoteStyle, {
  doubleOpen: string
  doubleClose: string
  singleOpen: string
  singleClose: string
}> = {
  curly: { doubleOpen: '\u201c', doubleClose: '\u201d', singleOpen: '\u2018', singleClose: '\u2019' },
  corner: { doubleOpen: '「', doubleClose: '」', singleOpen: '『', singleClose: '』' },
  guillemets: { doubleOpen: '«', doubleClose: '»', singleOpen: '‹', singleClose: '›' },
}

/** 直引号转智能引号（弯引号/直角引号/书名号）。 */
export function convertStraightToSmartQuotes(text: string, style: QuoteStyle): string {
  const quotes = QUOTE_STYLES[style]
  const CJK_CHAR = new RegExp(`[${CJK_NO_KOREAN}]`)

  let cjkQuoteCount = 0

  text = text.replace(/"/g, (_, offset) => {
    const before = offset > 0 ? text[offset - 1] : ''
    const after = offset < text.length - 1 ? text[offset + 1] : ''

    if (offset === 0 || /[\s([{「『《【〈]/.test(before)) {
      return quotes.doubleOpen
    }
    if (CJK_CHAR.test(before)) {
      cjkQuoteCount++
      if (!/[\s\w]/.test(after) && !CJK_CHAR.test(after)) {
        return quotes.doubleClose
      }
      return cjkQuoteCount % 2 === 1 ? quotes.doubleOpen : quotes.doubleClose
    }
    return quotes.doubleClose
  })

  text = text.replace(
    /(^|[\s([{「『《【〈])'([^']*?)'/g,
    (_, before, content) => `${before}${quotes.singleOpen}${content}${quotes.singleClose}`,
  )

  text = text.replace(
    new RegExp(`([${CJK_NO_KOREAN}])'([^']*?)'`, 'g'),
    (_, before, content) => `${before}${quotes.singleOpen}${content}${quotes.singleClose}`,
  )

  return text
}

/** 直角引号内的单弯引号转嵌套双直角引号：「text『nested』text」。 */
export function convertNestedCornerQuotes(text: string): string {
  return text.replace(/「([^」]*)」/g, (_, content) => {
    const converted = content.replace(
      /\u2018([^\u2019]*)\u2019/g,
      '『$1』',
    )
    return `「${converted}」`
  })
}

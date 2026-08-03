/**
 * Group 2 — 全角归一化规则。
 *
 * 在 CJK 上下文中将半角 ASCII 转换为全角形式。
 * 保护有序列表标记（1.）、省略号（...）和技术子段（URL、版本号等）。
 */

import { scanLatinSpans, isInTechnicalSubspan, isCJKLetter } from '../latinSpanScanner'
import {
  CJK_CLOSING_BRACKETS,
  CJK_OPENING_BRACKETS,
  CJK_TERMINAL_PUNCTUATION,
  PUNCTUATION_MAP,
  getLeftNeighbor,
  getRightNeighbor,
} from './shared'

/** 全角字母数字转半角：１２３ → 123, Ａ → A */
export function normalizeFullwidthAlphanumeric(text: string): string {
  let result = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code >= 0xff10 && code <= 0xff19) {
      result += String.fromCharCode(code - 0xfee0)
    } else if (code >= 0xff21 && code <= 0xff3a) {
      result += String.fromCharCode(code - 0xfee0)
    } else if (code >= 0xff41 && code <= 0xff5a) {
      result += String.fromCharCode(code - 0xfee0)
    } else {
      result += char
    }
  }
  return result
}

/** 检查 dotPos 处的句点是否为有序列表标记（1. 2. 等）。 */
function isOrderedListMarker(text: string, dotPos: number): boolean {
  let i = dotPos - 1
  if (i < 0 || text[i] < '0' || text[i] > '9') return false
  while (i >= 0 && text[i] >= '0' && text[i] <= '9') i--
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--
  return i < 0 || text[i] === '\n'
}

/** 检查 pos 处的句点是否为省略号的一部分。 */
function isPartOfEllipsis(text: string, pos: number): boolean {
  if (text[pos] !== '.') return false
  const before = pos > 0 ? text[pos - 1] : ''
  const after = pos < text.length - 1 ? text[pos + 1] : ''
  return before === '.' || after === '.'
}

/** 在 CJK 上下文中将半角标点转全角。保护技术子段和列表标记。 */
export function normalizeFullwidthPunctuation(text: string): string {
  const latinSpans = scanLatinSpans(text)
  const result: string[] = []

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const fullwidth = PUNCTUATION_MAP[char]

    if (!fullwidth) {
      result.push(char)
      continue
    }

    if (i > 0 && text[i - 1] === '\\') {
      result.push(char)
      continue
    }

    if (char === '.' && isPartOfEllipsis(text, i)) {
      result.push(char)
      continue
    }

    if (char === '.' && isOrderedListMarker(text, i)) {
      result.push(char)
      continue
    }

    if (isInTechnicalSubspan(i, latinSpans)) {
      result.push(char)
      continue
    }

    const leftNeighbor = getLeftNeighbor(text, i)
    const rightNeighbor = getRightNeighbor(text, i)

    const leftIsCJK =
      leftNeighbor &&
      (isCJKLetter(leftNeighbor) ||
        CJK_CLOSING_BRACKETS.includes(leftNeighbor) ||
        CJK_TERMINAL_PUNCTUATION.includes(leftNeighbor))
    const rightIsCJK =
      rightNeighbor && (isCJKLetter(rightNeighbor) || CJK_OPENING_BRACKETS.includes(rightNeighbor))

    if (leftIsCJK || rightIsCJK) {
      result.push(fullwidth)
    } else {
      result.push(char)
    }
  }

  return result.join('')
}

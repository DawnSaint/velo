/**
 * 栈式引号配对算法
 *
 * 用栈方式配对开/闭引号，区分真正的引号与撇号（don't）、角分符号（5'10"）、
 * 年代缩写（'90s）。支持上下文转换：CJK 相关的引号用弯引号/直角引号，
 * 纯 Latin 引号保持直引号。
 *
 * 四种转换模式：
 * - off: 不转换
 * - curly-everywhere: 全部转弯引号
 * - contextual: CJK 上下文转弯引号，Latin 保持直引号
 * - corner-for-cjk: CJK 上下文转直角引号「」，Latin 保持直引号
 */

import { isCJKLetter } from './latinSpanScanner'

const STRAIGHT_DOUBLE = '"'
const STRAIGHT_SINGLE = "'"
const CURLY_DOUBLE_OPEN = '\u201c' // "
const CURLY_DOUBLE_CLOSE = '\u201d' // "
const CURLY_SINGLE_OPEN = '\u2018' // '
const CURLY_SINGLE_CLOSE = '\u2019' // '
const CORNER_DOUBLE_OPEN = '「'
const CORNER_DOUBLE_CLOSE = '」'
const CORNER_SINGLE_OPEN = '『'
const CORNER_SINGLE_CLOSE = '』'

const OPENING_BRACKETS = '([{（【《〈「『'
const CLOSING_BRACKETS = ')]}）】》〉」』'
const TERMINAL_PUNCTUATION = '，。！？；：、.,!?;:'

type QuoteType = 'double' | 'single'
type QuoteRole = 'open' | 'close' | 'apostrophe' | 'prime' | 'ambiguous'

export interface QuoteToken {
  index: number
  char: string
  type: QuoteType
  role: QuoteRole
}

interface QuotePair {
  openIndex: number
  closeIndex: number
  type: QuoteType
  content: string
  isCJKInvolved: boolean
}

export interface PairingResult {
  pairs: QuotePair[]
  orphans: QuoteToken[]
}

/** 检查位置处是否为撇号模式（don't, it's, l'amour）。 */
function isApostrophe(text: string, pos: number): boolean {
  const char = text[pos]
  if (char !== "'" && char !== CURLY_SINGLE_CLOSE && char !== CURLY_SINGLE_OPEN) {
    return false
  }

  const before = pos > 0 ? text[pos - 1] : ''
  const after = pos < text.length - 1 ? text[pos + 1] : ''

  if (/[a-zA-Z]/.test(before) && /[a-zA-Z]/.test(after)) {
    return true
  }

  return false
}

/** 检查位置处是否为年代缩写（'90s）。 */
function isDecadeAbbreviation(text: string, pos: number): boolean {
  const char = text[pos]
  if (char !== "'" && char !== CURLY_SINGLE_OPEN) {
    return false
  }

  const before = pos > 0 ? text[pos - 1] : ''
  if (/[0-9]/.test(before)) {
    return false
  }

  const after1 = pos + 1 < text.length ? text[pos + 1] : ''
  const after2 = pos + 2 < text.length ? text[pos + 2] : ''

  if (/[0-9]/.test(after1) && /[0-9]/.test(after2)) {
    return true
  }

  return false
}

/** 检查位置处是否为测量角分符号（5'10"）。 */
function isPrime(text: string, pos: number): boolean {
  const char = text[pos]
  const before = pos > 0 ? text[pos - 1] : ''

  if ((char === "'" || char === CURLY_SINGLE_CLOSE) && /[0-9]/.test(before)) {
    return true
  }

  if ((char === '"' || char === CURLY_DOUBLE_CLOSE) && /[0-9]/.test(before)) {
    // 仅在 feet-inches 记法（5'10"）中 " 才是 prime；
    // 向前搜索 5 个字符内的 '（single prime），找不到则不是 prime
    for (let i = pos - 1; i >= 0 && i > pos - 5; i--) {
      if (text[i] === "'" || text[i] === CURLY_SINGLE_CLOSE) {
        return true
      }
      if (!/[0-9]/.test(text[i])) {
        break
      }
    }
    return false
  }

  return false
}

/** 根据上下文分类引号为开或闭。 */
function classifyQuote(
  text: string,
  pos: number,
  type: QuoteType,
  doubleStack: number[],
  singleStack: number[],
): QuoteRole {
  let leftNeighbor = ''
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] !== ' ' && text[i] !== '\t') {
      leftNeighbor = text[i]
      break
    }
  }

  let rightNeighbor = ''
  for (let i = pos + 1; i < text.length; i++) {
    if (text[i] !== ' ' && text[i] !== '\t') {
      rightNeighbor = text[i]
      break
    }
  }

  const atStart = pos === 0 || text[pos - 1] === '\n'
  const atEnd = pos === text.length - 1 || text[pos + 1] === '\n'
  const leftIsWhitespace = pos === 0 || /\s/.test(text[pos - 1])
  const rightIsWhitespace = pos === text.length - 1 || /\s/.test(text[pos + 1])
  const leftIsOpenBracket = OPENING_BRACKETS.includes(leftNeighbor)
  const rightIsCloseBracket = CLOSING_BRACKETS.includes(rightNeighbor)
  const rightIsTerminal = TERMINAL_PUNCTUATION.includes(rightNeighbor)

  if (atStart || leftIsWhitespace || leftIsOpenBracket) {
    return 'open'
  }

  if (atEnd || rightIsWhitespace || rightIsCloseBracket || rightIsTerminal) {
    return 'close'
  }

  const stack = type === 'double' ? doubleStack : singleStack
  if (stack.length > 0) {
    return 'close'
  }

  return 'open'
}

/** 检查引号对是否涉及 CJK 上下文。 */
function checkCJKInvolvement(
  text: string,
  openIndex: number,
  closeIndex: number,
): boolean {
  const content = text.slice(openIndex + 1, closeIndex)
  for (const char of content) {
    if (isCJKLetter(char)) {
      return true
    }
  }

  if (openIndex > 0) {
    const leftChar = text[openIndex - 1]
    if (isCJKLetter(leftChar)) {
      return true
    }
  }

  if (closeIndex < text.length - 1) {
    const rightChar = text[closeIndex + 1]
    if (isCJKLetter(rightChar)) {
      return true
    }
  }

  return false
}

/** 分词：标记文本中的引号，过滤撇号和角分符号。 */
export function tokenizeQuotes(text: string): QuoteToken[] {
  const tokens: QuoteToken[] = []
  const doubleStack: number[] = []
  const singleStack: number[] = []

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    let type: QuoteType | null = null
    let isQuoteChar = false

    if (
      char === STRAIGHT_DOUBLE ||
      char === CURLY_DOUBLE_OPEN ||
      char === CURLY_DOUBLE_CLOSE
    ) {
      type = 'double'
      isQuoteChar = true
    } else if (
      char === STRAIGHT_SINGLE ||
      char === CURLY_SINGLE_OPEN ||
      char === CURLY_SINGLE_CLOSE
    ) {
      type = 'single'
      isQuoteChar = true
    }

    if (!isQuoteChar || type === null) continue

    if (type === 'single' && isApostrophe(text, i)) {
      tokens.push({ index: i, char, type, role: 'apostrophe' })
      continue
    }

    if (type === 'single' && isDecadeAbbreviation(text, i)) {
      tokens.push({ index: i, char, type, role: 'apostrophe' })
      continue
    }

    if (isPrime(text, i)) {
      tokens.push({ index: i, char, type, role: 'prime' })
      continue
    }

    const role = classifyQuote(text, i, type, doubleStack, singleStack)

    if (role === 'open') {
      ;(type === 'double' ? doubleStack : singleStack).push(i)
    } else {
      const stack = type === 'double' ? doubleStack : singleStack
      if (stack.length > 0) {
        stack.pop()
      }
    }

    tokens.push({ index: i, char, type, role })
  }

  return tokens
}

function pairQuotes(text: string, tokens: QuoteToken[]): PairingResult {
  const pairs: QuotePair[] = []
  const orphans: QuoteToken[] = []
  const doubleStack: QuoteToken[] = []
  const singleStack: QuoteToken[] = []

  for (const token of tokens) {
    if (token.role === 'apostrophe' || token.role === 'prime') {
      continue
    }

    const stack = token.type === 'double' ? doubleStack : singleStack

    if (token.role === 'open') {
      stack.push(token)
    } else {
      if (stack.length > 0) {
        const opener = stack.pop()!

        const innerStack = token.type === 'double' ? singleStack : doubleStack
        while (
          innerStack.length > 0 &&
          innerStack[innerStack.length - 1].index > opener.index
        ) {
          orphans.push(innerStack.pop()!)
        }

        pairs.push({
          openIndex: opener.index,
          closeIndex: token.index,
          type: token.type,
          content: text.slice(opener.index + 1, token.index),
          isCJKInvolved: checkCJKInvolvement(text, opener.index, token.index),
        })
      } else {
        orphans.push(token)
      }
    }
  }

  orphans.push(...doubleStack, ...singleStack)

  pairs.sort((a, b) => a.openIndex - b.openIndex)

  return { pairs, orphans }
}

/** 主入口：分词 + 配对。 */
export function analyzeQuotes(text: string): PairingResult {
  const tokens = tokenizeQuotes(text)
  return pairQuotes(text, tokens)
}

/** 应用上下文引号转换。 */
export function applyContextualQuotes(
  text: string,
  mode: 'off' | 'curly-everywhere' | 'contextual' | 'corner-for-cjk',
): string {
  if (mode === 'off') {
    return text
  }

  const { pairs } = analyzeQuotes(text)

  const replacements = new Map<number, string>()

  for (const pair of pairs) {
    let openQuote: string
    let closeQuote: string

    if (mode === 'curly-everywhere') {
      openQuote = pair.type === 'double' ? CURLY_DOUBLE_OPEN : CURLY_SINGLE_OPEN
      closeQuote = pair.type === 'double' ? CURLY_DOUBLE_CLOSE : CURLY_SINGLE_CLOSE
    } else if (mode === 'contextual') {
      if (pair.isCJKInvolved) {
        openQuote = pair.type === 'double' ? CURLY_DOUBLE_OPEN : CURLY_SINGLE_OPEN
        closeQuote = pair.type === 'double' ? CURLY_DOUBLE_CLOSE : CURLY_SINGLE_CLOSE
      } else {
        openQuote = pair.type === 'double' ? STRAIGHT_DOUBLE : STRAIGHT_SINGLE
        closeQuote = pair.type === 'double' ? STRAIGHT_DOUBLE : STRAIGHT_SINGLE
      }
    } else if (mode === 'corner-for-cjk') {
      if (pair.isCJKInvolved) {
        openQuote = pair.type === 'double' ? CORNER_DOUBLE_OPEN : CORNER_SINGLE_OPEN
        closeQuote = pair.type === 'double' ? CORNER_DOUBLE_CLOSE : CORNER_SINGLE_CLOSE
      } else {
        openQuote = pair.type === 'double' ? STRAIGHT_DOUBLE : STRAIGHT_SINGLE
        closeQuote = pair.type === 'double' ? STRAIGHT_DOUBLE : STRAIGHT_SINGLE
      }
    } else {
      continue
    }

    replacements.set(pair.openIndex, openQuote)
    replacements.set(pair.closeIndex, closeQuote)
  }

  let result = ''
  for (let i = 0; i < text.length; i++) {
    if (replacements.has(i)) {
      result += replacements.get(i)
    } else {
      result += text[i]
    }
  }

  return result
}

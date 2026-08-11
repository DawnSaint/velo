/**
 * Latin Span 扫描器
 *
 * 在 CJK 文本中识别 Latin 字符段（ASCII 字符序列），并在其中检测技术子段
 * （URL、邮箱、版本号、时间、千分位、域名、小数），保护其中的标点不被
 * 转换为全角。
 *
 * 韩文（Hangul）被排除在 CJK 检测外，因为韩文使用原生词间距规则。
 */

const CJK_LETTER_REGEX =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u

type TechnicalSubspanType =
  | 'urlLike'
  | 'emailLike'
  | 'domainLike'
  | 'versionLike'
  | 'decimalLike'
  | 'timeLike'
  | 'thousandsLike'

interface TechnicalSubspan {
  start: number
  end: number
  type: TechnicalSubspanType
  text: string
}

export interface LatinSpan {
  start: number
  end: number
  text: string
  subspans: TechnicalSubspan[]
}

const TECHNICAL_PATTERNS: Array<{
  type: TechnicalSubspanType
  pattern: RegExp
}> = [
  { type: 'urlLike', pattern: /https?:\/\/[^\s]+/g },
  { type: 'emailLike', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: 'versionLike', pattern: /\b(?:v\d+(?:\.\d+)+|\d+(?:\.\d+){2,})\b/g },
  { type: 'timeLike', pattern: /\b\d{1,2}:\d{2}(?::\d{2})?\b/g },
  { type: 'thousandsLike', pattern: /\b\d{1,3}(?:,\d{3})+\b/g },
  { type: 'domainLike', pattern: /\b[a-zA-Z][a-zA-Z0-9-]*\.[a-zA-Z0-9.-]+[a-zA-Z]\b/g },
  { type: 'decimalLike', pattern: /\b\d+\.\d+\b/g },
]

/** 检查字符是否为 CJK 字母（汉字、假名、注音符号）。 */
export function isCJKLetter(char: string): boolean {
  return CJK_LETTER_REGEX.test(char)
}

function isLatinSpanChar(char: string): boolean {
  const code = char.charCodeAt(0)

  if (char === '\n') return false
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return true
  if (code >= 0x30 && code <= 0x39) return true
  if (char === ' ' || char === '\t') return true

  const allowedPunctuation = '.,!?;:\'"()[]{}<>/-_@#&=+*%$\\|~`^'
  if (allowedPunctuation.includes(char)) return true

  return false
}

function findTechnicalSubspans(spanText: string): TechnicalSubspan[] {
  const subspans: TechnicalSubspan[] = []
  const usedRanges: Array<[number, number]> = []

  for (const { type, pattern } of TECHNICAL_PATTERNS) {
    pattern.lastIndex = 0

    let match
    while ((match = pattern.exec(spanText)) !== null) {
      const start = match.index
      const end = start + match[0].length

      const overlaps = usedRanges.some(
        ([usedStart, usedEnd]) =>
          (start >= usedStart && start < usedEnd) ||
          (end > usedStart && end <= usedEnd) ||
          (start <= usedStart && end >= usedEnd),
      )

      if (!overlaps) {
        subspans.push({
          start,
          end,
          type,
          text: match[0],
        })
        usedRanges.push([start, end])
      }
    }
  }

  subspans.sort((a, b) => a.start - b.start)
  return subspans
}

/** 扫描文本中的 Latin span（CJK 之间的 ASCII 字符序列）。 */
export function scanLatinSpans(text: string): LatinSpan[] {
  const spans: LatinSpan[] = []
  let spanStart = -1
  let i = 0

  while (i < text.length) {
    const char = text[i]

    let fullChar = char
    if (
      char.charCodeAt(0) >= 0xd800 &&
      char.charCodeAt(0) <= 0xdbff &&
      i + 1 < text.length
    ) {
      fullChar = char + text[i + 1]
    }

    const isCJK = isCJKLetter(fullChar)
    const isLatin = !isCJK && isLatinSpanChar(char)
    const isNewline = char === '\n'

    if (isLatin && spanStart === -1) {
      spanStart = i
    } else if ((!isLatin || isNewline) && spanStart !== -1) {
      const spanText = text.slice(spanStart, i)
      if (spanText.trim().length > 0) {
        spans.push({
          start: spanStart,
          end: i,
          text: spanText,
          subspans: findTechnicalSubspans(spanText),
        })
      }
      spanStart = -1
    }

    if (fullChar.length === 2) {
      i += 2
    } else {
      i += 1
    }
  }

  if (spanStart !== -1) {
    const spanText = text.slice(spanStart)
    if (spanText.trim().length > 0) {
      spans.push({
        start: spanStart,
        end: text.length,
        text: spanText,
        subspans: findTechnicalSubspans(spanText),
      })
    }
  }

  return spans
}

/** 获取位置处的技术子段（如有）。 */
function getTechnicalSubspanAt(
  position: number,
  spans: LatinSpan[],
): TechnicalSubspan | null {
  for (const span of spans) {
    if (position >= span.start && position < span.end) {
      const relativePos = position - span.start
      for (const subspan of span.subspans) {
        if (relativePos >= subspan.start && relativePos < subspan.end) {
          return subspan
        }
      }
    }
  }
  return null
}

/** 检查位置是否在技术子段内（URL、版本号等）。 */
export function isInTechnicalSubspan(
  position: number,
  spans: LatinSpan[],
): boolean {
  return getTechnicalSubspanAt(position, spans) !== null
}

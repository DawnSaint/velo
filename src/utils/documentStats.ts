export interface DocumentStats {
  words: number
  characters: number
  paragraphs: number
  estimatedReadingMinutes: number
  latinWords: number
  cjkChars: number
}

const LATIN_WORD_RE = /[A-Za-z0-9]+(?:[._'-][A-Za-z0-9]+)*/g
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

export function computeDocumentStats(content: string): DocumentStats {
  const normalized = content.replace(/\r\n?/g, '\n')
  const characters = Array.from(normalized.replace(/\s/g, '')).length
  const latinWords = normalized.match(LATIN_WORD_RE)?.length ?? 0
  const cjkChars = normalized.match(CJK_CHAR_RE)?.length ?? 0
  const paragraphs = normalized
    .split(/\n\s*\n+/)
    .map(part => part.trim())
    .filter(Boolean)
    .length
  const words = latinWords + cjkChars
  const readingUnits = latinWords / 200 + cjkChars / 500
  const estimatedReadingMinutes = characters === 0 ? 0 : Math.max(1, Math.ceil(readingUnits))

  return {
    words,
    characters,
    paragraphs,
    estimatedReadingMinutes,
    latinWords,
    cjkChars,
  }
}

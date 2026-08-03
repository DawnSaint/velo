/**
 * CJK 规则共享内部——字符范围、标点映射、邻居辅助函数。
 */

const HAN_BASIC = '\u4e00-\u9fff'
const HAN_EXT_A = '\u3400-\u4dbf'
const BOPOMOFO = '\u3100-\u312f'
const BOPOMOFO_EXT = '\u31a0-\u31bf'
const HIRAGANA = '\u3040-\u309f'
const KATAKANA = '\u30a0-\u30ff'
const KATAKANA_EXT = '\u31f0-\u31ff'
const HAN = `${HAN_BASIC}${HAN_EXT_A}`

// 韩文排除在间距规则外：韩文使用原生词间距
export const CJK_NO_KOREAN = `${HAN}${BOPOMOFO}${BOPOMOFO_EXT}${HIRAGANA}${KATAKANA}${KATAKANA_EXT}`

export const CJK_TERMINAL_PUNCTUATION = '，。！？；：、'
export const CJK_CLOSING_BRACKETS = '》」』】）〉'
export const CJK_OPENING_BRACKETS = '《「『【（〈'

export const CJK_CHARS_PATTERN = `[${HAN}${HIRAGANA}${KATAKANA}《》「」『』【】（）〈〉，。！？；：、]`

export const PUNCTUATION_MAP: Record<string, string> = {
  ',': '，',
  '.': '。',
  '!': '！',
  '?': '？',
  ';': '；',
  ':': '：',
}

/** pos 左侧最近的非空字符（处理 surrogate pair）。 */
export function getLeftNeighbor(text: string, pos: number): string {
  for (let i = pos - 1; i >= 0; i--) {
    if (text[i] !== ' ' && text[i] !== '\t') {
      const ch = text[i]
      const code = ch.charCodeAt(0)
      if (code >= 0xdc00 && code <= 0xdfff && i - 1 >= 0) {
        const prev = text[i - 1]
        const prevCode = prev.charCodeAt(0)
        if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
          return prev + ch
        }
      }
      return ch
    }
  }
  return ''
}

/** pos 右侧最近的非空字符（处理 surrogate pair）。 */
export function getRightNeighbor(text: string, pos: number): string {
  for (let i = pos + 1; i < text.length; i++) {
    if (text[i] !== ' ' && text[i] !== '\t') {
      const ch = text[i]
      const code = ch.charCodeAt(0)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const next = text[i + 1]
        const nextCode = next.charCodeAt(0)
        if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
          return ch + next
        }
      }
      return ch
    }
  }
  return ''
}

/** 检查文本是否包含 CJK 字符（汉字、假名、韩文、注音符号）。 */
export function containsCJK(text: string): boolean {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}/u.test(
    text,
  )
}

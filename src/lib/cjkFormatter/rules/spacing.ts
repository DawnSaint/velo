/**
 * Group 3 — 间距规则。
 *
 * CJK 与 Latin/数字之间加空格，括号间距，货币单位绑定，斜杠间距。
 */

import { CJK_NO_KOREAN } from './shared'

const SIGN_CHAR_CLASS = '[-+−±－＋]'
const CURRENCY_CHAR_CLASS = '[$¥€£₹]'

/** CJK 字符与英文/数字之间加空格。 */
export function addCJKEnglishSpacing(text: string): string {
  const alphanumPattern =
    `(?:${SIGN_CHAR_CLASS}(?=\\d|${CURRENCY_CHAR_CLASS}[ ]?\\d))?` +
    `(?:${CURRENCY_CHAR_CLASS}[ ]?)?` +
    `(?:${SIGN_CHAR_CLASS}(?=\\d))?` +
    '[A-Za-z0-9]+' +
    '(?:[%‰℃℉]|°[CcFf]?|[ ]?(?:USD|CNY|EUR|GBP|RMB|JPY))?'

  text = text.replace(
    new RegExp(`([${CJK_NO_KOREAN}])(${alphanumPattern})`, 'g'),
    '$1 $2',
  )
  text = text.replace(
    new RegExp(`(${alphanumPattern})([${CJK_NO_KOREAN}])`, 'g'),
    '$1 $2',
  )

  return text
}

/** CJK 字符与半角括号之间加空格。 */
export function addCJKParenthesisSpacing(text: string): string {
  text = text.replace(new RegExp(`([${CJK_NO_KOREAN}])\\(`, 'g'), '$1 (')
  text = text.replace(new RegExp(`\\)([${CJK_NO_KOREAN}])`, 'g'), ') $1')
  return text
}

/** 货币符号绑定：前缀绑定数字，后缀单位绑定数字。 */
export function fixCurrencySpacing(
  text: string,
  postfixCurrency: 'tight' | 'spaced' = 'spaced',
): string {
  text = text.replace(/([$¥€£₹])\s+(\d)/g, '$1$2')
  text = text.replace(/(USD|CNY|EUR|GBP|RMB|JPY)\s+(\d)/g, '$1$2')
  text = text.replace(/(\d)\s+(%|‰|℃|℉|°[CcFf]?)(?=[\s,;.。，；、！？!?)\]」』】〉》)]|$)/g, '$1$2')

  if (postfixCurrency === 'spaced') {
    text = text.replace(/(\d)(USD|CNY|EUR|GBP|RMB|JPY)\b/g, '$1 $2')
  } else {
    text = text.replace(/(\d)\s+(USD|CNY|EUR|GBP|RMB|JPY)\b/g, '$1$2')
  }

  return text
}

/** 斜杠周围去空格（保留 URL 中的 //）。 */
export function fixSlashSpacing(text: string): string {
  return text.replace(/(?<![/:])[ \t]*\/[ \t]*(?!\/)/g, '/')
}

/** 多空格折叠为单空格（保留缩进）。 */
export function collapseSpaces(text: string): string {
  return text.replace(/(\S) {2,}/g, '$1 ')
}

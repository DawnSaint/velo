/**
 * CJK 格式化规则 barrel export。
 */

export { containsCJK } from './rules/shared'
export { normalizeEllipsis, collapseNewlines } from './rules/universal'
export {
  normalizeFullwidthAlphanumeric,
  normalizeFullwidthPunctuation,
} from './rules/fullwidth'
export {
  addCJKEnglishSpacing,
  addCJKParenthesisSpacing,
  fixCurrencySpacing,
  fixSlashSpacing,
  collapseSpaces,
} from './rules/spacing'
export {
  convertDashes,
  fixEmdashSpacing,
  fixDoubleQuoteSpacing,
  fixSingleQuoteSpacing,
  fixCornerQuoteSpacing,
  fixDoubleCornerQuoteSpacing,
  convertStraightToSmartQuotes,
  convertToCJKCornerQuotes,
  convertNestedCornerQuotes,
} from './rules/dashesQuotes'
export {
  limitConsecutivePunctuation,
  removeTrailingSpaces,
} from './rules/cleanup'
export { applyRules } from './rules/applyRules'

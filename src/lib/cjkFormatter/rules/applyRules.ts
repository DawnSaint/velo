/**
 * applyRules — 按正确顺序执行启用的 CJK 规则。
 *
 * 规则顺序有讲究：全角归一先于间距，破折号/引号先于间距，清理最后。
 * 读 config.xxx.format（格式化命令层），不读 .auto（实时输入层）。
 */

import type { CJKFormattingSettings } from '../types'
import { applyContextualQuotes } from '../quotePairing'
import { containsCJK } from './shared'
import { normalizeEllipsis, collapseNewlines } from './universal'
import {
  normalizeFullwidthAlphanumeric,
  normalizeFullwidthPunctuation,
} from './fullwidth'
import {
  addCJKEnglishSpacing,
  addCJKParenthesisSpacing,
  fixCurrencySpacing,
  fixSlashSpacing,
  collapseSpaces,
} from './spacing'
import {
  convertDashes,
  fixEmdashSpacing,
  fixDoubleQuoteSpacing,
  fixSingleQuoteSpacing,
  convertStraightToSmartQuotes,
  convertNestedCornerQuotes,
} from './dashesQuotes'
import {
  limitConsecutivePunctuation,
  removeTrailingSpaces,
} from './cleanup'

/** 对文本应用所有启用的 CJK 格式化规则。 */
export function applyRules(
  text: string,
  config: CJKFormattingSettings,
  options: { preserveTwoSpaceHardBreaks?: boolean } = {},
): string {
  // Group 1: Universal
  if (config.ellipsisNormalization.format) {
    text = normalizeEllipsis(text)
  }

  if (containsCJK(text)) {
    // Group 2: Fullwidth Normalization
    if (config.fullwidthAlphanumeric.format) {
      text = normalizeFullwidthAlphanumeric(text)
    }
    if (config.fullwidthPunctuation.format) {
      text = normalizeFullwidthPunctuation(text)
    }

    // Group 4: Dash & Quote (before spacing)
    if (config.dashConversion.format) {
      text = convertDashes(text)
    }
    if (config.emdashSpacing.format) {
      text = fixEmdashSpacing(text)
    }

    // Smart quote conversion
    if (config.smartQuoteConversion.format) {
      if (config.quoteStyle === 'curly' || config.quoteStyle === 'corner') {
        let mode: 'off' | 'curly-everywhere' | 'contextual' | 'corner-for-cjk'
        if (config.cjkCornerQuotes) {
          mode = 'corner-for-cjk'
        } else if (config.contextualQuotes.format) {
          mode = 'contextual'
        } else {
          mode = 'curly-everywhere'
        }
        text = applyContextualQuotes(text, mode)
      } else {
        text = convertStraightToSmartQuotes(text, config.quoteStyle)
      }
    }

    // Nested corner quotes
    if (config.cjkNestedQuotes.format) {
      text = convertNestedCornerQuotes(text)
    }

    if (config.quoteSpacing.format) {
      text = fixDoubleQuoteSpacing(text)
    }
    if (config.singleQuoteSpacing.format) {
      text = fixSingleQuoteSpacing(text)
    }

    // Group 3: Spacing
    if (config.cjkEnglishSpacing.format) {
      text = addCJKEnglishSpacing(text)
    }
    // cjk_parenthesis_spacing
    if (config.cjkParenthesisSpacing.format) {
      text = addCJKParenthesisSpacing(text)
    }
    if (config.currencySpacing.format) {
      text = fixCurrencySpacing(text)
    }
    if (config.slashSpacing.format) {
      text = fixSlashSpacing(text)
    }

    // Group 5: Cleanup (CJK-specific)
    if (config.consecutivePunctuationLimit > 0) {
      text = limitConsecutivePunctuation(
        text,
        config.consecutivePunctuationLimit,
      )
    }
  }

  // Group 5: Universal cleanup
  if (config.spaceCollapsing.format) {
    text = collapseSpaces(text)
  }
  if (config.trailingSpaceRemoval.format) {
    text = removeTrailingSpaces(text, options)
  }

  // Group 1: Universal (newline collapsing)
  if (config.newlineCollapsing.format) {
    text = collapseNewlines(text)
  }

  return text
}

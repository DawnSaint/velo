/**
 * 排版格式化器类型定义
 *
 * 核心概念：每条排版规则有两个独立的作用域开关 ——
 *   auto:   输入时自动校准（实时 ProseMirror 插件读取）
 *   format: 格式化命令时校准（cjkFormatter 库读取）
 *
 * 不是所有规则都支持 auto（如空白清理不适合在每次键入时执行），
 * supportsAuto 标记规则是否具备实时校准能力。
 */

/** 引号风格：弯引号 "" ''、直角引号 「」『』、书名号 «»‹› */
export type QuoteStyle = 'curly' | 'corner' | 'guillemets'

/** 规则作用域：同一规则可在输入时自动校准和格式化命令时校准两个时机分别启停 */
export interface RuleScopes {
  /** 输入时自动校准（实时插件读取） */
  auto: boolean
  /** 格式化命令时校准（cjkFormatter 库读取） */
  format: boolean
}

/** 规则功能分组 */
type RuleGroup = 'spacing' | 'punctuation' | 'quote' | 'cleanup'

/** 规则定义：UI 元数据 + 能力声明，驱动设置页渲染和 hydrate 迁移 */
interface RuleDef {
  /** 对应 CJKFormattingSettings 中的字段名 */
  key: keyof CJKFormattingSettings & string
  /** 显示名 */
  label: string
  /** 搜索关键词 */
  keywords: string[]
  /** 功能分组 */
  group: RuleGroup
  /** 是否支持输入时自动校准 */
  supportsAuto: boolean
}

/** 细粒度排版格式化开关。
 *  RuleScopes 字段由 RULE_DEFS 驱动；其余为样式偏好 / 数值参数，不区分作用域。 */
export interface CJKFormattingSettings {
  // Rule-scoped fields
  cjkEnglishSpacing: RuleScopes
  cjkParenthesisSpacing: RuleScopes
  currencySpacing: RuleScopes
  slashSpacing: RuleScopes
  fullwidthPunctuation: RuleScopes
  fullwidthAlphanumeric: RuleScopes
  dashConversion: RuleScopes
  emdashSpacing: RuleScopes
  smartQuoteConversion: RuleScopes
  contextualQuotes: RuleScopes
  quoteSpacing: RuleScopes
  singleQuoteSpacing: RuleScopes
  cjkNestedQuotes: RuleScopes
  ellipsisNormalization: RuleScopes
  newlineCollapsing: RuleScopes
  spaceCollapsing: RuleScopes
  trailingSpaceRemoval: RuleScopes
  // Non-rule fields (style preferences / numeric params)
  quoteStyle: QuoteStyle
  cjkCornerQuotes: boolean
  consecutivePunctuationLimit: number // 0=off, 1=single, 2=double
  skipReferenceSections: boolean
}

/** 所有支持 RuleScopes 的规则定义，驱动 UI 渲染 + hydrate 迁移。
 *  未来新增规则（含非 CJK 规则）只需在此数组追加一条。 */
export const RULE_DEFS: readonly RuleDef[] = [
  // spacing
  { key: 'cjkEnglishSpacing', label: '中英文间距', keywords: ['spacing', '中英文', '间距', '空格', '混排'], group: 'spacing', supportsAuto: true },
  { key: 'cjkParenthesisSpacing', label: '括号间距', keywords: ['parenthesis', 'spacing', '括号', '间距'], group: 'spacing', supportsAuto: false },
  { key: 'currencySpacing', label: '货币单位', keywords: ['currency', '货币', '单位', '间距'], group: 'spacing', supportsAuto: false },
  { key: 'slashSpacing', label: '斜杠间距', keywords: ['slash', '斜杠', '间距'], group: 'spacing', supportsAuto: false },
  // punctuation
  { key: 'fullwidthPunctuation', label: '全角标点', keywords: ['fullwidth', 'punctuation', '标点', '全角', '逗号', '句号'], group: 'punctuation', supportsAuto: true },
  { key: 'fullwidthAlphanumeric', label: '全角字母数字', keywords: ['fullwidth', 'alphanumeric', '字母', '数字', '全角'], group: 'punctuation', supportsAuto: false },
  { key: 'dashConversion', label: '破折号转换', keywords: ['dash', '破折号', '转换'], group: 'punctuation', supportsAuto: true },
  { key: 'emdashSpacing', label: '破折号间距', keywords: ['emdash', 'spacing', '破折号', '间距'], group: 'punctuation', supportsAuto: false },
  // quote
  { key: 'smartQuoteConversion', label: '智能引号', keywords: ['smart', 'quote', '智能', '引号', '弯引号', '直角引号'], group: 'quote', supportsAuto: true },
  { key: 'contextualQuotes', label: '上下文引号', keywords: ['contextual', 'quote', '上下文', '引号'], group: 'quote', supportsAuto: false },
  { key: 'quoteSpacing', label: '引号间距', keywords: ['quote', 'spacing', '引号', '间距'], group: 'quote', supportsAuto: false },
  { key: 'singleQuoteSpacing', label: '单引号间距', keywords: ['single', 'quote', 'spacing', '单引号', '间距'], group: 'quote', supportsAuto: false },
  { key: 'cjkNestedQuotes', label: '嵌套引号', keywords: ['nested', 'quote', '嵌套', '引号'], group: 'quote', supportsAuto: false },
  // cleanup
  { key: 'ellipsisNormalization', label: '省略号归一', keywords: ['ellipsis', '省略号', '归一'], group: 'cleanup', supportsAuto: false },
  { key: 'newlineCollapsing', label: '空行折叠', keywords: ['newline', 'collapsing', '空行', '折叠'], group: 'cleanup', supportsAuto: false },
  { key: 'spaceCollapsing', label: '空格折叠', keywords: ['space', 'collapsing', '空格', '折叠'], group: 'cleanup', supportsAuto: false },
  { key: 'trailingSpaceRemoval', label: '行尾空格', keywords: ['trailing', 'space', '行尾', '空格'], group: 'cleanup', supportsAuto: false },
] as const

/** 创建一份默认 RuleScopes（auto 和 format 均为 true） */
function on(): RuleScopes {
  return { auto: true, format: true }
}

/** 创建一份全默认排版配置（每次调用返回独立副本，安全用于 store 初始化） */
export function createDefaultFormatting(): CJKFormattingSettings {
  return {
    // spacing
    cjkEnglishSpacing: on(),
    cjkParenthesisSpacing: on(),
    currencySpacing: on(),
    slashSpacing: on(),
    // punctuation
    fullwidthPunctuation: on(),
    fullwidthAlphanumeric: on(),
    dashConversion: on(),
    emdashSpacing: on(),
    // quote
    smartQuoteConversion: on(),
    contextualQuotes: on(),
    quoteSpacing: on(),
    singleQuoteSpacing: on(),
    cjkNestedQuotes: on(),
    // cleanup
    ellipsisNormalization: on(),
    newlineCollapsing: on(),
    spaceCollapsing: on(),
    trailingSpaceRemoval: on(),
    // non-rule
    quoteStyle: 'curly',
    cjkCornerQuotes: false,
    consecutivePunctuationLimit: 0,
    skipReferenceSections: false,
  }
}

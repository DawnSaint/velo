/**
 * CJK 排版格式化器 — Barrel Export
 *
 * 类型定义 + 规则元数据（辅助输入功能依赖）。
 * 格式化命令管线（formatter / rules）将在后续提交中加入。
 *
 * @module lib/cjkFormatter
 */

export type { CJKFormattingSettings, QuoteStyle, RuleScopes, RuleDef, RuleGroup } from './types'
export { createDefaultFormatting, RULE_DEFS } from './types'

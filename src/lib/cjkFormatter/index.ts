/**
 * CJK 排版格式化器 — Barrel Export
 *
 * 提供排版文本的智能格式化：中英文间距、全角标点、直角引号等。
 * 框架无关的纯 TypeScript 库，操作 markdown 文本字符串。
 *
 * 架构：
 *   formatter.ts — 编排流水线（解析 → 分段 → 规则 → 重建 → 完整性校验）
 *   markdownParser.ts — 识别保护区（代码块、URL、数学公式等）跳过格式化
 *   segments.ts — 提取可格式化段并重建文档
 *   rules/ — 5 组格式化规则
 *   latinSpanScanner.ts — 在 CJK 文本中识别技术子段（URL、版本号等）保护标点
 *   quotePairing.ts — 栈式引号配对（撇号 / 角分符号 / 年代缩写识别 + 4 模式：off / curly-everywhere / contextual / corner-for-cjk）
 *   integrity.ts — 格式化后结构模式计数校验
 *
 * @module lib/cjkFormatter
 */

export { formatMarkdown, formatSelection } from './formatter'
export type { CJKFormattingSettings, RuleScopes } from './types'
export { createDefaultFormatting, RULE_DEFS } from './types'

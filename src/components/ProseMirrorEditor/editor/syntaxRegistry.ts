// 语法实时转换注册表。
//
// 旧路径每条语法各自一个 InputRule 或 Plugin —— 扫描黑名单(code mark / code_block /
// 编辑态 link session)各写一遍,新增语法成本高;且 InputRule 只对"键入紧贴匹配
// 末尾"响应,粘贴 / 中间补回 / 非顺序输入(先 `]` 再 `[^xxx`)都漏抓。
//
// 这里只暴露**接口 + register API**,真正干活的 plugin 在 plugins/syntaxAutoFormat.ts。
// 每个语法只声明 pattern + apply,黑名单 / dirty-range / linkClick session 这些
// 公共风险由框架 plugin 兜底。
//
// 设计要点(对接 plugins/syntaxAutoFormat.ts):
// - **block 层**:段首语法,框架取每个 dirty paragraph 段首文本跑 pattern;
//   命中后 apply 调 tr.setBlockType / wrapIn / replaceWith 改造整段。
// - **inline 层**:段内语法,框架对 textblock 内的纯文本跑 g 正则,逐 match
//   反向调 apply。inline 不在 code mark / atom 节点上跑(框架级过滤)。
// - **apply 直接修改 tr**:框架传入 newState 的 transaction,语法在上面累加 step,
//   返回 true = 已修改。这样多个 match 共用 tr.mapping,不需要语法自己处理位移。

import type { Transaction } from 'prosemirror-state'
import type { Schema } from 'prosemirror-model'

// ============================================================
//  Block 层
// ============================================================

export interface BlockSyntaxApplyContext {
  schema: Schema
  /** 段落内容起始(段落 open tag 之后)。已经过 tr.mapping 校正。 */
  blockStart: number
  /** 段落内容结束。 */
  blockEnd: number
  /** pattern.exec(blockText) 的结果。 */
  match: RegExpMatchArray
}

export interface BlockSyntax {
  name: string
  /**
   * 段首语法的正则。**必须**带 `^` 锚点;框架不自动加。
   * 不要带 `g` flag,block 层只取首个匹配。
   * 触发时机由 pattern 自己决定(如尾部 ` ` 表示空格触发,`\n` / `$` 表示换行触发)。
   */
  pattern: RegExp
  /**
   * 在 tr 上累加 step 实现转换。返回 true 表示已修改 tr,false 表示放弃这次匹配。
   * 实现里可以读 ctx.match[1..n] 拿捕获组。
   */
  apply(tr: Transaction, ctx: BlockSyntaxApplyContext): boolean
}

// ============================================================
//  Inline 层
// ============================================================

export interface InlineSyntaxApplyContext {
  schema: Schema
  /** 当前 match 在 tr.doc 上的范围起点(已经过 tr.mapping 校正)。 */
  from: number
  /** 当前 match 在 tr.doc 上的范围终点。 */
  to: number
  /** pattern.exec 在段落 textContent 上的匹配结果。 */
  match: RegExpMatchArray
}

export interface InlineSyntax {
  name: string
  /**
   * 段内语法的正则。**必须**带 `g` flag —— 框架对每个段落跑 matchAll。
   * 不要带 `^` / `$`(段落级匹配,不是行级)。
   */
  pattern: RegExp
  /** 同 BlockSyntax.apply,返回 true 表示已修改 tr。 */
  apply(tr: Transaction, ctx: InlineSyntaxApplyContext): boolean
}

// ============================================================
//  Registry —— 模块级单例
// ============================================================

const blockSyntaxes: BlockSyntax[] = []
const inlineSyntaxes: InlineSyntax[] = []

export function registerBlockSyntax(syntax: BlockSyntax): void {
  // 同名覆盖:HMR 友好;register 顺序仍然是匹配优先级
  const existing = blockSyntaxes.findIndex(s => s.name === syntax.name)
  if (existing >= 0) {
    blockSyntaxes[existing] = syntax
    return
  }
  blockSyntaxes.push(syntax)
}

export function registerInlineSyntax(syntax: InlineSyntax): void {
  const existing = inlineSyntaxes.findIndex(s => s.name === syntax.name)
  if (existing >= 0) {
    inlineSyntaxes[existing] = syntax
    return
  }
  inlineSyntaxes.push(syntax)
}

export function getBlockSyntaxes(): readonly BlockSyntax[] {
  return blockSyntaxes
}

export function getInlineSyntaxes(): readonly InlineSyntax[] {
  return inlineSyntaxes
}

/** 测试用:重置 registry。生产代码不应调用。 */
export function _resetSyntaxRegistry(): void {
  blockSyntaxes.length = 0
  inlineSyntaxes.length = 0
}

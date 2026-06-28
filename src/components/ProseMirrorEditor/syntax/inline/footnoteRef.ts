// `[^id]` → footnote_reference 节点
//
// 迁自 nodes/FootnoteNodeViews.ts 的 footnoteReferenceInputRule。
//
// 关键改进:不再用 `$` 末尾锚点,改用 `g` 全段扫描。原 InputRule 必须用户
// 顺序输入 `[^xxx]`(光标紧贴 `]` 触发);如果先输 `]` 再前面补 `[^xxx`,
// 就完全不触发。框架走 appendTransaction 不依赖输入顺序,补完整段 `[^xxx]`
// 即转。
//
// 段首 footnote_definition(`[^id]: ...`)由 markdownIO 在外部解析阶段产生,
// 实时键入态不补这条 —— 用户键入 `[^x]: foo` 时 `[^x]` 部分会被这条规则
// 转成 footnote_reference,再加 `: foo` 不变成 definition;这是已知限制,
// 与原 InputRule 行为一致。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const footnoteRefSyntax: InlineSyntax = {
  name: 'footnoteRef',
  pattern: /\[\^([^\s\]]+)\]/g,
  apply(tr, { schema, from, to, match }) {
    const label = match[1]
    if (!label) return false
    const type = schema.nodes.footnote_reference
    if (!type) return false
    // 段首位置不转 —— 这是 footnote_definition 的起手,留给 markdown 序列化往返
    // 来识别(原 InputRule 也有同样的 parentOffset === 0 防御)
    const $from = tr.doc.resolve(from)
    if ($from.parentOffset === 0) return false
    // label 作为 footnote_reference 的 text content(非 attrs.label)
    tr.replaceRangeWith(from, to, type.create(null, [schema.text(label)]))
    return true
  },
}

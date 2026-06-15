// `$x$` → math_inline 节点
//
// 迁自 EditorInner.vue 的 inlineMathInputRule:
//   原 `\$([^$\n]+)\$$` —— 末尾紧贴触发
//   去 `$` + 加 `g`,语义不变(段落内任意位置 `$x$` 都转)
//
// 注意:remark-math / markdownIO 走的是**外部 markdown 解析**;EditorView
// 实时键入不经过 unified,必须靠 syntax framework 显式转换。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const inlineMathSyntax: InlineSyntax = {
  name: 'inlineMath',
  pattern: /\$([^$\n]+)\$/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const type = schema.nodes.math_inline
    if (!type) return false
    tr.replaceRangeWith(from, to, type.create(null, schema.text(inner)))
    return true
  },
}

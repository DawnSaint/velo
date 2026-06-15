// `[text](url)` → text + link mark
//
// 框架已经处理:
//  - 编辑态 link session 范围跳过(框架级 linkEditRange 检测)
//  - code mark / code_block / html_block 跳过(框架黑名单)
//  - 已带 link mark 的文本:由这里 apply 自己防御(下面 markFilter)

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const linkSyntax: InlineSyntax = {
  name: 'link',
  // text 不含 ] 和换行;url 不含 (),允许内部空格/中文(尾部空格 trim)
  // 例:`[回到开头](# Markdown 语法)` 内部空格保留(作为 href 一部分),
  // 但 linkClick 的 scrollToAnchor 会做 slug 化降级匹配,详见 plugins/linkClick.ts
  pattern: /\[([^\]\n]+)\]\(([^()]+?)\s*\)/g,
  apply(tr, { schema, from, to, match }) {
    const linkText = match[1]
    const url = match[2]
    if (!linkText || !url) return false
    const linkMarkType = schema.marks.link
    if (!linkMarkType) return false

    // 已带 link mark 的范围跳过(粘贴已渲染的链接节点 / 框架自己生成的 tr 二次扫)
    let alreadyLinked = false
    tr.doc.nodesBetween(from, to, (n) => {
      if (n.isText && n.marks.some(m => m.type === linkMarkType)) {
        alreadyLinked = true
        return false
      }
      return true
    })
    if (alreadyLinked) return false

    const linkMark = linkMarkType.create({ href: url })
    tr.replaceWith(from, to, schema.text(linkText, [linkMark]))
    return true
  },
}

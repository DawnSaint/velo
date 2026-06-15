// `[text](url)` → text + link mark
//
// 迁自 plugins/linkClick.ts 的 linkAutoFormatPlugin。
//
// 框架已经处理:
//  - 编辑态 link session 范围跳过(框架级 linkEditRange 检测)
//  - code mark / code_block / html_block 跳过(框架黑名单)
//  - 已带 link mark 的文本:由这里 apply 自己防御(下面 markFilter)
//
// 注意 vs 原 linkAutoFormatPlugin:
//  - 原插件遍历整篇 doc 的所有 textnode,对每个跑 g 正则;
//  - 现在框架只把 dirty textblock 喂进来,且 textblock 内 textContent 含 atom 占位
//    ` `(NBSP)—— atom 范围我们已经在框架里跳过,这里 apply 只看 from..to
//    确实是纯 text 范围。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const linkSyntax: InlineSyntax = {
  name: 'link',
  // text 不含 ] 和换行;url 不含 () 和空白
  pattern: /\[([^\]\n]+)\]\(([^()\s]+)\)/g,
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

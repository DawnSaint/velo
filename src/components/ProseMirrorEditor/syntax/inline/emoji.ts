// `:smile:` → emoji node
//
// GitHub Flavored Markdown 风格的 emoji 短码。与 highlight / sup 同范式:
// 段内 g 正则扫描,命中后 delete + insert emoji node。
//
// 短码必须在 node-emoji 表中存在才转换为 emoji 节点,不存在则保留为纯文本
// (避免 `:word:` 被误吞)。code mark / code_block 内不转换(框架级过滤)。
//
// 正则:`/:([\w+-]+):/g`
//   - shortcode 只允许字母/数字/下划线/连字符/加号
//   - 两侧 `:` 紧邻,`12:30`(只有一个 `:`)不匹配
//
// registry 顺序放在 htmlTag 之前 —— `:` 不是 HTML 标签字符,不会与 htmlTag
// 冲突,但放在前面保证 `:smile:` 优先被 emoji 转换。

import type { InlineSyntax } from '../../editor/syntaxRegistry'
import { has as emojiHas } from 'node-emoji'

export const emojiSyntax: InlineSyntax = {
  name: 'emoji',
  pattern: /:([\w+-]+):/g,
  apply(tr, { schema, from, to, match }) {
    const shortcode = match[1]
    if (!shortcode || !emojiHas(shortcode)) return false
    const emojiType = schema.nodes.emoji
    if (!emojiType) return false
    tr.delete(from, to)
    tr.insert(from, emojiType.create({ shortcode }))
    return true
  },
}

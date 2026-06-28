// `<tag>content</tag>` 或 `<tag/>` → html_inline 节点
//
// 让用户可以在编辑器里直接键入 HTML 行内标签（如 `<kbd>Mod</kbd>`），
// 实时转成 html_inline 节点，与 fromMarkdown 解析已有 HTML 的行为一致。
//
// 触发条件：**完整闭合**才转。敲到一半的开标签如 `<kbd>` 保留为 plain text,
// 不做"半截就固化"的优化 —— 用户期望边敲边编辑,过早转 atom 反而会把光标
// 锁在 atom 之后,backspace 删不掉刚敲的 `<kbd>`,体验更差。source mode
// 上看到 `\<kbd>` 类的反斜杠是 mdast-util-to-markdown 的 safe() 对 prose
// text 里 `<` 后接字母/!/?// 的合法转义(CommonMark 规范要求),属正常行为,
// 不在编辑器层去对抗 round-trip 完整性。
//
// 支持:
// - 成对标签: `<tag>content</tag>`
// - 自闭合标签: `<tag/>` 或 `<tag attr="value"/>`
//
// 限制:
// - content 不能包含 `<`（不支持嵌套 HTML 标签，嵌套请走源码模式）
// - 只匹配"正规"HTML 标签名（字母开头，后接字母数字）
// - 开/闭标签名必须一致（由 regex 捕获组 + 反向引用保证）

import type { InlineSyntax } from '../../editor/syntaxRegistry'

const TAG_NAME = '([a-zA-Z][a-zA-Z0-9]*)'
const ATTRS = '(?:\\s[^>]*)?' // optional attributes (whitespace + non-> characters)
const CONTENT = '[^<]*' // content without <

// 成对标签：开标签捕获组 #1，闭标签用 \1 反向引用强制一致
const PAIRED = `<${TAG_NAME}${ATTRS}>${CONTENT}<\\/\\1>`
// 自闭合标签：捕获组 #2（与成对标签的 #1 不冲突，因为 | 分叉）
const SELF_CLOSE = `<${TAG_NAME}${ATTRS}\\/>`

export const htmlTagSyntax: InlineSyntax = {
  name: 'htmlTag',
  pattern: new RegExp(`${PAIRED}|${SELF_CLOSE}`, 'g'),
  apply(tr, { schema, from, to, match }) {
    const htmlString = match[0]
    if (!htmlString) return false
    const type = schema.nodes.html_inline
    if (!type) return false
    tr.replaceRangeWith(from, to, type.create({ value: htmlString }))
    return true
  },
}

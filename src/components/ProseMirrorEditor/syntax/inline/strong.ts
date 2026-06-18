// `**text**` / `__text__` → strong(bold)
//
// 双形式 alternation:一个 pattern 里处理 `**` 和 `__` 两种包裹。
// 关键边界:
//   `**` 形式
//     - `(?<!\*)` 开口前不是 `*`(挡 `***bold***` 被当 `**` + `*bold*` + `*`)
//     - `(?!\s)` 开口后不是空白
//     - `([^\n*]+?)` inner 不含 `*`(跨不过下个 `**`)
//     - `(?<!\s)` inner 末尾不是空白
//     - `(?!\*)` 闭口后不是 `*`(允许 word 字符 —— CommonMark 接受 `a**b**c`,
//       也允许 `**b***` 留下尾部 `*`;只挡 `**b**` 紧跟更多 `*` 的歧义)
//   `__` 形式(对称规则,inner 不含 `_`)
// 与 emphasisStar(`*x*`)互斥靠 `(?<!\*)` 前缀 + inner `[^\n*]`(strong inner 不含 `*`,
// 反过来 emphasisStar inner 不含 `*` 也保证不会被 strong 抢先吞)
// marker attrs: `**` 用 `*`,`__` 用 `_`,跟 toMarkdown 端 wrapWithMarks 序列化的
// marker 字段对应,保证 round-trip 不串(`**bold**` 不会变 `__bold__`)

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const strongSyntax: InlineSyntax = {
  name: 'strong',
  pattern: /(?<!\*)\*{2}(?!\s)([^\n*]+?)(?<!\s)\*{2}(?!\*)|(?<!_)_{2}(?![_\s])([^_\n]+?)(?<![_\s])_{2}(?!_)/g,
  apply(tr, { schema, from, to, match }) {
    // alternation:match[1]=** 形式 inner,match[2]=__ 形式 inner
    const inner = match[1] ?? match[2]
    const isStarForm = match[1] != null
    if (!inner) return false
    const strongType = schema.marks.strong
    if (!strongType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, strongType.create({ marker: isStarForm ? '*' : '_' }))
    return true
  },
}
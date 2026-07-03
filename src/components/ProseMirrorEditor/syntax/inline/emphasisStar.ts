// `*text*` → emphasis(italic)
//
// 与 emphasisUnderscoreSyntax(`_text_`)并列,处理 `*` 包裹。
// 关键的 regex 边界(避免与 strong 的 `**` 互锁):
//   - `(?<!\*)` 开口前不是 `*`(挡 `**bold**` 被当 `*` + `bold` + `*`)
//   - `(?!\s|\*)` 开口后不是空白 / `*`(挡 `**` / `* * *`)
//   - `([^\n*]+?)` inner 不含换行 / `*`(惰性,跨不过 `**`)
//   - `(?<!\s|\*)` inner 末尾不是空白 / `*`
//   - `(?!\*|\w)` 闭口后不是 `*` / 单词字符(挡 `*not*italic*` 这种未配对的尾巴)
//
// 与 strong 的优先级:两个 syntax 都不靠顺序,各自 regex 自带边界防误识别。
// registry 顺序里 emphasisStar 在 strong 之前,先跑挑剔的 regex,新 doc 再给 strong 扫。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const emphasisStarSyntax: InlineSyntax = {
  name: 'emphasisStar',
  pattern: /(?<!\*)\*(?!\s|\*)([^\n*]+?)(?<!\s|\*)\*(?!\*|\w)/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const emphasisType = schema.marks.emphasis
    if (!emphasisType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, emphasisType.create({ marker: '*' }))
    // 闭合后移除 storedMark,避免继续输入继承(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(emphasisType)
    return true
  },
}
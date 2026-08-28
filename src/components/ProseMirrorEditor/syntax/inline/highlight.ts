// `==text==` → highlight
//
// Obsidian / Logseq 风格的高亮语法。schema 端 `highlight` mark 在 toDOM
// 输出 `<mark>`,复用 `_editor-typography.scss:108` 已有的 `#fff3a3` 黄色背景。
//
// regex 边界:
//   - `(?<![/:])` 开口前不是 `:` / `/`(挡 URL `https://` 中的 `==` 被误切)
//   - `([^=\n]+?)` inner 不含换行 / `=`(惰性,跨不过下个 `==`)
//   - `(?![\w|/])` 闭口后不是单词 / `|` / `/`
//
// 与 remarkHighlight 端的 HL_RE lookbehind 对齐:允许 `a==bc==` 中 `==`
// 前面紧跟单词字符(Obsidian/Logseq 接受 `word==hl==word`),只挡 URL 的
// `:` 和 `/`。旧版用 `(?<![\w:/])` 挡了 `\w`,导致 `a==bc==` 无法识别。
//
// registry 顺序放最末 —— highlight 是新增 mark,不抢前面的 link / footnote /
// math / strike / emphasis 匹配机会。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const highlightSyntax: InlineSyntax = {
  name: 'highlight',
  pattern: /(?<![/:])==([^=\n]+?)==(?![\w|/])/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const highlightType = schema.marks.highlight
    if (!highlightType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, highlightType.create())
    // 闭合后移除 storedMark,避免继续输入继承(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(highlightType)
    return true
  },
}
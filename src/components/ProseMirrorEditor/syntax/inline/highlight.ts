// `==text==` → highlight
//
// Obsidian / Logseq 风格的高亮语法。schema 端 `highlight` mark 在 toDOM
// 输出 `<mark>`,复用 `_editor-typography.scss:108` 已有的 `#fff3a3` 黄色背景。
//
// regex 边界与现有 strike 同款:
//   - `(?<![\w:/])` 开口前不是单词 / `:` / `/`(挡 URL `https://`)
//   - `([^=\n]+?)` inner 不含换行 / `=`(惰性,跨不过下个 `==`)
//   - `(?![\w|/])` 闭口后不是单词 / `/`
//
// registry 顺序放最末 —— highlight 是新增 mark,不抢前面的 link / footnote /
// math / strike / emphasis 匹配机会。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const highlightSyntax: InlineSyntax = {
  name: 'highlight',
  pattern: /(?<![\w:/])==([^=\n]+?)==(?![\w|/])/g,
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
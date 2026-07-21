// `^text^` → superscript mark
//
// Obsidian / Logseq / Pandoc 风格的上标语法。
// 与 highlight / strike 同范式:段内 g 正则扫描,命中后 delete + insertText + addMark。
//
// 边界:
//   - `(?<!\^)` 开口前不是 `^`(挡 `^^` 空匹配)
//   - `([^\n^]+?)` inner 不含 `^` / 换行(惰性,跨不过下个 `^`)
//   - `(?!\^)` 闭口后不是 `^`
// 允许单词字符紧邻(支持 `x^2^`),与 remarkSupSub 的 mdast 解析正则一致。
// math 的 `^` 在 `$...$` 内已被 math_inline 吃掉,不进文本;footnote `[^id]`
// 由 footnoteRef 正则先抢,且 id 不含 `^`,无冲突。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const supSyntax: InlineSyntax = {
  name: 'superscript',
  pattern: /(?<!\^)\^([^\n^]+?)\^(?!\^)/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const markType = schema.marks.superscript
    if (!markType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, markType.create())
    // 闭合后移除 storedMark,避免继续输入继承(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(markType)
    return true
  },
}

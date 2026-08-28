// `~text~` → subscript mark
//
// Obsidian / Logseq / Pandoc 风格的单波浪号下标语法。
// 与 sup / highlight 同范式:段内 g 正则扫描,命中后 delete + insertText + addMark。
//
// 关键约束(与 sup 不同):`~` 同时承载删除线(双 `~~`),所以单 `~` 的
// 前后边界都必须排除 `~`,防 `~~text~~` 被当下标误切:
//   - `(?<![/:~])` 开口前不是 `:` / `/` / `~`(挡 URL + 防 `~~`)
//   - `([^\n~]+?)` inner 不含 `~`/换行
//   - `(?!~)` 闭口后不是 `~`(防 `~~`)
//
// 与 remarkSupSub 端的 SUB_RE 对齐:允许 `H~2~O` 这类单词字符
// 紧邻(化学式),只挡 URL 的 `:` / `/` 和 `~`(防与 `~~` 冲突)。
//
// 注册顺序:必须在 strike 之前 —— `~text~` 优先命中下标,`~~text~~` fall
// 到 strike。但 `strike` 的 regex 是 `~{1,2}` 含单 `~`,所以实际靠
// sub 的正则边界排除 `~` + 注册顺序共同保证:`~text~` 先被 sub 吃,
// `~~text~~` 因 sub 闭口边界 `(?!~)` 不匹配,留给 strike。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const subSyntax: InlineSyntax = {
  name: 'subscript',
  pattern: /(?<![/:~])~([^\n~]+?)~(?!~)/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const markType = schema.marks.subscript
    if (!markType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, markType.create())
    // 闭合后移除 storedMark,避免继续输入继承(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(markType)
    return true
  },
}

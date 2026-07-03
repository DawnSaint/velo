// `` `code` `` → code mark
//
// 行内代码:backtick 围栏。schema 端 `code` mark(`code: true` + `excludes: '_'`,
// 独占 —— 不能与 strong / emphasis 等并存)在 toDOM 输出 `<code>`。
//
// regex 边界(与 strike 的 backref 范式同款,1+ backtick 必须对称):
//   - `(?<!`)` 开口前不是 backtick(挡更长 backtick 串的内部重匹配)
//   - `(`+)` 开口 backtick 串(1 个或多个,CommonMark 允许 `` `` .. `` ``)
//   - `([^`\n]+?)` inner 不含 backtick / 换行(惰性,跨不过下个等长 backtick 串)
//   - `\1` 闭口与开口等长的 backtick 串(backref,保 1 ` 配 1 `、2 ` 配 2 `)
//   - `(?!`)` 闭口后不是 backtick(防向后延伸吞相邻 backtick)
//
// inner 不含 backtick,故含 backtick 的 `` `` a`b `` `` 这类多 backtick 代码不会被
// 实时键入转换(已知限制;源文件加载走 fromMarkdown/remark-parse 仍完整支持)。
// code mark 是 excludes:'_' 独占,闭合后 removeStoredMark 阻止边界继续继承
// (与 highlight / strike 同款;code 无 Ctrl+` 连续输入命令,但保持一致语义)。
//
// registry 顺序:放 highlight 之后、htmlTag 之前 —— backtick 不与 `==` / `~~` /
// `**` 抢匹配,且 code 独占不会嵌进其他 mark;htmlTag 走 `<...>` 与 backtick 无关。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const inlineCodeSyntax: InlineSyntax = {
  name: 'inlineCode',
  pattern: /(?<!`)(`+)([^`\n]+?)\1(?!`)/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[2]
    if (!inner) return false
    const codeType = schema.marks.code
    if (!codeType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, codeType.create())
    // 闭合后移除 storedMark,避免继续输入继承 code mark(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(codeType)
    return true
  },
}

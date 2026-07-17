// `<u>text</u>` → underline mark
//
// 与 highlight / strike 同范式:段内 g 正则扫描,命中后 delete + insertText + addMark。
// 必须注册在 htmlTag 之前 —— 否则 <u>text</u> 会被 htmlTag 抢转成 html_inline atom,
// underline mark 语义丢失。
//
// 边界:
// - inner 不含 `<`(不支持嵌套 HTML)和换行(纯行内)
// - inner 至少 1 字符(空 `<u></u>` 不匹配 —— Ctrl+U 快捷键通过 skipSyntaxAutoFormat
//   meta 防止 htmlTag 抢转空标记)
// - 只匹配无属性的 `<u>`(带属性如 `<u class="x">` 走 htmlTag → html_inline)

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const underlineSyntax: InlineSyntax = {
  name: 'underline',
  pattern: /<u>([^<\n]+?)<\/u>/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const underlineType = schema.marks.underline
    if (!underlineType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, underlineType.create())
    // 闭合后移除 storedMark,避免继续输入继承(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(underlineType)
    return true
  },
}

// `~~text~~` / `~text~` → strike_through
//
// 迁自 EditorInner.vue 的 fixedStrikethroughInputRule:
//   原 `(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)$` —— 末尾紧贴触发
//   去 `$` + 加 `g`。`(?<![\w:/])` 防 URL 误匹配(`http://x~y`),保留。
//
// 内部 backref `\1` 保留 —— 1 个 `~` 与 2 个 `~` 必须对称。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const strikeSyntax: InlineSyntax = {
  name: 'strike',
  pattern: /(?<![\w:/])(~{1,2})([^\n]+?)\1(?!\w|\/)/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[2]
    if (!inner) return false
    const strikeType = schema.marks.strike_through
    if (!strikeType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, strikeType.create())
    return true
  },
}

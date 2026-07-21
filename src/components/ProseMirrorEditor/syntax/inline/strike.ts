// `~~text~~` → strike_through
//
// 迁自 EditorInner.vue 的 fixedStrikethroughInputRule:
//   原 `(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)$` —— 末尾紧贴触发
//   去 `$` + 加 `g`。`(?<![\w:/])` 防 URL 误匹配(`http://x~y`),保留。
//
// 内部 backref `\1` 保留 —— 开闭必须对称。
//
// v0.7.x 起只匹配双 `~~`(`{2}`),单 `~` 让给下标(subscript)。
// 这是 breaking change:旧版 `~text~` 是删除线,改版后变下标。
// 注意:backref 用 `\1` 引用首组 `(~{2})`,保证开闭对称(都是 ~~)。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const strikeSyntax: InlineSyntax = {
  name: 'strike',
  pattern: /(?<![\w:/])(~{2})([^\n]+?)\1(?!\w|\/)/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[2]
    if (!inner) return false
    const strikeType = schema.marks.strike_through
    if (!strikeType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, strikeType.create())
    // 闭合后移除 storedMark,避免继续输入继承(设计要点见 editor.md syntax 节)
    tr.removeStoredMark(strikeType)
    return true
  },
}

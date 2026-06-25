// `_text_` → emphasis(italic)
//
// 迁自 EditorInner.vue 的 fixedEmphasisUnderscoreInputRule:
//   原 `\b_(?![_\s])(.*?[^_\s])_\b$` —— `$` 锚点,只在末尾紧贴时触发
//   现去掉 `$`、加 `g` flag,框架对整段 matchAll
//
// `*` 包裹的 italic / `**` 包裹的 bold 当前 schema 下不通过 input 触发
// (历史遗留,见 docs/architecture/editor.md 的 syntax auto-format 说明),这里也不补 —— 后续单独
// 加 `syntax/inline/strong.ts` / 修订 emphasisStar 时再加,本次维持现状。

import type { InlineSyntax } from '../../editor/syntaxRegistry'

export const emphasisUnderscoreSyntax: InlineSyntax = {
  name: 'emphasisUnderscore',
  // \b_xxx_\b,内层非空非空白,首尾不空白,不带换行
  pattern: /\b_(?![_\s])([^_\n]+?[^_\s])_\b/g,
  apply(tr, { schema, from, to, match }) {
    const inner = match[1]
    if (!inner) return false
    const emphasisType = schema.marks.emphasis
    if (!emphasisType) return false
    tr.delete(from, to)
    tr.insertText(inner, from)
    tr.addMark(from, from + inner.length, emphasisType.create({ marker: '_' }))
    return true
  },
}

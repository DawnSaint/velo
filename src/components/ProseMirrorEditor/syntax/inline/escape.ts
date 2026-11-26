// `\<ASCII punct>` → 带 escape mark 的单字符文本（CommonMark §2.4）。
//
// 必须注册在所有其他 inline syntax 之前：当段落里存在 `\*` / `\[` 等转义序列时，
// 先将其转为带 escape mark 的字符，syntaxAutoFormat 的 buildBlockText 会把它
// 掩码成 `\uE000`，后续 emphasis / strong / link / math 等语法就不会再把转义后的
// 标点误认成语法界定符。
//
// 例外：以 `$$\n` 开头的未闭合数学公式段落不触发（用户在敲 LaTeX `\\` / `\_`）。

import type { InlineSyntax } from '../../editor/syntaxRegistry'
import { ESCAPE_MARK, ESCAPE_PAIR_RE } from '../../editor/escape'

const MATH_BLOCK_PREFIX_RE = /^\${2,}\n/

export const escapeSyntax: InlineSyntax = {
  name: 'escape',
  pattern: ESCAPE_PAIR_RE,
  apply(tr, { schema, from, to, match }) {
    const ch = match[1]
    if (!ch) return false
    const escapeType = schema.marks[ESCAPE_MARK]
    if (!escapeType) return false

    const $from = tr.doc.resolve(from)
    const blockText = tr.doc.textBetween($from.start(), $from.end(), '\n', '\n')
    if (MATH_BLOCK_PREFIX_RE.test(blockText)) return false

    // 保留外层已有的 mark（如在粗体 Ctrl+B 连续输入中输入 `\*`）
    const existingMarks = tr.doc.resolve(Math.min(from + 1, to)).marks()
      .filter(m => m.type !== escapeType)
    tr.replaceWith(from, to, schema.text(ch, existingMarks.concat(escapeType.create())))
    tr.removeStoredMark(escapeType)
    return true
  },
}

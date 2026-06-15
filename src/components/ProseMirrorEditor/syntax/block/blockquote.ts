// `> ` → blockquote 包裹当前段
//
// 触发时机:段首 `> `(单空格)。把当前 paragraph 提升到 blockquote 内。

import { TextSelection } from 'prosemirror-state'
import { Fragment } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

export const blockquoteSyntax: BlockSyntax = {
  name: 'blockquote',
  pattern: /^> /,
  apply(tr, { schema, blockStart, blockEnd }) {
    const blockquoteType = schema.nodes.blockquote
    const paragraphType = schema.nodes.paragraph
    if (!blockquoteType || !paragraphType) return false

    // 当前段必须是 paragraph;blockquote 内嵌的 paragraph 也允许(产生嵌套 blockquote)
    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    // 段落外边界
    const paraOuterStart = blockStart - 1
    const paraOuterEnd = blockEnd + 1

    // 取段内内容(去掉 `> ` 前缀),包成 blockquote(paragraph(rest))
    const innerContent = tr.doc.slice(blockStart + 2, blockEnd).content
    const newParagraph = paragraphType.create(null, innerContent)
    const newBlockquote = blockquoteType.create(null, Fragment.from(newParagraph))

    tr.replaceRangeWith(paraOuterStart, paraOuterEnd, newBlockquote)

    // 光标落到新段落起点(blockquote.start + paragraph.open)
    const cursorPos = paraOuterStart + 2
    const safe = Math.min(cursorPos, tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, safe))
    return true
  },
}

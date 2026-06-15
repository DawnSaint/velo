// `1. ` / `42. ` → ordered_list

import { TextSelection } from 'prosemirror-state'
import { Fragment } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

export const orderedListSyntax: BlockSyntax = {
  name: 'orderedList',
  pattern: /^(\d+)\. /,
  apply(tr, { schema, blockStart, blockEnd, match }) {
    const orderedListType = schema.nodes.ordered_list
    const listItemType = schema.nodes.list_item
    const paragraphType = schema.nodes.paragraph
    if (!orderedListType || !listItemType || !paragraphType) return false

    const start = parseInt(match[1], 10)
    if (!Number.isFinite(start)) return false
    const prefixLen = match[0].length

    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    for (let d = $start.depth; d > 0; d--) {
      if ($start.node(d).type.name === 'list_item') return false
    }

    const paraOuterStart = blockStart - 1
    const paraOuterEnd = blockEnd + 1
    const innerContent = tr.doc.slice(blockStart + prefixLen, blockEnd).content
    const newParagraph = paragraphType.create(null, innerContent)
    const newItem = listItemType.create({ listType: 'ordered' }, Fragment.from(newParagraph))
    const newList = orderedListType.create({ order: start }, Fragment.from(newItem))

    tr.replaceRangeWith(paraOuterStart, paraOuterEnd, newList)

    const cursorPos = paraOuterStart + 3
    const safe = Math.min(cursorPos, tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, safe))
    return true
  },
}

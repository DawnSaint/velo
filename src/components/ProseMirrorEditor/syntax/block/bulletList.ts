// - / * / + -> bullet_list, with task-list upgrade support.
//
// A task list can be typed in one pass (`- [ ] `) or in two phases:
// first `- ` creates the list item, then `[ ] ` / `[x] ` upgrades that item.

import { TextSelection } from 'prosemirror-state'
import { Fragment, type ResolvedPos } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

const TASK_PATTERN = /^[-*+] \[([ xX])\] /
const TASK_MARKER_PATTERN = /^\[([ xX])\] /
const BULLET_PATTERN = /^[-*+] /

function ancestorDepth($pos: ResolvedPos, name: string): number {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === name) return d
  }
  return -1
}

export const bulletListSyntax: BlockSyntax = {
  name: 'bulletList',
  pattern: /^(?:[-*+] (?:\[[ xX]\] )?|\[[ xX]\] )/,
  apply(tr, { schema, blockStart, blockEnd }) {
    const bulletListType = schema.nodes.bullet_list
    const listItemType = schema.nodes.list_item
    const paragraphType = schema.nodes.paragraph
    if (!bulletListType || !listItemType || !paragraphType) return false

    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    const text = tr.doc.textBetween(blockStart, blockEnd, '\n', '\n')
    const listItemDepth = ancestorDepth($start, 'list_item')

    if (listItemDepth >= 0) {
      const taskMarkerMatch = TASK_MARKER_PATTERN.exec(text)
      if (!taskMarkerMatch) return false

      const listItem = $start.node(listItemDepth)
      const checked = taskMarkerMatch[1].toLowerCase() === 'x'
      tr.setNodeMarkup($start.before(listItemDepth), undefined, {
        ...listItem.attrs,
        checked,
      })
      tr.delete(blockStart, blockStart + taskMarkerMatch[0].length)
      tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(blockStart)))
      return true
    }

    const taskMatch = TASK_PATTERN.exec(text)
    let prefixLen: number
    let checked: boolean | null = null
    if (taskMatch) {
      prefixLen = taskMatch[0].length
      checked = taskMatch[1].toLowerCase() === 'x'
    }
    else {
      const bulletMatch = BULLET_PATTERN.exec(text)
      if (!bulletMatch) return false
      prefixLen = bulletMatch[0].length
    }

    const paraOuterStart = blockStart - 1
    const paraOuterEnd = blockEnd + 1
    const innerContent = tr.doc.slice(blockStart + prefixLen, blockEnd).content
    const newParagraph = paragraphType.create(null, innerContent)
    const itemAttrs: Record<string, unknown> = { listType: 'bullet' }
    if (checked !== null) itemAttrs.checked = checked
    const newItem = listItemType.create(itemAttrs, Fragment.from(newParagraph))
    const newList = bulletListType.create(null, Fragment.from(newItem))

    tr.replaceRangeWith(paraOuterStart, paraOuterEnd, newList)

    const cursorPos = paraOuterStart + 3
    const safe = Math.min(cursorPos, tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, safe))
    return true
  },
}

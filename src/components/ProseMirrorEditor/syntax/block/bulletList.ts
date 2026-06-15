// `- ` / `* ` / `+ ` → bullet_list,含任务变种 `- [ ] ` / `- [x] `
//
// 任务变种 list_item 带 checked = true/false,与 markdownIO.fromMarkdown 解析
// GFM 任务的 attr 一致。

import { TextSelection } from 'prosemirror-state'
import { Fragment } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

const TASK_PATTERN = /^[-*+] \[([ xX])\] /
const BULLET_PATTERN = /^[-*+] /

export const bulletListSyntax: BlockSyntax = {
  name: 'bulletList',
  pattern: /^[-*+] (?:\[[ xX]\] )?/,
  apply(tr, { schema, blockStart, blockEnd }) {
    const bulletListType = schema.nodes.bullet_list
    const listItemType = schema.nodes.list_item
    const paragraphType = schema.nodes.paragraph
    if (!bulletListType || !listItemType || !paragraphType) return false

    const $start = tr.doc.resolve(blockStart)
    const parent = $start.parent
    if (parent.type.name !== 'paragraph') return false

    // 已经在 list_item 里就不重复 wrap
    for (let d = $start.depth; d > 0; d--) {
      if ($start.node(d).type.name === 'list_item') return false
    }

    const text = tr.doc.textBetween(blockStart, blockEnd, '\n', '\n')
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

    // 光标落到 list > item > paragraph 起点
    const cursorPos = paraOuterStart + 3
    const safe = Math.min(cursorPos, tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, safe))
    return true
  },
}

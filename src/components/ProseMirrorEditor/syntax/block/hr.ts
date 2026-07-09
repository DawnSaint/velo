// `---` / `***` / `___`(单独行)→ thematic break (hr)
//
// 触发时机:段落内容**完全等于** 3+ 个 - / * / _,且段后回车(段落必须为
// 空 paragraph 形态前置,但用户实际操作流程是:段首敲 --- 然后空格 / 回车)。
//
// 行为简化:
//  - 我们只接 `---`(3 个)/ `***` / `___`,不强制 3+ —— 与 GFM 一致允许 3+
//  - 触发前提:段内**仅**这串 + 末尾一个空格(否则看起来仍是用户在敲 ---xxx)
//  - 转换后 hr 占一段,光标落到下一段

import { TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import type { Schema } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

const THEMATIC_BREAK_CHARS = new Set(['-', '_', '*'])

export function isThematicBreakLine(text: string): boolean {
  const leadingSpaces = text.match(/^ */)?.[0].length ?? 0
  if (leadingSpaces > 3) return false
  const rest = text.slice(leadingSpaces)
  if (!/^[-*_ \t]+$/.test(rest)) return false
  const markers = [...text.trim()].filter(ch => ch !== ' ' && ch !== '\t')
  if (markers.length < 3) return false
  const marker = markers[0]
  if (!THEMATIC_BREAK_CHARS.has(marker)) return false
  return markers.every(ch => ch === marker)
}

export function isThematicBreakSpaceTrigger(text: string): boolean {
  return /[ \t]$/.test(text) && isThematicBreakLine(text)
}

function replaceParagraphWithHr(
  tr: Transaction,
  schema: Schema,
  blockStart: number,
  blockEnd: number,
): boolean {
  const hrType = schema.nodes.hr
  if (!hrType) return false

  const $start = tr.doc.resolve(blockStart)
  const parent = $start.parent
  if (parent.type.name !== 'paragraph') return false

  const paraOuterStart = blockStart - 1
  const paraOuterEnd = blockEnd + 1

  tr.replaceRangeWith(paraOuterStart, paraOuterEnd, hrType.create())

  // hr 后面通常已经有下一段;若无,补一个 paragraph 让光标有处可去
  const after = tr.mapping.map(paraOuterEnd)
  if (after >= tr.doc.content.size) {
    const paragraphType = schema.nodes.paragraph
    tr.insert(after, paragraphType.create())
  }
  // 光标移到 hr 之后的段落起点
  const cursorPos = tr.mapping.map(paraOuterEnd) + 1
  const safe = Math.min(cursorPos, tr.doc.content.size)
  tr.setSelection(TextSelection.create(tr.doc, safe))
  return true
}

export const hrEnterCommand: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  // 当前 list_item schema 要求首个子节点必须是 paragraph;避免把列表首段替成 hr。
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'list_item') return false
  }

  const blockStart = $from.start()
  const blockEnd = $from.end()
  const text = state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
  if (!isThematicBreakLine(text)) return false

  if (dispatch) {
    const tr = state.tr
    replaceParagraphWithHr(tr, state.schema, blockStart, blockEnd)
    dispatch(tr)
  }
  return true
}

export const hrSyntax: BlockSyntax = {
  name: 'hr',
  // CommonMark thematic break + 末尾空白,空格触发(对齐其他块级语法的"空格触发"约定)
  pattern: /^ {0,3}[-*_ \t]+$/,
  apply(tr, { schema, blockStart, blockEnd }) {
    const text = tr.doc.textBetween(blockStart, blockEnd, '\n', '\n')
    if (!isThematicBreakSpaceTrigger(text)) return false
    return replaceParagraphWithHr(tr, schema, blockStart, blockEnd)
  },
}

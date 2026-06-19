// ``` / ```lang / ``` lang + Enter -> code_block
//
// Space no longer commits the block. This keeps the marker editable long enough
// for users to type a language before pressing Enter.
//
// ============================================================
//  Backspace 隔离
// ============================================================
//  v0.4.6:在 code_block 第一个位置按 Backspace 时,baseKeymap 的
//  joinBackward 会:
//    - 上一行是空 paragraph → 把上一行删掉(用户感知"删了外面的空行")
//    - 上一行有内容 → 把 code_block 转成 paragraph 与上一行合并
//      (用户感知"代码块被外面的回退干掉了")
//  代码块内部的 Backspace 必须严格隔离 —— 不允许影响代码块外的内容/行。
//  规则:
//    - parentOffset !== 0:放行(让 baseKeymap 删一个字符)
//    - parentOffset === 0 + 代码块有内容:吞掉事件,什么都不做
//    - parentOffset === 0 + 代码块为空:转回 paragraph(等价"删除空代码块")

import { TextSelection } from 'prosemirror-state'
import type { Command, Transaction } from 'prosemirror-state'
import type { Schema } from 'prosemirror-model'
import type { BlockSyntax } from '../../editor/syntaxRegistry'

const CODE_BLOCK_LINE_PATTERN = /^```[ \t]*([^\s`]*)[ \t]*$/

function convertParagraphToCodeBlock(
  tr: Transaction,
  schema: Schema,
  blockStart: number,
  blockEnd: number,
  lang: string,
): boolean {
  const codeBlockType = schema.nodes.code_block
  if (!codeBlockType) return false

  const $start = tr.doc.resolve(blockStart)
  const parent = $start.parent
  if (parent.type.name !== 'paragraph') return false

  tr.delete(blockStart, blockEnd)
  tr.setBlockType(blockStart, blockStart, codeBlockType, { language: lang })

  const newPos = tr.mapping.map(blockStart)
  const sel = tr.selection
  if (sel.from < newPos) {
    tr.setSelection(TextSelection.create(tr.doc, newPos))
  }
  return true
}

export const codeBlockEnterCommand: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== 'paragraph') return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  const blockStart = $from.start()
  const blockEnd = $from.end()
  const text = state.doc.textBetween(blockStart, blockEnd, '\n', '\n')
  const match = CODE_BLOCK_LINE_PATTERN.exec(text)
  if (!match) return false

  if (dispatch) {
    const tr = state.tr
    convertParagraphToCodeBlock(tr, state.schema, blockStart, blockEnd, match[1] || '')
    dispatch(tr)
  }
  return true
}

export const codeBlockSyntax: BlockSyntax = {
  name: 'codeBlock',
  pattern: CODE_BLOCK_LINE_PATTERN,
  apply() {
    return false
  },
}

// 代码块第一个位置的 Backspace 必须严格隔离:不允许影响代码块外的行/内容。
// 见文件头部的"Backspace 隔离"说明。
export const codeBlockBackspaceCommand: Command = (state, dispatch) => {
  const { selection } = state
  if (!selection.empty) return false

  const { $from } = selection
  if ($from.parent.type.name !== 'code_block') return false
  if ($from.parentOffset !== 0) return false

  // 有内容:吞掉事件,不做任何操作。阻止 baseKeymap 的 joinBackward 把
  // 代码块降级合并到上一段。
  if ($from.parent.content.size > 0) {
    return true
  }

  // 空代码块:转回 paragraph(等价"删除代码块")。光标自然落在新 paragraph 起点。
  if (dispatch) {
    const paragraphType = state.schema.nodes.paragraph
    if (!paragraphType) return false
    const tr = state.tr.setBlockType($from.before(), $from.after(), paragraphType, {})
    dispatch(tr)
  }
  return true
}

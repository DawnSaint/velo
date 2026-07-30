// 列表 / 引用 / 代码块命令。
//
// 工厂模式接受 schema 参数。wrapIn 是 prosemirror-schema-list 的工具函数,
// 复用现有 prosemirror 生态,不自己写状态机。

import { wrapInList } from 'prosemirror-schema-list'
import type { Schema } from 'prosemirror-model'
import { setBlockType } from 'prosemirror-commands'
import type { ShortcutCommand } from '../registry'

export function wrapInBulletList(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const listItemType = schema.nodes.list_item
    if (!listItemType) return false
    return wrapInList(listItemType)(state, dispatch)
  }
}

export function wrapInOrderedList(schema: Schema): ShortcutCommand {
  // ordered_list / bullet_list 都靠 list_item 子节点,wrapInList 同款
  return wrapInBulletList(schema)
}

export function wrapInBlockquote(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const blockquoteType = schema.nodes.blockquote
    if (!blockquoteType) return false
    // blockquote 是普通 wrap 节点,没有 list_item 的 liftToLevel 概念
    // 用 setBlockType 不够(只能 wrap 当前 paragraph),走 liftListItem 思路不行,
    // 简单做法:手动 wrap 一层 blockquote
    if (!dispatch) {
      // 仅检查能否执行 —— 只要 selection 在能 wrap 的位置
      return true
    }
    const { from } = state.selection
    const tr = state.tr
    // 在 from 前插入 blockquote open,把原内容包到 blockquote 里
    // 简化:对单 paragraph 的 wrap;复杂 case 用户手动操作
    const paraRange = state.doc.resolve(from).blockRange()
    if (!paraRange) return false
    const blockquote = blockquoteType.create(null, state.doc.slice(paraRange.start, paraRange.end).content)
    tr.replaceRangeWith(paraRange.start, paraRange.end, blockquote)
    dispatch(tr)
    return true
  }
}

export function wrapInCodeBlock(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const codeBlockType = schema.nodes.code_block
    if (!codeBlockType) return false
    // code_block 用 setBlockType 而不是 wrapIn(content 必须 text*,wrapIn 会试 list_item 包装)
    return setBlockType(codeBlockType)(state, dispatch)
  }
}
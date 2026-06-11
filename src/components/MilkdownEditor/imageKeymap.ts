// atom 节点删除保护:Backspace / Delete 在 atom 未选中时不直接删,改为选中。
//
// 规则:
//  - atom 被选中(NodeSelection)        → 走默认 → 删
//  - 光标紧贴 atom(前 / 后)            → 设 NodeSelection 到该 atom(不删)
//  - 其他位置                          → 走默认 → 删文字
//
// 适用 node type:image / mermaid / math_block 等 isAtom=true 的节点。
// 已知折中:range 选区把 atom 圈在内 + Backspace → 仍然删(默认行为)。
// 空段 / trailing break 那块 Backspace 行为本次没解(留个 TODO)。

import { $prose } from '@milkdown/utils'
import { keymap } from '@milkdown/prose/keymap'
import { NodeSelection } from '@milkdown/prose/state'
import type { EditorState, Transaction } from '@milkdown/prose/state'

export const imageKeymapPlugin = $prose(() => keymap({
  Backspace: (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const sel = state.selection
    // 选中态 → 放行(让 baseKeymap 删图)
    if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
      return false
    }
    if (!sel.empty) return false

    const $pos = state.doc.resolve(sel.head)
    const before = $pos.nodeBefore
    // 光标紧贴任何一个 atom 节点 → 设 NodeSelection(选中),不删
    if (!before || !before.isAtom) {
      return false
    }

    if (!dispatch) return true
    const nodePos = $pos.pos - before.nodeSize
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, nodePos)))
    return true
  },
  Delete: (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const sel = state.selection
    if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
      return false
    }
    if (!sel.empty) return false
    const $pos = state.doc.resolve(sel.head)
    const after = $pos.nodeAfter
    // 光标紧贴任何一个 atom 节点 → 设 NodeSelection(选中),不删
    if (!after || !after.isAtom) {
      return false
    }
    if (!dispatch) return true
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, sel.head)))
    return true
  },
}))

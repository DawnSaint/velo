// atom 节点删除保护:Backspace / Delete 在 atom 未选中时不直接删,改为选中。
//
// 规则:
//  - atom 被选中(NodeSelection)        → 走默认 → 删
//  - 光标紧贴 atom(前 / 后)            → 设 NodeSelection 到该 atom(不删)
//  - 其他位置                          → 走默认 → 删文字
//
//   不能用 `node.isAtom` 判断!
//   ProseMirror 的 $pos.nodeBefore / nodeAfter 在光标处于文本节点内部时,
//   返回的是当前 leaf 节点的 cut(0, dOff) 切片,这个切片是 atom 化的
//   (isLeaf && isAtom = true)。如果用 isAtom 判,会把"在 text 节点
//   中间"误判成"光标紧贴 atom" → 错把选区设成 NodeSelection / 选中整段。
//   修复:比对 type.name,只对 image / math_block / hr 这些真 atom 节点触发保护。
//
// 适用 node type:image / math_block / hr。
// 已知折中:range 选区把 atom 圈在内 + Backspace → 仍然删(默认行为)。

import { keymap } from 'prosemirror-keymap'
import { NodeSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'

const ATOM_TYPES = new Set(['image', 'math_block', 'hr'])

export const imageKeymapPlugin = keymap({
  Backspace: (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const sel = state.selection
    // 选中态 → 放行(让 baseKeymap 删图)
    if (sel instanceof NodeSelection && ATOM_TYPES.has(sel.node.type.name)) {
      return false
    }
    if (!sel.empty) return false

    const $pos = state.doc.resolve(sel.head)
    const before = $pos.nodeBefore
    // 必须是真正紧贴一个 atom 节点(不能是 text 节点内部)。
    // nodeBefore 在文本中间会返回 atom 化的 text 切片(陷阱),必须用 type.name 比对。
    if (!before || !ATOM_TYPES.has(before.type.name)) {
      return false
    }

    if (!dispatch) return true
    const nodePos = $pos.pos - before.nodeSize
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, nodePos)))
    return true
  },
  Delete: (state: EditorState, dispatch?: (tr: Transaction) => void) => {
    const sel = state.selection
    if (sel instanceof NodeSelection && ATOM_TYPES.has(sel.node.type.name)) {
      return false
    }
    if (!sel.empty) return false
    const $pos = state.doc.resolve(sel.head)
    const after = $pos.nodeAfter
    if (!after || !ATOM_TYPES.has(after.type.name)) {
      return false
    }
    if (!dispatch) return true
    dispatch(state.tr.setSelection(NodeSelection.create(state.doc, sel.head)))
    return true
  },
})

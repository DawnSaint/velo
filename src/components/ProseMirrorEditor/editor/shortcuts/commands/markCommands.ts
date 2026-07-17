// 文本 mark 切换命令 —— 加粗 / 斜体 / 删除线 / 高亮通用的 toggleMark 扩展。
//
// toggleMarkWithWrap(markType, openMarker, closingMarker?) 的三分支:
//   选区非空 → toggleMark 切换(标准 ProseMirror 行为)
//   选区空 + 当前在 mark 内 → removeStoredMark(退出 mark 模式)
//   选区空 + 未在 mark 内 + 有闭合符 → 插入 `marker+marker`,光标居中,setStoredMark
//   选区空 + 未在 mark 内 + 无闭合符(closingMarker=null,如 link)→ 只 setStoredMark
//
// 黑名单(code mark / code_block / mermaid / math_block)内不切换 ——
// commonmark 语义:code 是字面量,不应有 mark 嵌套。
//
// linkClick session 内的强制只 setStoredMark(不插 `**`)—— 源码编辑态里
// 改源码会让 linkClick 的 parseLinkSource 失败。session 内 linkClick 是
// link 整套逻辑唯一该响应的快捷键,文本 mark 走 storedMark 即可。
//
// storedMark 自动清除:ProseMirror 文档承诺 selection 移到 mark 不适用位置时
// 自动清(实测需要测试覆盖:Mod-b → 输 'b' → 按 → 键 → 输 'c',验证 'c' 不带 mark)。

import { toggleMark } from 'prosemirror-commands'
import { TextSelection } from 'prosemirror-state'
import type { MarkType } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import type { ShortcutCommand } from '../registry'
import { linkClickPluginKey } from '../../../plugins/linkClick'
import { markSourceEditKey } from '../../../plugins/markSourceEdit'
import { htmlSourceEditKey } from '../../../plugins/htmlSourceEdit'

export function toggleMarkWithWrap(
  markType: MarkType,
  openMarker: string,
  closingMarker: string | null = openMarker,
): ShortcutCommand {
  return (state, dispatch, _view) => {
    const { from, empty } = state.selection
    const $from = state.doc.resolve(from)
    const stored = state.storedMarks ?? []

    // 黑名单:code mark / code_block / math_block 内不切换
    // (mermaid v0.4.6+ 走 code_block { language: 'mermaid' },自动被 code_block 分支拦截)
    if ($from.parent.type.name === 'code_block') return false
    if ($from.parent.type.name === 'math_block') return false
    if ($from.marks().some(m => m.type.name === 'code')) return false

    // linkClick / markSourceEdit / htmlSourceEdit 编辑态 session 内:不插包裹符,只 setStoredMark(避免改源码)
    const linkEditSession = linkClickPluginKey.getState(state)?.session
    const markEditSession = markSourceEditKey.getState(state)?.session
    const htmlEditSession = htmlSourceEditKey.getState(state)?.session
    const forceStoredMarkOnly = linkEditSession != null || markEditSession != null || htmlEditSession != null

    if (!empty) {
      // 选区非空:原生 toggleMark
      return toggleMark(markType)(state, dispatch)
    }

    if (!dispatch) return true

    const hasMark = markType.isInSet($from.marks())
    const storedActive = stored.some(m => m.type === markType)

    let tr = state.tr
    if (hasMark || storedActive) {
      // 已在 mark 内或 storedMark 激活 → 移除这一个 mark 的 storedMark
      tr = tr.removeStoredMark(markType)
    }
    else if (!forceStoredMarkOnly && closingMarker != null) {
      // 激活:插入包裹符 + 光标居中 + setStoredMark
      tr = tr.insertText(openMarker + closingMarker, from)
      tr = tr.setSelection(TextSelection.create(tr.doc, from + openMarker.length))
      tr = tr.addStoredMark(markType.create())
    }
    else {
      // link 这类无闭合符 / linkClick session 内:只 setStoredMark
      tr = tr.addStoredMark(markType.create())
    }
    dispatch(tr)
    return true
  }
}

/** 检测当前 selection 是否在指定 mark 内(空选区看 storedMarks,非空看 rangeHasMark) */
export function isMarkActive(state: EditorState, markType: MarkType): boolean {
  const { from, to, empty } = state.selection
  if (empty) {
    const stored = state.storedMarks ?? []
    if (stored.some(m => m.type === markType)) return true
    // MarkType.isInSet 返回 Mark 或 undefined,不是 boolean
    return markType.isInSet(state.doc.resolve(from).marks()) != null
  }
  return state.doc.rangeHasMark(from, to, markType)
}
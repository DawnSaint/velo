// 表格编辑操作统一入口 —— 为 shortcuts 命令和上下文菜单提供 view 访问 + 命令分发。
//
// 设计:
// - EditorInner.vue mount 时注册 view,unmount 时注销
// - 表格操作命令(prosemirror-tables)签名是 Command = (state, dispatch?, view?) => boolean
//   runTableCommand 解包 view + 自动 focus
// - 对齐使用 setCellAttr 直接内联,避免与 tableCommands.ts 循环依赖

import type { Command } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { setCellAttr } from "prosemirror-tables"
import type { Alignment } from "./shortcuts/commands/tableCommands"

let _view: EditorView | null = null

/** EditorInner.vue onMounted 时注册 view */
export function registerTableEditorView(view: EditorView): void {
  _view = view
}

/** EditorInner.vue onBeforeUnmount 时注销 */
export function unregisterTableEditorView(): void {
  _view = null
}

/** 当前注册表是否活跃(有已注册的 view) */
export function hasTableEditorView(): boolean {
  return _view !== null && !_view.isDestroyed
}

/**
 * 运行一个表格命令(自动解包 view + focus)。
 * @param cmd  prosemirror-tables 的 Command 函数(addRowAfter / deleteColumn / …)
 * @returns 命令是否已执行(未注册 view / 命令返回 false = false)
 */
export function runTableCommand(
  cmd: Command,
  opts: { autoFocus?: boolean } = {},
): boolean {
  const view = _view
  if (!view || view.isDestroyed) return false
  const result = cmd(view.state, view.dispatch, view)
  if (opts.autoFocus !== false && !view.hasFocus()) {
    view.focus()
  }
  return result
}

/**
 * 在光标所在单元格设置对齐方式。
 * 不在表格内 → noop(false)。
 */
export function runSetCellAlignment(align: Alignment): boolean {
  const view = _view
  if (!view || view.isDestroyed) return false
  const cmd = setCellAttr("alignment", align)
  const ok = cmd(view.state, view.dispatch, view)
  if (!view.hasFocus()) view.focus()
  return ok
}

/** 暴露原始 view 引用(高级场景 / 测试用) */
export function getTableEditorView(): EditorView | null {
  return _view
}
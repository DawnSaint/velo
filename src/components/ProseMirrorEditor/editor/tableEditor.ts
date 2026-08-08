// 表格编辑操作统一入口 —— 为 shortcuts 命令和上下文菜单提供 view 访问 + 命令分发。
//
// 设计:
// - EditorInner.vue mount 时注册 view,unmount 时注销
// - 表格操作命令(tableCommands.ts)签名是 Command = (state, dispatch?, view?) => boolean
//   runTableCommand 解包 view + 自动 focus
// - 对齐接本地 setCellAlignment(列级整表替换),与右键菜单 / 快捷键同路径

import type { Command } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { setCellAlignment } from "./shortcuts/commands/tableCommands"
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
 * @param cmd  tableCommands.ts 的 Command 函数(addRowAfter / deleteColumn / …)
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
 * 把 anchorPos 所在列(或 CellSelection 矩形覆盖的所有列)整体设为对齐方式。
 * anchorPos = 右键点中 cell 的 descendants pos;为空 → 退到 selection.$from。
 * 不在表格内 → noop(false)。
 * 接本地的 setCellAlignment(列级 / 矩形整表替换),与右键菜单 / 快捷键同路径。
 */
export function runSetCellAlignment(align: Alignment, anchorPos?: number): boolean {
  const view = _view
  if (!view || view.isDestroyed) return false
  const ok = setCellAlignment(align, anchorPos)(view.state, view.dispatch, view)
  if (!view.hasFocus()) view.focus()
  return ok
}


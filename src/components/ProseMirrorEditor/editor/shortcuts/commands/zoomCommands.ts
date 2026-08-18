// Zoom 快捷键命令(v0.7.12 #zoom)
//
// 三个命令函数:zoomIn / zoomOut / zoomReset。
// 不直接调 Tauri API,只改 editorStore.zoomLevel;
// useZoom composable watch store 变化时统一调 setWebviewZoom。
//
// 设计:
// - zoomIn/zoomOut 按 ZOOM_LEVEL_STEP 步长递增/递减,clamp 到 [MIN, MAX]。
// - 到达边界时返回 true(消费快捷键)但不变化,避免 keymap 走默认行为。
// - 命令是纯 store 操作,不需要 ProseMirror state/dispatch/view,但签名
//   匹配 ShortcutCommand 以便走 registerShortcut 注册。

import type { ShortcutCommand } from '../registry'
import {
  useEditorStore,
  ZOOM_LEVEL_STEP,
  ZOOM_LEVEL_DEFAULT,
  clampZoomLevel,
} from '@/stores/editor'
import { isTauri } from '@tauri-apps/api/core'

/**
 * 放大(Mod-=):zoomLevel += step,clamp 到 MAX。
 */
export const zoomIn: ShortcutCommand = () => {
  if (!isTauri()) return false
  const store = useEditorStore()
  // 四舍五入到 0.1 粒度,避免浮点精度累积(1.0+0.1+0.1+0.1=1.3000000000000003)
  store.zoomLevel = clampZoomLevel(Math.round((store.zoomLevel + ZOOM_LEVEL_STEP) * 10) / 10)
  return true
}

/**
 * 缩小(Mod--):zoomLevel -= step,clamp 到 MIN。
 */
export const zoomOut: ShortcutCommand = () => {
  if (!isTauri()) return false
  const store = useEditorStore()
  store.zoomLevel = clampZoomLevel(Math.round((store.zoomLevel - ZOOM_LEVEL_STEP) * 10) / 10)
  return true
}

/**
 * 重置(Mod-Shift-0):zoomLevel 恢复默认 1.0。
 * 用 Mod-Shift-0 而非 Mod-0(Mod-0 已被「段落」快捷键占用)。
 */
export const zoomReset: ShortcutCommand = () => {
  if (!isTauri()) return false
  const store = useEditorStore()
  store.zoomLevel = ZOOM_LEVEL_DEFAULT
  return true
}

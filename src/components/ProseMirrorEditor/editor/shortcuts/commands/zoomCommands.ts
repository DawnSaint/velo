// Zoom 快捷键命令(v0.7.12 #zoom)
//
// 三个函数:zoomIn / zoomOut / zoomReset。
// 不直接调 Tauri API,只改 editorStore.zoomLevel;
// useZoom composable watch store 变化时统一调 setWebviewZoom。
//
// 设计:
// - zoomIn/zoomOut 按 ZOOM_LEVEL_STEP 步长递增/递减,clamp 到 [MIN, MAX]。
// - 到达边界时仍返回 true 但不变化,避免 keymap 走默认行为。
// - 每次触发都调 showZoomIndicator() 弹出浮层,让用户感知当前缩放程度。
// - zoom 走全局 keydown(useGlobalKeybindings),不依赖 ProseMirror keymap,
//   编辑器未 focus 时也能生效。函数不需要 PM state 参数。

import {
  useEditorStore,
  ZOOM_LEVEL_STEP,
  ZOOM_LEVEL_DEFAULT,
  clampZoomLevel,
} from '@/stores/editor'
import { isTauri } from '@tauri-apps/api/core'
import { showZoomIndicator } from '@/composables/useZoom'

/**
 * 放大(Mod-Shift-=):zoomLevel += step,clamp 到 MAX。
 */
export function zoomIn(): boolean {
  if (!isTauri()) return false
  const store = useEditorStore()
  // 四舍五入到 0.1 粒度,避免浮点精度累积(1.0+0.1+0.1+0.1=1.3000000000000003)
  store.zoomLevel = clampZoomLevel(Math.round((store.zoomLevel + ZOOM_LEVEL_STEP) * 10) / 10)
  showZoomIndicator()
  return true
}

/**
 * 缩小(Mod-Shift--):zoomLevel -= step,clamp 到 MIN。
 */
export function zoomOut(): boolean {
  if (!isTauri()) return false
  const store = useEditorStore()
  store.zoomLevel = clampZoomLevel(Math.round((store.zoomLevel - ZOOM_LEVEL_STEP) * 10) / 10)
  showZoomIndicator()
  return true
}

/**
 * 重置(Mod-Shift-0):zoomLevel 恢复默认 1.0。
 * 用 Mod-Shift-0 而非 Mod-0(Mod-0 已被「段落」快捷键占用)。
 */
export function zoomReset(): boolean {
  if (!isTauri()) return false
  const store = useEditorStore()
  store.zoomLevel = ZOOM_LEVEL_DEFAULT
  showZoomIndicator()
  return true
}

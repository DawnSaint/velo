// 编辑器全局缩放(v0.7.12 #zoom)
//
// 封装 Tauri Webview.setZoom,watch editorStore.zoomLevel 变化时调用。
// zoom 是对整个 webview 的全局视觉缩放(含文字、图片、代码块等所有内容),
// 区别于 editorStore.fontSize(仅改正文字号 px 值)。
//
// 调用集中在此 composable,快捷键(zoomCommands)和设置面板(EditorGroup)
// 都只改 store.zoomLevel,不直接调 Tauri API —— 所有 IPC 出口收敛于此。
//
// zoomIndicatorVisible: 快捷键触发 zoom 时弹出指示器浮层,自动消失。
//   zoomCommands 调 showZoomIndicator() 显示;ZoomIndicator 组件读此 ref
//   决定显隐,用户拖动浮层滑块直接改 store.zoomLevel。

import { ref, watch, type Ref } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { isTauri } from '@tauri-apps/api/core'
import { useEditorStore } from '@/stores/editor'

let initialized = false

/** zoom 指示器是否可见(快捷键触发时显示,自动消失)。 */
export const zoomIndicatorVisible = ref(false)

let hideTimer: ReturnType<typeof setTimeout> | null = null
/** 指示器自动消失延时(ms)。 */
const INDICATOR_HIDE_DELAY = 2000

/**
 * 显示 zoom 指示器,并在 INDICATOR_HIDE_DELAY 后自动隐藏。
 * 用户连续按快捷键时重置 timer,保持可见。
 */
export function showZoomIndicator(): void {
  zoomIndicatorVisible.value = true
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    zoomIndicatorVisible.value = false
    hideTimer = null
  }, INDICATOR_HIDE_DELAY)
}

/**
 * 初始化 zoom 同步:watch editorStore.zoomLevel,变化时调 setWebviewZoom。
 * App.vue setup 顶层调一次即可,多次调用安全(idempotent guard)。
 *
 * **启动零跳变**:传入 settingsReady ref,在 settings hydrate 完成前不 applyZoom,
 * 避免先用默认 100% 渲染再跳到用户值。settingsReady 翻 true 后首次 applyZoom
 * 拿到的已经是用户持久化的 zoomLevel,webview 只被设置一次。
 *
 * dev web 端(无 Tauri runtime)不调 IPC,仅 store 状态变化,不报错。
 *
 * @param settingsReady App.vue 中 initSettings 完成后翻 true 的 ref
 */
export function useZoom(settingsReady: Ref<boolean>): void {
  if (initialized) return
  initialized = true

  const store = useEditorStore()

  // settings hydrate 完成后首次 applyZoom(此时 store.zoomLevel 已是用户持久化值)。
  // 之后 watch zoomLevel 变化实时同步。
  watch(settingsReady, (ready) => {
    if (!ready) return
    applyZoom(store.zoomLevel)
  }, { immediate: true })

  watch(() => store.zoomLevel, (level) => {
    // settingsReady 未翻时跳过 —— 首次 applyZoom 由上方 settingsReady watcher 负责,
    // 避免 hydrate 把默认值改写为用户值时触发多余的 100% → 用户值跳变。
    if (!settingsReady.value) return
    applyZoom(level)
  })
}

/**
 * 调 Tauri setWebviewZoom。非 Tauri 环境(dev web)静默 noop。
 */
function applyZoom(level: number): void {
  if (!isTauri()) return
  // Tauri 2 的 set_webview_zoom 期望 zoomFactor(1.0 = 100%)。
  // 值已由 store clamp 到 [0.5, 2.0],此处不重复 clamp。
  void getCurrentWebview().setZoom(level).catch((e) => {
    console.warn('设置缩放失败', e)
  })
}

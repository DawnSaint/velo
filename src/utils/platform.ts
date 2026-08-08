// 平台检测纯工具。UA 比 navigator.platform 更稳定(platform 已 deprecated)。
//
// 原 App.vue 与 stores/document.ts 各有一份,isMacOS 实现仅守卫略有差异
// (App.vue 多一层 `tauri &&` 守卫)。抽到 utils 复用,App.vue 处保留 tauri 守卫。
export const isMacOS = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)

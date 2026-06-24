// `@tauri-apps/plugin-dialog` 的薄封装层 —— 见 `./fs.ts` 同款注释。
//
// 当前 thin re-export,后续如要在 dialog 周围统一加 "弹窗时暂停 fs:watch
// 防 saveAs 弹出触发自身 blur 二次写盘" 这类横切关心,集中改这里。
//
// **E2E 钩子(仅 dev build)**:WebDriver 无法操作系统 confirm 对话框。
// spec 在 before() 里设 `window.__VELO_E2E_AUTO_CONFIRM__ = true`,所有 confirm
// 直接 resolve true,绕开"删除主链路最后一步无法点确认"。release build 走
// `import.meta.env.DEV === false`,esbuild dead-code-eliminate 三行守门,行为不变。

import {
  open,
  save,
  confirm as nativeConfirm,
  message,
  type ConfirmDialogOptions,
} from '@tauri-apps/plugin-dialog'

async function confirm(message: string, options?: string | ConfirmDialogOptions): Promise<boolean> {
  if (import.meta.env.DEV && (globalThis as { __VELO_E2E_AUTO_CONFIRM__?: boolean }).__VELO_E2E_AUTO_CONFIRM__) {
    return true
  }
  return nativeConfirm(message, options)
}

export { open, save, confirm, message }

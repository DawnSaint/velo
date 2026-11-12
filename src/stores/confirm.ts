// 通用确认弹窗 store —— 取代散落在业务里的原生 confirm。
//
// 与 notify.ts 正交:notify 只做非阻塞告知,本 store 承载「需要用户二选一」的
// 阻塞决策。UI 在 VeloConfirmDialog.vue(Teleport to body),业务侧只 await
// useConfirmStore().ask(...),不直接碰 DOM。
//
// 设计取舍:同一时刻只保留一个确认框。新请求进来时把上一个按「取消」结算,
// 避免并发 ask 留下永远不 resolve 的 promise(启动恢复 + 用户点击可能撞车)。

import { shallowRef } from 'vue'
import { defineStore } from 'pinia'

type ConfirmKind = 'warning' | 'danger'

export interface ConfirmOptions {
  title: string
  message: string
  /** 需要强调的路径 / 名称,单独一行等宽展示;省略则不渲染 */
  detail?: string
  confirmText?: string
  cancelText?: string
  kind?: ConfirmKind
}

export interface ConfirmRequest {
  id: number
  title: string
  message: string
  detail?: string
  confirmText: string
  cancelText: string
  kind: ConfirmKind
}

export const useConfirmStore = defineStore('confirm', () => {
  const current = shallowRef<ConfirmRequest | null>(null)
  let seq = 0
  let resolveCurrent: ((value: boolean) => void) | null = null

  function ask(options: ConfirmOptions): Promise<boolean> {
    // 与 tauri/dialog.ts 同款 E2E 钩子:WebDriver 点不到自绘弹窗,dev build 直接放行。
    if (import.meta.env.DEV && (globalThis as { __VELO_E2E_AUTO_CONFIRM__?: boolean }).__VELO_E2E_AUTO_CONFIRM__) {
      return Promise.resolve(true)
    }
    if (resolveCurrent) resolveCurrent(false)
    return new Promise<boolean>((resolve) => {
      resolveCurrent = resolve
      current.value = {
        id: ++seq,
        title: options.title,
        message: options.message,
        detail: options.detail,
        confirmText: options.confirmText ?? '确定',
        cancelText: options.cancelText ?? '取消',
        kind: options.kind ?? 'warning',
      }
    })
  }

  function settle(value: boolean) {
    const resolve = resolveCurrent
    resolveCurrent = null
    current.value = null
    resolve?.(value)
  }

  return {
    current,
    ask,
    confirm: () => settle(true),
    cancel: () => settle(false),
  }
})

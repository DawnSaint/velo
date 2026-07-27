// 通知 store —— 统一的非阻塞 Toast 通知系统。
//
// 替代散落在各处的原生 message 对话框（@tauri-apps/plugin-dialog 的 message
// 是阻塞系统弹窗，抢焦点、需手动关闭），提供一致的成功 / 信息 / 警告 / 错误
// 反馈：右上角浮层、自动消失 + 手动关闭、最多 5 条堆叠。
//
// 设计取舍：
// - **只接管「告知性反馈」**：需要用户决策的场景（保存覆盖确认 / 关闭脏标签
//   等）仍走原生 confirm，不替成 Toast —— 阻塞确认与非阻塞告知职责正交。
// - **零依赖自建**：项目已有 Teleport + TransitionGroup + lucide 图标 + Tailwind
//   + 暗色模式的完整体系，Toast 顺着同一套 idiom 写，不需要引第三方库。
// - **setTimeout 管理**：每条 toast push 时挂一个定时器到时自动 dismiss，
//   dismiss 内部 findIndex 防御（已不在列表则 no-op），无需追踪 timer 句柄。

import { ref } from 'vue'
import { defineStore } from 'pinia'

export type ToastType = 'success' | 'info' | 'warning' | 'error'

export interface Toast {
  id: number
  type: ToastType
  message: string
  /** 自动消失延时(ms)；0 = 不自动消失。默认值按 type 给（error 久一点）。 */
  duration: number
}

let toastIdSeq = 0

/** 各类型默认停留时长(ms)。error 比 success 久，给用户更多时间读错误原因。 */
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: 6000,
}

/** 同时显示的 toast 上限，超出则移除最早的（避免长错误链刷屏）。 */
const MAX_TOASTS = 5

export const useNotifyStore = defineStore('notify', () => {
  const toasts = ref<Toast[]>([])

  function push(type: ToastType, message: string, duration?: number): number {
    const id = ++toastIdSeq
    const d = duration ?? DEFAULT_DURATION[type]
    toasts.value.push({ id, type, message, duration: d })
    // 超出上限：移除最早的（数组头部）
    if (toasts.value.length > MAX_TOASTS) {
      toasts.value.splice(0, toasts.value.length - MAX_TOASTS)
    }
    if (d > 0) {
      setTimeout(() => dismiss(id), d)
    }
    return id
  }

  /** 手动关闭指定 toast（按 id）。已不在列表则 no-op。 */
  function dismiss(id: number) {
    const idx = toasts.value.findIndex(t => t.id === id)
    if (idx !== -1) toasts.value.splice(idx, 1)
  }

  return {
    toasts,
    success: (msg: string, duration?: number) => push('success', msg, duration),
    info: (msg: string, duration?: number) => push('info', msg, duration),
    warning: (msg: string, duration?: number) => push('warning', msg, duration),
    error: (msg: string, duration?: number) => push('error', msg, duration),
    dismiss,
  }
})

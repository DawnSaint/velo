<script setup lang="ts">
// Toast 通知容器 —— 右上角浮层，展示 useNotifyStore 中的通知队列。
//
// 与 ContextMenuShell / DraftRecoveryDialog 同款 Teleport-to-body 模式：
// fixed 定位、z-index 高于右键菜单（1100）和对话框，不占文档流。
// 暗色走 Tailwind dark: variant（html.dark 祖先命中），图标走 @lucide/vue。
//
// 样式分工（见 docs/architecture/styles.md）：布局 / 间距 / 颜色用 Tailwind
// class，进入 / 退出 / 位移动画用 <style scoped>（TransitionGroup 的 name
// 挂在 scoped transition 类上）。

import { Check, Info, AlertTriangle, XCircle, X } from '@lucide/vue'
import { useNotifyStore, type ToastType } from '@/stores/notify'

const notify = useNotifyStore()

const iconFor: Record<ToastType, typeof Check> = {
  success: Check,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
}

const iconColorFor: Record<ToastType, string> = {
  success: 'text-green-600 dark:text-green-400',
  info: 'text-blue-600 dark:text-blue-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
}
</script>

<template>
  <Teleport to="body">
    <TransitionGroup
      tag="div"
      name="velo-toast"
      class="fixed top-12 right-4 z-[1200] flex w-80 flex-col gap-2"
    >
      <div
        v-for="toast in notify.toasts"
        :key="toast.id"
        class="flex items-start gap-2.5 rounded-lg bg-[var(--surface-3)] px-4 py-3 shadow-[var(--shadow-popover)] ring-1 ring-black/5 dark:ring-white/10"
        role="alert"
      >
        <component
          :is="iconFor[toast.type]"
          :size="18"
          class="mt-0.5 shrink-0"
          :class="iconColorFor[toast.type]"
          aria-hidden="true"
        />
        <span class="min-w-0 flex-1 break-words text-sm text-gray-700 dark:text-gray-200">
          {{ toast.message }}
        </span>
        <button
          type="button"
          class="mt-0.5 shrink-0 rounded text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          aria-label="关闭通知"
          @click="notify.dismiss(toast.id)"
        >
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<style scoped>
.velo-toast-enter-active,
.velo-toast-leave-active,
.velo-toast-move {
  transition: all 0.25s ease;
}
.velo-toast-enter-from,
.velo-toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}
.velo-toast-leave-active {
  position: absolute;
}
</style>

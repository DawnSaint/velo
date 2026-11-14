<script setup lang="ts">
// 通用确认弹窗:参照产品级对话框样式 —— 无图标、大留白白卡、
// 标题 18px semibold + 正文 15px 说明 + 右对齐双按钮(取消描边 / 主操作实色)。
// 视觉与下拉 / Toast 同族(--surface-3 + --shadow-popover + 发丝边框),
// 暗色靠 CSS 变量与 Tailwind dark: 翻面,不引入新色板。
// 键盘:Enter 确认(焦点在按钮时交给原生 click)/ Esc 取消 / Tab 在两按钮间循环。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useConfirmStore } from '@/stores/confirm'

const confirmStore = useConfirmStore()
const request = computed(() => confirmStore.current)
const dialogRef = ref<HTMLDivElement | null>(null)
const primaryRef = ref<HTMLButtonElement | null>(null)

const primaryClass = computed(() => request.value?.kind === 'danger'
  ? 'bg-red-500 text-white hover:bg-red-600 focus-visible:ring-red-400 dark:hover:bg-red-400 dark:focus-visible:ring-red-300'
  : 'bg-[var(--chrome-accent-blue)] text-white hover:brightness-110 focus-visible:ring-[var(--chrome-accent-blue)]')

function onKeydown(e: KeyboardEvent) {
  if (!request.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    confirmStore.cancel()
    return
  }
  if (e.key === 'Enter') {
    // 焦点在按钮上时让原生 click 决定走确认还是取消,避免与手动结算打架。
    const active = document.activeElement
    if (active instanceof HTMLButtonElement && dialogRef.value?.contains(active)) return
    e.preventDefault()
    e.stopPropagation()
    confirmStore.confirm()
    return
  }
  if (e.key === 'Tab') {
    const buttons = dialogRef.value?.querySelectorAll<HTMLButtonElement>('button')
    if (!buttons?.length) return
    e.preventDefault()
    const idx = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement)
    const next = e.shiftKey
      ? (idx <= 0 ? buttons.length - 1 : idx - 1)
      : (idx + 1) % buttons.length
    buttons[next].focus()
  }
}

watch(request, (next) => {
  if (next) void nextTick(() => primaryRef.value?.focus())
})

onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="velo-confirm">
      <div
        v-if="request"
        class="fixed inset-0 z-[1300] flex items-center justify-center bg-black/5 dark:bg-black/50"
        @click.self="confirmStore.cancel()"
      >
        <div
          ref="dialogRef"
          class="velo-confirm-card w-[600px] max-w-[calc(100vw-32px)] rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-3)] p-6 shadow-[var(--shadow-popover)]"
          role="alertdialog"
          aria-modal="true"
          :aria-label="request.title"
        >
          <span class="text-lg font-semibold text-[var(--chrome-text-active)]">{{ request.title }}</span>

          <p class="mt-7 text-[15px] leading-8 text-[var(--chrome-text-primary)]">{{ request.message }}</p>

          <div
            v-if="request.detail"
            class="mt-4 break-all rounded-lg border border-[var(--surface-border)] bg-[var(--surface-1)] px-3 py-2 font-mono text-xs text-[var(--chrome-text-primary)]"
          >{{ request.detail }}</div>

          <div class="mt-5 flex h-10 justify-end gap-4">
            <button
              type="button"
              class="rounded-lg border border-[var(--surface-border)] px-4 text-base text-[var(--chrome-text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
              @click="confirmStore.cancel()"
            >{{ request.cancelText }}</button>
            <button
              ref="primaryRef"
              type="button"
              class="rounded-lg px-4 text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
              :class="primaryClass"
              @click="confirmStore.confirm()"
            >{{ request.confirmText }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.velo-confirm-enter-active,
.velo-confirm-leave-active {
  transition: opacity 0.16s ease;
}
.velo-confirm-enter-from,
.velo-confirm-leave-to {
  opacity: 0;
}
.velo-confirm-enter-active .velo-confirm-card {
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.14s ease;
}
.velo-confirm-enter-from .velo-confirm-card {
  transform: translateY(10px) scale(0.98);
  opacity: 0;
}
.velo-confirm-leave-active .velo-confirm-card {
  transition: transform 0.14s ease, opacity 0.12s ease;
}
.velo-confirm-leave-to .velo-confirm-card {
  transform: translateY(6px) scale(0.99);
  opacity: 0;
}
</style>

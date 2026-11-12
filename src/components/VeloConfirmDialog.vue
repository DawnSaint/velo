<script setup lang="ts">
// 通用确认弹窗(精简版):只保留小图标 + 标题、一句说明、可选路径、双按钮。
// 视觉与下拉 / Toast 同族(--surface-3 + --shadow-popover + 发丝边框),
// 暗色靠 CSS 变量与 Tailwind dark: 翻面,不引入新色板。
// 键盘:Enter 确认(焦点在按钮时交给原生 click)/ Esc 取消 / Tab 在两按钮间循环。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertTriangle, XCircle } from '@lucide/vue'
import { useConfirmStore } from '@/stores/confirm'

const confirmStore = useConfirmStore()
const request = computed(() => confirmStore.current)
const dialogRef = ref<HTMLDivElement | null>(null)
const primaryRef = ref<HTMLButtonElement | null>(null)

const icon = computed(() => request.value?.kind === 'danger' ? XCircle : AlertTriangle)
const iconClass = computed(() => request.value?.kind === 'danger'
  ? 'text-red-600 dark:text-red-400'
  : 'text-amber-600 dark:text-amber-400')
const primaryClass = computed(() => request.value?.kind === 'danger'
  ? 'bg-red-600 text-white hover:bg-red-700 dark:bg-red-400 dark:text-red-950 dark:hover:bg-red-300'
  : 'bg-[var(--chrome-accent-blue)] text-white hover:brightness-110 dark:text-[var(--surface-0)]')

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
        class="fixed inset-0 z-[1300] flex items-center justify-center bg-black/25 dark:bg-black/55"
        @click.self="confirmStore.cancel()"
      >
        <div
          ref="dialogRef"
          class="w-[400px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--surface-border)] bg-[var(--surface-3)] p-5 shadow-[var(--shadow-popover)]"
          role="alertdialog"
          aria-modal="true"
          :aria-label="request.title"
        >
          <div class="mb-3.5 flex items-center gap-2.5">
            <component :is="icon" :size="18" class="shrink-0" :class="iconClass" aria-hidden="true" />
            <span class="text-sm font-semibold text-[var(--chrome-text-active)]">{{ request.title }}</span>
          </div>

          <p class="text-[13px] leading-relaxed text-[var(--chrome-text-secondary)]">{{ request.message }}</p>

          <div
            v-if="request.detail"
            class="mt-3 break-all rounded-md border border-[var(--surface-border)] bg-[var(--surface-1)] px-2.5 py-2 font-mono text-xs text-[var(--chrome-text-primary)]"
          >{{ request.detail }}</div>

          <div class="mt-5 flex justify-end gap-2.5">
            <button
              type="button"
              class="rounded-md border border-[var(--surface-border)] px-3.5 py-2 text-[13px] text-[var(--chrome-text-primary)] transition-colors hover:bg-[var(--surface-hover)]"
              @click="confirmStore.cancel()"
            >{{ request.cancelText }}</button>
            <button
              ref="primaryRef"
              type="button"
              class="rounded-md px-3.5 py-2 text-[13px] font-medium transition-[filter,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chrome-accent-blue)]"
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
  transition: opacity 0.14s ease;
}
.velo-confirm-enter-from,
.velo-confirm-leave-to {
  opacity: 0;
}
</style>

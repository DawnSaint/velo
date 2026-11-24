<script setup lang="ts">
// 内置导出面板 —— 先选类型,确认后才走系统 saveDialog 选路径。
//
// 为什么需要:类型选择原先只能靠系统保存框的 filter(用户得先打开系统框才能
// 切类型)。面板把「存成什么」前置到应用内,系统框只负责「存哪」(含文件名,
// 所以面板里不再有文件名输入)。
//
// 关闭语义:**只有「取消」按钮能关**;点空白 / Esc 都不关(避免误触丢选项)。
// 确认导出时面板保持打开(系统保存框 + 导出中),成功才自动关;导出中两个
// 按钮都禁用,主按钮显示 loading。
//
// 视觉 / 键盘与 VeloConfirmDialog 同源(Teleport + 居中卡 + Enter 确认),
// 复用 --surface-3 / --shadow-popover 族,暗色靠 CSS 变量翻面。

import { computed, onBeforeUnmount, onMounted } from 'vue'
import { Loader2 } from '@lucide/vue'
import { EXPORT_TYPES, useExportStore, type ExportType } from '@/stores/export'

const exportStore = useExportStore()

const open = computed(() => exportStore.panelOpen)

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Enter') {
    // 焦点在按钮上时交给原生 click(避免与主按钮点击打架)。
    if (document.activeElement instanceof HTMLButtonElement) return
    e.preventDefault()
    e.stopPropagation()
    void exportStore.confirmExportPanel()
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))

function pick(type: ExportType): void {
  exportStore.selectExportType(type)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="velo-export">
      <div
        v-if="open"
        class="fixed inset-0 z-[1300] flex items-center justify-center bg-black/5 dark:bg-black/50"
      >
        <div
          class="velo-export-card w-[520px] max-w-[calc(100vw-32px)] rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-3)] p-6 shadow-[var(--shadow-popover)]"
          role="dialog"
          aria-modal="true"
          aria-label="导出"
        >
          <span class="text-lg font-semibold text-[var(--chrome-text-active)]">导出</span>

          <div class="mt-5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="导出类型">
            <button
              v-for="t in EXPORT_TYPES"
              :key="t.type"
              type="button"
              role="radio"
              :aria-checked="exportStore.selectedType === t.type"
              class="rounded-lg border px-3 py-2.5 text-left transition-colors"
              :class="exportStore.selectedType === t.type
                ? 'border-[var(--chrome-accent-blue)] bg-[var(--surface-hover)]'
                : 'border-[var(--surface-border)] hover:bg-[var(--surface-hover)]'"
              @click="pick(t.type)"
            >
              <span class="block text-sm font-medium text-[var(--chrome-text-primary)]">{{ t.label }}</span>
              <span class="mt-0.5 block text-[11px] leading-4 text-[var(--chrome-text-secondary)]">{{ t.desc }}</span>
            </button>
          </div>

          <div class="mt-6 flex h-10 justify-end gap-4">
            <button
              type="button"
              :disabled="exportStore.exporting"
              class="rounded-lg border border-[var(--surface-border)] px-4 text-base text-[var(--chrome-text-primary)] transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              @click="exportStore.closeExportPanel()"
            >
              取消
            </button>
            <button
              type="button"
              :disabled="exportStore.exporting"
              class="flex items-center gap-2 rounded-lg bg-[var(--chrome-accent-blue)] px-4 text-base font-medium text-white transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              @click="void exportStore.confirmExportPanel()"
            >
              <Loader2 v-if="exportStore.exporting" class="h-4 w-4 animate-spin" />
              {{ exportStore.exporting ? '导出中…' : '导出' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.velo-export-enter-active,
.velo-export-leave-active {
  transition: opacity 0.16s ease;
}
.velo-export-enter-from,
.velo-export-leave-to {
  opacity: 0;
}
.velo-export-enter-active .velo-export-card {
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.14s ease;
}
.velo-export-enter-from .velo-export-card {
  transform: translateY(10px) scale(0.98);
  opacity: 0;
}
.velo-export-leave-active .velo-export-card {
  transition: transform 0.14s ease, opacity 0.12s ease;
}
.velo-export-leave-to .velo-export-card {
  transform: translateY(6px) scale(0.99);
  opacity: 0;
}
</style>
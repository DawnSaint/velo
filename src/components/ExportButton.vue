<script setup lang="ts">
// 顶栏导出按钮。
//
// 复用 App.vue:583-589(saveAs 按钮)的 verbatim 模式:同 class string、同 svg
// 风格、同 title 文案 + 快捷键提示。点击 → useExportStore.exportDocument()
// 走原生 saveDialog(多 filter: HTML / PDF),选哪个走哪个。
import { useExportStore } from '@/stores/export'
const exportStore = useExportStore()
</script>

<template>
  <button
    class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed"
    :title="exportStore.exporting ? '导出中…' : '导出 (Ctrl+Shift+E)'"
    :disabled="exportStore.exporting"
    @click="void exportStore.exportDocument()"
  >
    <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  </button>
</template>

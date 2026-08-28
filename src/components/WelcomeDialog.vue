<script setup lang="ts">
// 空状态占位:无标签时作为编辑器主区域的填充,提供"新建 / 打开"入口。
// 原 v0.6.x 模态弹窗已移除 —— 无标签时自然展示此组件,无需首次启动弹窗。

import { FilePlus, FolderOpen } from '@lucide/vue'

defineEmits<{
  'create-blank': []
  'open-file': []
}>()
</script>

<template>
  <div class="flex flex-1 min-w-0 flex-col items-center justify-center bg-[var(--surface-2)]">
    <div class="w-full max-w-sm px-6">
      <div class="mt-4 flex flex-col gap-3">
        <button
          class="flex w-full items-center gap-3 rounded-2xl border border-[var(--surface-border)] p-3 text-left transition-colors hover:border-gray-300 hover:bg-[var(--surface-hover)] dark:hover:border-gray-600"
          @click="$emit('create-blank')"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <FilePlus class="h-5 w-5" />
          </div>
          <div class="text-sm font-medium text-gray-900 dark:text-gray-100">新建空白文档</div>
        </button>

        <button
          class="flex w-full items-center gap-3 rounded-2xl border border-[var(--surface-border)] p-3 text-left transition-colors hover:border-gray-300 hover:bg-[var(--surface-hover)] dark:hover:border-gray-600"
          @click="$emit('open-file')"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <FolderOpen class="h-5 w-5" />
          </div>
          <div class="text-sm font-medium text-gray-900 dark:text-gray-100">打开已有文件</div>
        </button>
      </div>
    </div>
  </div>
</template>

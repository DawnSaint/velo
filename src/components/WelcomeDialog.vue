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
  <div class="flex flex-1 min-w-0 flex-col items-center justify-center bg-white dark:bg-[#1e1e1e]">
    <div class="w-full max-w-sm px-6">
      <div class="mt-4 flex flex-col gap-3">
        <button
          class="flex w-full items-center gap-3 rounded-2xl border border-gray-200 p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-[#262626]"
          @click="$emit('create-blank')"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <FilePlus class="h-5 w-5" />
          </div>
          <div>
            <div class="text-sm font-medium text-gray-900 dark:text-gray-100">新建空白文档</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">从零开始写作</div>
          </div>
        </button>

        <button
          class="flex w-full items-center gap-3 rounded-2xl border border-gray-200 p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-[#262626]"
          @click="$emit('open-file')"
        >
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
            <FolderOpen class="h-5 w-5" />
          </div>
          <div>
            <div class="text-sm font-medium text-gray-900 dark:text-gray-100">打开已有文件</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">打开工作区或 .md 文件</div>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

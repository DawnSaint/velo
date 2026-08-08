<script setup lang="ts">
// 根行工具按钮:新建文件 / 新建文件夹 / 刷新 / 全部折叠。
// 在普通根行和 sticky 目录头中复用,消除原先两处完全重复的模板。

import { Check, ChevronsDownUp, FilePlus, FolderPlus, RefreshCw } from '@lucide/vue'

defineProps<{
  visible: boolean
  refreshState: 'idle' | 'loading' | 'success'
  withTestIds?: boolean
}>()

defineEmits<{
  'new-file': []
  'new-dir': []
  'refresh': []
  'collapse-all': []
}>()
</script>

<template>
  <div
    class="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100"
    :class="{ 'opacity-100': visible }"
  >
    <button
      class="flex size-5.5 items-center justify-center rounded text-gray-500 hover:bg-[var(--surface-pressed)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      title="新建文件"
      :data-testid="withTestIds ? 'root-action-new-file' : undefined"
      @click.stop="$emit('new-file')"
    >
      <FilePlus class="size-3.5 pointer-events-none" :stroke-width="2" />
    </button>
    <button
      class="flex size-5.5 items-center justify-center rounded text-gray-500 hover:bg-[var(--surface-pressed)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      title="新建文件夹"
      :data-testid="withTestIds ? 'root-action-new-dir' : undefined"
      @click.stop="$emit('new-dir')"
    >
      <FolderPlus class="size-3.5 pointer-events-none" :stroke-width="2" />
    </button>
    <button
      class="flex size-5.5 items-center justify-center rounded text-gray-500 hover:bg-[var(--surface-pressed)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      :class="{ 'text-green-600 dark:text-green-400': refreshState === 'success' }"
      :title="refreshState === 'success' ? '已刷新' : '刷新'"
      :data-testid="withTestIds ? 'root-action-refresh' : undefined"
      :disabled="refreshState !== 'idle'"
      @click.stop="$emit('refresh')"
    >
      <Check v-if="refreshState === 'success'" class="size-3.5 pointer-events-none" :stroke-width="2.5" />
      <RefreshCw
        v-else
        class="size-3.5 pointer-events-none"
        :class="{ 'animate-spin': refreshState === 'loading' }"
        :stroke-width="2"
      />
    </button>
    <button
      class="flex size-5.5 items-center justify-center rounded text-gray-500 hover:bg-[var(--surface-pressed)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      title="全部折叠"
      :data-testid="withTestIds ? 'root-action-collapse-all' : undefined"
      @click.stop="$emit('collapse-all')"
    >
      <ChevronsDownUp class="size-3.5 pointer-events-none" :stroke-width="2" />
    </button>
  </div>
</template>

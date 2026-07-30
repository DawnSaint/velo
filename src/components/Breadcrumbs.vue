<script setup lang="ts">
import { ChevronRight, FileText } from '@lucide/vue'
import type { HeadingBreadcrumb } from '@/utils/breadcrumbs'

defineProps<{
  fileName: string
  headings: HeadingBreadcrumb[]
}>()

const emit = defineEmits<{
  'reveal-heading': [heading: HeadingBreadcrumb]
}>()

function levelMarker(level: number): string {
  return '#'.repeat(level)
}
</script>

<template>
  <div
    class="flex h-7 shrink-0 items-center gap-0.5 px-3 text-xs text-gray-500 dark:text-gray-400"
    data-testid="breadcrumbs"
  >
    <!-- 文件名(常驻首段,不可点击跳转) -->
    <div class="flex min-w-0 shrink-0 items-center gap-1">
      <FileText class="size-3 shrink-0 text-gray-400 dark:text-gray-500" />
      <span class="max-w-[160px] truncate">{{ fileName }}</span>
    </div>

    <!-- 标题祖先链 -->
    <template v-for="(h, i) in headings" :key="i">
      <ChevronRight class="size-3 shrink-0 text-gray-300 dark:text-gray-600" />
      <button
        class="flex min-w-0 max-w-[200px] items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
        :title="h.text"
        @click="emit('reveal-heading', h)"
      >
        <span class="shrink-0 font-mono text-gray-400 dark:text-gray-500">{{ levelMarker(h.level) }}</span>
        <span class="truncate">{{ h.text }}</span>
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
// DiffView(#local-timeline):编辑器区 diff 视图。
// 当用户在侧栏 VersionHistoryPanel 选中某快照时,编辑器区切换为 DiffView,
// 展示该版本(旧)与当前内容(新)的行级 diff。顶部工具栏:
//  - 左:版本时间 + 触发方式
//  - 右:「恢复此版本」(emit restore)+「关闭」(回到编辑器)

import { computed } from 'vue'
import { RotateCcw, X, ArrowRight } from '@lucide/vue'
import { useVersionHistoryStore } from '@/stores/versionHistory'
import { useDocumentStore } from '@/stores/document'
import { diffLines, type DiffLine } from '@/utils/lineDiff'
import type { VersionSnapshot } from '@/stores/persistence'

const versionHistory = useVersionHistoryStore()
const documentStore = useDocumentStore()

const emit = defineEmits<{
  'restore': [snapshot: VersionSnapshot]
}>()

const selected = computed<VersionSnapshot | null>(() => versionHistory.selectedSnapshot)
const currentContent = computed(() => documentStore.content)

const diffResult = computed<DiffLine[]>(() => {
  const snap = selected.value
  if (!snap) return []
  return diffLines(snap.content, currentContent.value)
})

const diffStats = computed(() => {
  let added = 0
  let removed = 0
  for (const line of diffResult.value) {
    if (line.type === 'added') added++
    else if (line.type === 'removed') removed++
  }
  return { added, removed }
})

function formatTime(ts: number): string {
  const date = new Date(ts)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day} ${hh}:${mm}:${ss}`
}

function triggerLabel(trigger: string): string {
  if (trigger === 'auto') return '自动保存'
  if (trigger === 'blur') return '失焦保存'
  return '手动保存'
}

function onRestore() {
  const snap = selected.value
  if (!snap) return
  emit('restore', snap)
  versionHistory.closeDiffView()
}

function onClose() {
  versionHistory.closeDiffView()
}
</script>

<template>
  <div class="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--surface-2)]">
    <!-- 工具栏 -->
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4 py-2">
      <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span v-if="selected" class="flex items-center gap-1.5">
          <span class="font-medium text-gray-700 dark:text-gray-200">{{ formatTime(selected.savedAt) }}</span>
          <span class="rounded bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px]">{{ triggerLabel(selected.trigger) }}</span>
        </span>
        <ArrowRight class="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" />
        <span>当前内容</span>
        <span
          v-if="diffStats.added > 0 || diffStats.removed > 0"
          class="flex items-center gap-2"
        >
          <span class="text-green-600 dark:text-green-400">+{{ diffStats.added }}</span>
          <span class="text-red-600 dark:text-red-400">-{{ diffStats.removed }}</span>
        </span>
        <span v-else class="text-gray-400">内容一致</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-md bg-[var(--accent,#1F71D9)] px-3 py-1 text-xs font-medium text-white transition-colors hover:opacity-90"
          :disabled="!selected"
          @click="onRestore"
        >
          <RotateCcw class="h-3.5 w-3.5" />
          恢复此版本
        </button>
        <button
          class="rounded-md p-1 text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
          title="关闭 diff 视图"
          @click="onClose"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- diff 内容 -->
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="font-mono text-xs leading-relaxed">
        <div
          v-for="(line, idx) in diffResult"
          :key="idx"
          class="flex"
          :class="{
            'bg-green-50 dark:bg-green-950/30': line.type === 'added',
            'bg-red-50 dark:bg-red-950/30': line.type === 'removed',
          }"
        >
          <span class="w-10 shrink-0 select-none border-r border-[var(--surface-border)] px-2 text-right text-gray-300 dark:text-gray-600">
            {{ line.type === 'added' ? line.newLineNumber : line.oldLineNumber || '' }}
          </span>
          <span
            class="shrink-0 select-none px-2"
            :class="{
              'text-green-600 dark:text-green-400': line.type === 'added',
              'text-red-600 dark:text-red-400': line.type === 'removed',
              'text-gray-300 dark:text-gray-600': line.type === 'unchanged',
            }"
          >
            {{ line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ' }}
          </span>
          <span
            class="whitespace-pre-wrap px-1"
            :class="{
              'text-green-700 dark:text-green-300': line.type === 'added',
              'text-red-700 dark:text-red-300': line.type === 'removed',
              'text-gray-600 dark:text-gray-300': line.type === 'unchanged',
            }"
          >
            {{ line.text || ' ' }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

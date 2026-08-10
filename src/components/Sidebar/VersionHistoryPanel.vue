<script setup lang="ts">
// 版本历史侧栏面板(#local-timeline):列出当前文件的版本快照条目。
// 点击条目 → versionHistory.selectSnapshot → 编辑器区切换为 DiffView。
// 顶部标题栏右侧 Trash2 图标 hover 显示「清除全部历史」。
//
// 由 ActivityBar「版本历史」入口驱动(App.vue showSidebarTab('history'))。

import { computed, onMounted, watch } from 'vue'
import { History, Trash2 } from '@lucide/vue'
import { useVersionHistoryStore } from '@/stores/versionHistory'
import { useDocumentStore } from '@/stores/document'
import type { VersionSnapshot } from '@/stores/persistence'

const versionHistory = useVersionHistoryStore()
const documentStore = useDocumentStore()

const snapshots = computed<VersionSnapshot[]>(() => versionHistory.currentFileSnapshots ?? [])
const selectedId = computed<string | null>(() => versionHistory.selectedSnapshotId)

function formatTime(ts: number): string {
  const date = new Date(ts)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day} ${hh}:${mm}`
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function triggerLabel(trigger: string): string {
  if (trigger === 'auto') return '自动'
  if (trigger === 'blur') return '失焦'
  return '手动'
}

function triggerClass(trigger: string): string {
  if (trigger === 'auto') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
  if (trigger === 'blur') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
  return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
}

function onSelectSnapshot(id: string) {
  versionHistory.selectSnapshot(id)
}

async function onDeleteSnapshot(e: Event, id: string) {
  e.stopPropagation()
  const path = documentStore.currentFilePath
  if (!path) return
  await versionHistory.deleteSnapshot(path, id)
}

async function onClearAll() {
  const path = documentStore.currentFilePath
  if (!path) return
  await versionHistory.clearHistory(path)
}

// 切换文件时重新加载快照
watch(() => documentStore.currentFilePath, async (path) => {
  if (path) {
    await versionHistory.loadSnapshots(path)
  }
})

onMounted(async () => {
  const path = documentStore.currentFilePath
  if (path && !versionHistory.currentFileSnapshots) {
    await versionHistory.loadSnapshots(path)
  }
})
</script>

<template>
  <div class="flex h-full min-w-0 flex-col overflow-hidden">
    <!-- 头部 -->
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4 py-2.5">
      <div class="flex items-center gap-1.5">
        <History class="h-4 w-4 text-[var(--text-secondary)]" />
        <span class="text-sm font-medium text-gray-700 dark:text-gray-200">版本历史</span>
      </div>
      <button
        v-if="snapshots.length > 0"
        class="rounded p-0.5 text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-red-500 dark:text-gray-500"
        title="清除全部历史"
        @click="onClearAll"
      >
        <Trash2 class="h-4 w-4" />
      </button>
    </div>

    <!-- 空状态 -->
    <div
      v-if="snapshots.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-gray-400 dark:text-gray-600"
    >
      <History :size="28" :stroke-width="1.2" />
      <span class="text-xs">暂无版本历史</span>
      <span class="text-[11px] text-gray-300 dark:text-gray-600">保存文件后会自动记录快照</span>
    </div>

    <!-- 版本列表 -->
    <div
      v-else
      class="min-h-0 flex-1 overflow-y-auto py-1"
    >
      <button
        v-for="snap in snapshots"
        :key="snap.id"
        class="group flex w-full cursor-pointer flex-col gap-1 px-3 py-2 text-left transition-colors"
        :class="selectedId === snap.id
          ? 'bg-[var(--surface-hover)] border-l-2 border-[var(--accent,#1F71D9)]'
          : 'border-l-2 border-transparent hover:bg-[var(--surface-hover)]'"
        @click="onSelectSnapshot(snap.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-gray-700 dark:text-gray-200">
              {{ formatTime(snap.savedAt) }}
            </span>
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="triggerClass(snap.trigger)"
            >
              {{ triggerLabel(snap.trigger) }}
            </span>
          </div>
          <button
            class="shrink-0 rounded p-0.5 text-gray-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100 dark:text-gray-600"
            title="删除此版本"
            @click="onDeleteSnapshot($event, snap.id)"
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>
        <span class="text-[11px] text-gray-400">
          {{ relativeTime(snap.savedAt) }}
        </span>
      </button>
    </div>
  </div>
</template>

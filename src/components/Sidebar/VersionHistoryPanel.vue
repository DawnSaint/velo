<script setup lang="ts">
// 版本历史侧栏面板(#local-timeline):列出当前文件的版本快照条目。
// 点击条目 → versionHistory.selectSnapshot → 编辑器区切换为 DiffView。
// 快照由系统自动管理(保存时记录,按 CAP + 过期天数自动修剪),
// 用户不可手动删除单条或清空全部。
//
// dirty 时列表头部插入虚拟"未保存"条目(UNSAVED_ID)。
//
// 由 ActivityBar「版本历史」入口驱动(App.vue showSidebarTab('history'))。

import { computed, onMounted, watch } from 'vue'
import { History, Circle } from '@lucide/vue'
import { useVersionHistoryStore, UNSAVED_ID } from '@/stores/versionHistory'
import { useDocumentStore } from '@/stores/document'
import { diffLines } from '@/utils/lineDiff'
import type { VersionSnapshot } from '@/stores/persistence'

const versionHistory = useVersionHistoryStore()
const documentStore = useDocumentStore()

const snapshots = computed<VersionSnapshot[]>(() => versionHistory.displaySnapshots ?? [])
const selectedId = computed<string | null>(() => versionHistory.selectedSnapshotId)

/** 每个条目与其前一版本的 diff 行数统计(+added / -removed)。
 *  diff old 方取 versionHistory.diffOldContent(前一版本内容),
 *  diff new 方取该条目自身 content。 */
const diffStatsMap = computed(() => {
  const map = new Map<string, { added: number; removed: number }>()
  for (const snap of snapshots.value) {
    const old = versionHistory.diffOldContent(snap.id)
    let added = 0, removed = 0
    for (const l of diffLines(old, snap.content)) {
      if (l.type === 'added') added++
      else if (l.type === 'removed') removed++
    }
    map.set(snap.id, { added, removed })
  }
  return map
})

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

function isUnsaved(snap: VersionSnapshot): boolean {
  return snap.id === UNSAVED_ID
}

function onSelectSnapshot(id: string) {
  versionHistory.selectSnapshot(id)
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
    <div class="flex shrink-0 items-center border-b border-[var(--surface-border)] px-4 py-2.5">
      <div class="flex items-center gap-1.5">
        <History class="h-4 w-4 text-[var(--text-secondary)]" />
        <span class="text-sm font-medium text-gray-700 dark:text-gray-200">版本历史</span>
      </div>
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
      v-velo-scroll
      class="min-h-0 flex-1 overflow-y-auto"
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
            <!-- 未保存条目:蓝点 + "未保存"标签 -->
            <template v-if="isUnsaved(snap)">
              <Circle class="h-2 w-2 fill-current text-blue-500 dark:text-blue-400" />
              <span class="text-xs font-medium text-blue-600 dark:text-blue-400">未保存</span>
            </template>
            <!-- 真实快照:时间 -->
            <template v-else>
              <span class="text-xs font-medium text-gray-700 dark:text-gray-200">
                {{ formatTime(snap.savedAt) }}
              </span>
            </template>
          </div>
          <!-- diff 行数统计 -->
          <span
            v-if="diffStatsMap.get(snap.id)?.added || diffStatsMap.get(snap.id)?.removed"
            class="flex shrink-0 items-center gap-1.5 text-[10px] font-medium"
          >
            <span class="text-green-600 dark:text-green-400">+{{ diffStatsMap.get(snap.id)!.added }}</span>
            <span class="text-red-600 dark:text-red-400">-{{ diffStatsMap.get(snap.id)!.removed }}</span>
          </span>
          <span v-else class="shrink-0 text-[10px] text-gray-300 dark:text-gray-600">无变化</span>
        </div>
        <span class="text-[11px] text-gray-400">
          {{ isUnsaved(snap) ? '当前编辑器内容' : relativeTime(snap.savedAt) }}
        </span>
      </button>
    </div>
  </div>
</template>

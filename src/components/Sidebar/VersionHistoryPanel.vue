<script setup lang="ts">
// 版本历史侧栏面板(#local-timeline):列出当前文件的版本快照条目。
// 点击条目 → versionHistory.selectEntry → 编辑器区切换为 DiffView。
// 快照由系统自动管理(保存时记录,按 CAP + 过期天数自动修剪),
// 用户不可手动删除单条或清空全部。
//
// dirty 时列表头部插入虚拟"未保存"条目(UNSAVED_ID)。
//
// Git 历史集成(#local-timeline-git):
// 当文件在 Git 仓库中时,额外展示 Git commit 历史条目(带 Git icon 区分)。
// 头部有开关切换是否加载 Git 历史。
// Git 条目的 +/- 统计在选中时懒计算(git show → diff → gitDiffStats 缓存),
// 未选中时显示 ··· 占位。
//
// 由 ActivityBar「版本历史」入口驱动(App.vue showSidebarTab('history'))。

import { computed, watch } from 'vue'
import { History, Circle, GitBranch, GitCommit } from '@lucide/vue'
import { useVersionHistoryStore, UNSAVED_ID } from '@/stores/versionHistory'
import { useDocumentStore } from '@/stores/document'
import { diffLines } from '@/utils/lineDiff'
import type { TimelineEntry } from '@/stores/versionHistory'

const versionHistory = useVersionHistoryStore()
const documentStore = useDocumentStore()

const entries = computed<TimelineEntry[]>(() => versionHistory.displayEntries ?? [])
const selectedId = computed<string | null>(() => versionHistory.selectedEntryId)

/** Git 仓库状态:undefined=未检测, null=非 git 仓库, string=仓库根 */
const gitRepoStatus = computed(() => versionHistory.currentFileGitRoot)

/** 本地快照 + Git 条目的 diff 行数统计
 *  - Git 条目从 gitDiffStats 缓存读取(预加载后已计算)
 *  - 本地快照同步计算;若 Git content 还在加载中(gitContentLoaded=false),
 *    跳过所有条目统计(不显示 +/-),避免先显示错误的全文新增再跳变。 */
const diffStatsMap = computed(() => {
  const map = new Map<string, { added: number; removed: number }>()
  // Git content 预加载未完成时不计算任何统计,避免跳变
  if (!versionHistory.gitContentLoaded) return map
  for (const entry of entries.value) {
    if (entry.source === 'git') {
      const stats = versionHistory.gitDiffStats.get(entry.id)
      if (stats) map.set(entry.id, stats)
      continue
    }
    // 本地快照:同步计算(content 在内存中)
    const old = versionHistory.diffOldContent(entry.id)
    const newContent = entry.content ?? ''
    let added = 0, removed = 0
    for (const l of diffLines(old, newContent)) {
      if (l.type === 'added') added++
      else if (l.type === 'removed') removed++
    }
    map.set(entry.id, { added, removed })
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

function isUnsaved(entry: TimelineEntry): boolean {
  return entry.id === UNSAVED_ID
}

function isGit(entry: TimelineEntry): boolean {
  return entry.source === 'git'
}

function onSelectEntry(id: string) {
  versionHistory.selectEntry(id)
}

/** 切换 Git 历史显示开关(只影响 UI 显示,不影响 diff 基准) */
function onToggleGit() {
  versionHistory.includeGit = !versionHistory.includeGit
}

// 切换文件时重新加载快照 + Git 历史
// immediate=true 确保组件挂载时也触发首次加载(替代 onMounted)
// 用竞态守卫避免快速切换时上一次加载覆盖新数据
let loadToken = 0
watch(() => documentStore.currentFilePath, async (path, oldPath) => {
  if (!path) return
  // 切换文件时先清除选中态,避免显示旧文件的 diff
  if (path !== oldPath) {
    versionHistory.selectedEntryId = null
    versionHistory.diffViewActive = false
  }
  const token = ++loadToken
  // 快照未缓存则加载
  if (!versionHistory.currentFileSnapshots) {
    await versionHistory.loadSnapshots(path)
  }
  // 竞态检查:如果期间又切换了文件,放弃本次加载
  if (token !== loadToken) return
  // Git 历史未检测则加载
  if (versionHistory.currentFileGitRoot === undefined) {
    await versionHistory.loadGitHistory(path)
  }
}, { immediate: true })
</script>

<template>
  <div class="flex h-full min-w-0 flex-col overflow-hidden">
    <!-- 头部 -->
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4 py-2.5">
      <div class="flex items-center gap-1.5">
        <History class="h-4 w-4 text-[var(--text-secondary)]" />
        <span class="text-sm font-medium text-gray-700 dark:text-gray-200">版本历史</span>
      </div>
      <!-- Git 历史开关 -->
      <button
        v-if="gitRepoStatus !== undefined && gitRepoStatus !== null"
        class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
        :class="versionHistory.includeGit
          ? 'bg-[var(--accent,#1F71D9)]/10 text-[var(--accent,#1F71D9)]'
          : 'text-gray-400 hover:bg-[var(--surface-hover)]'"
        :title="versionHistory.includeGit ? '关闭 Git 历史加载' : '开启 Git 历史加载'"
        @click="onToggleGit"
      >
        <GitBranch class="h-3 w-3" />
        <span>Git</span>
      </button>
    </div>

    <!-- 空状态 -->
    <div
      v-if="entries.length === 0"
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
        v-for="entry in entries"
        :key="entry.id"
        class="group flex w-full cursor-pointer flex-col gap-1 px-3 py-2 text-left transition-colors"
        :class="selectedId === entry.id
          ? 'bg-[var(--surface-hover)] border-l-2 border-[var(--accent,#1F71D9)]'
          : 'border-l-2 border-transparent hover:bg-[var(--surface-hover)]'"
        @click="onSelectEntry(entry.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <!-- 未保存条目:蓝点 + "未保存"标签 -->
            <template v-if="isUnsaved(entry)">
              <Circle class="h-2 w-2 fill-current text-blue-500 dark:text-blue-400" />
              <span class="text-xs font-medium text-blue-600 dark:text-blue-400">未保存</span>
            </template>
            <!-- Git 条目:Git icon + 短 hash -->
            <template v-else-if="isGit(entry)">
              <GitCommit class="h-3 w-3 text-orange-500 dark:text-orange-400" />
              <span class="text-xs font-medium text-gray-700 dark:text-gray-200">
                {{ entry.git?.shortHash }}
              </span>
            </template>
            <!-- 本地快照:时间 -->
            <template v-else>
              <span class="text-xs font-medium text-gray-700 dark:text-gray-200">
                {{ formatTime(entry.timestamp) }}
              </span>
            </template>
          </div>
          <!-- diff 行数统计 -->
          <span
            v-if="diffStatsMap.get(entry.id)?.added || diffStatsMap.get(entry.id)?.removed"
            class="flex shrink-0 items-center gap-1.5 text-[10px] font-medium"
          >
            <span class="text-green-600 dark:text-green-400">+{{ diffStatsMap.get(entry.id)!.added }}</span>
            <span class="text-red-600 dark:text-red-400">-{{ diffStatsMap.get(entry.id)!.removed }}</span>
          </span>
          <span v-else-if="!isGit(entry)" class="shrink-0 text-[10px] text-gray-300 dark:text-gray-600">无变化</span>
        </div>
        <!-- 第二行:Git 条目显示 commit subject,本地快照显示相对时间 -->
        <span v-if="isGit(entry)" class="truncate text-[11px] text-gray-400">
          {{ entry.git?.subject }}
        </span>
        <span v-else class="text-[11px] text-gray-400">
          {{ isUnsaved(entry) ? '当前编辑器内容' : relativeTime(entry.timestamp) }}
        </span>
      </button>
    </div>
  </div>
</template>

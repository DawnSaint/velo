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

import { computed, ref, watch } from 'vue'
import { History, GitBranch, GitCommit, RefreshCw, Loader2 } from '@lucide/vue'
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

/** Git 历史正在加载 */
const gitLoading = computed(() => versionHistory.gitLoading)

/** Git 条目 hover tooltip 状态 */
const hoveredGitEntry = ref<TimelineEntry | null>(null)
const tooltipStyle = ref({ left: '0px', top: '0px' })

function onGitMouseEnter(entry: TimelineEntry, e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // tooltip 显示在条目右侧,如果右侧空间不足则显示在左侧
  const tooltipWidth = 320
  const left = rect.right + 8 + tooltipWidth > window.innerWidth
    ? rect.left - 8 - tooltipWidth
    : rect.right + 8
  tooltipStyle.value = {
    left: `${Math.max(8, left)}px`,
    top: `${rect.top}px`,
  }
  hoveredGitEntry.value = entry
}

function onGitMouseLeave() {
  hoveredGitEntry.value = null
}

/** 格式化 Git commit 完整时间 */
function formatGitDate(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

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

/** 刷新当前文件的 Git 历史 */
async function onRefreshGit() {
  const path = documentStore.currentFilePath
  if (!path) return
  versionHistory.invalidateGit(path)
  await versionHistory.loadGitHistory(path)
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
      <!-- Git 历史开关 + 刷新按钮 -->
      <div v-if="gitRepoStatus !== undefined && gitRepoStatus !== null" class="flex items-center gap-1">
        <button
          class="rounded-md p-1 transition-colors hover:bg-[var(--surface-hover)]"
          :class="versionHistory.includeGit
            ? 'text-orange-500 dark:text-orange-400'
            : 'text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300'"
          :title="versionHistory.includeGit ? '关闭 Git 历史加载' : '开启 Git 历史加载'"
          @click="onToggleGit"
        >
          <GitBranch class="h-3 w-3" />
        </button>
        <button
          class="rounded-md p-1 text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
          :disabled="gitLoading"
          title="刷新 Git 历史"
          @click="onRefreshGit"
        >
          <RefreshCw class="h-3 w-3" :class="{ 'animate-spin': gitLoading }" />
        </button>
      </div>
    </div>

    <!-- 加载中(Git 历史加载期间不显示列表) -->
    <div
      v-if="gitLoading"
      class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-gray-400 dark:text-gray-600"
    >
      <Loader2 class="h-5 w-5 animate-spin" />
      <span class="text-xs">正在加载版本历史...</span>
    </div>

    <!-- 空状态 -->
    <div
      v-else-if="entries.length === 0"
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
          ? 'bg-[var(--surface-hover)]'
          : 'hover:bg-[var(--surface-hover)]'"
        @click="onSelectEntry(entry.id)"
        @mouseenter="isGit(entry) ? onGitMouseEnter(entry, $event) : undefined"
        @mouseleave="isGit(entry) ? onGitMouseLeave() : undefined"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <!-- 未保存条目:amber dot + "未保存"标签(颜色/大小对齐 TabBar tab-dot) -->
            <template v-if="isUnsaved(entry)">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-400" />
              <span class="text-xs font-medium text-gray-700 dark:text-gray-200">未保存</span>
            </template>
            <!-- Git 条目:Git icon + commit subject(truncate) -->
            <template v-else-if="isGit(entry)">
              <GitCommit class="h-3 w-3 shrink-0 text-orange-500 dark:text-orange-400" />
              <span class="truncate text-xs font-medium text-gray-700 dark:text-gray-200">
                {{ entry.git?.subject }}
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
        <!-- 第二行:Git 条目显示时间,本地快照显示相对时间 -->
        <span v-if="isGit(entry)" class="truncate text-[11px] text-gray-400">
          {{ relativeTime(entry.timestamp) }}
        </span>
        <span v-else class="text-[11px] text-gray-400">
          {{ isUnsaved(entry) ? '当前编辑器内容' : relativeTime(entry.timestamp) }}
        </span>
      </button>
    </div>

    <!-- Git 条目 hover tooltip:显示完整提交信息 -->
    <Teleport to="body">
      <div
        v-if="hoveredGitEntry?.git"
        class="fixed z-[1100] w-80 rounded-lg bg-[var(--surface-3)] p-3 text-xs shadow-[var(--shadow-popover)] ring-1 ring-black/5 dark:ring-white/10"
        :style="tooltipStyle"
      >
        <!-- subject -->
        <div class="mb-2 break-words font-medium text-gray-800 dark:text-gray-100">
          {{ hoveredGitEntry.git.subject }}
        </div>
        <!-- 元信息:hash · 提交者 · 时间 同一行 -->
        <div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
          <GitCommit class="h-3 w-3 shrink-0 text-orange-500 dark:text-orange-400" />
          <span class="shrink-0">{{ hoveredGitEntry.git.shortHash }}</span>
          <span class="shrink-0">·</span>
          <span class="truncate">{{ hoveredGitEntry.git.author }}</span>
          <span class="shrink-0">·</span>
          <span class="shrink-0">{{ formatGitDate(hoveredGitEntry.timestamp) }}</span>
        </div>
        <!-- message body(如果有) -->
        <div
          v-if="hoveredGitEntry.git.message !== hoveredGitEntry.git.subject"
          class="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-t border-[var(--surface-border)] pt-2 text-[11px] text-gray-600 dark:text-gray-300"
        >
          {{ hoveredGitEntry.git.message }}
        </div>
      </div>
    </Teleport>
  </div>
</template>

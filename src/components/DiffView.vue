<script setup lang="ts">
// DiffView(#local-timeline):编辑器区 diff 视图。
// 当用户在侧栏 VersionHistoryPanel 选中某条目时,编辑器区切换为 DiffView,
// 展示该版本与其前一版本的行级 diff(同 VSCode Local History 语义)。
// 顶部工具栏:
//  - 左:版本时间 + diff 行数统计
//  - 右:「恢复此版本」(emit restore)+「关闭」(回到编辑器)
//
// 选中虚拟"未保存"条目(UNSAVED_ID)时不显示「恢复此版本」按钮。
// 选中 Git 条目时不显示「恢复此版本」按钮(Git commit 不可直接恢复为编辑器内容)。
//
// Git 条目的 content 和前一版本 content 都可能需要异步加载(git show),
// 加载期间显示 loading spinner。

import { computed, ref, watch } from 'vue'
import { RotateCcw, X, ArrowRight, Loader2 } from '@lucide/vue'
import { useVersionHistoryStore, UNSAVED_ID } from '@/stores/versionHistory'
import { diffLines, type DiffLine } from '@/utils/lineDiff'
import type { TimelineEntry } from '@/stores/versionHistory'

const versionHistory = useVersionHistoryStore()

const emit = defineEmits<{
  'restore': [snapshot: TimelineEntry]
}>()

const selected = computed<TimelineEntry | null>(() => versionHistory.selectedEntry)
const isSelectedUnsaved = computed(() => versionHistory.selectedEntryId === UNSAVED_ID)
const isSelectedGit = computed(() => selected.value?.source === 'git')

/** diff 结果(异步加载 Git content 时有 loading 态) */
const diffResult = ref<DiffLine[]>([])
const loading = ref(false)

/** diff 行数统计 */
const diffStats = computed(() => {
  let added = 0
  let removed = 0
  for (const line of diffResult.value) {
    if (line.type === 'added') added++
    else if (line.type === 'removed') removed++
  }
  return { added, removed }
})

/** 异步加载 diff:选中条目变化时触发
 *  - 本地快照:content 和前一版本 content 都在内存中,同步计算
 *  - Git 条目:content 可能需要 git show 懒加载,前一版本 content 也可能需要 */
async function loadDiff() {
  const entry = selected.value
  if (!entry) {
    diffResult.value = []
    return
  }

  loading.value = true
  try {
    // 获取选中条目的 content
    // 注意:不能用 entry.content 判断是否已加载——entry 是 computed 返回的快照对象,
    // 在 gitContentCache 写入后 displayEntries 会重算,但此时 loadDiff 里的 entry 是旧的。
    // 应该始终通过 loadGitContent 获取(内部有缓存检查,命中则直接返回)。
    let newContent: string
    if (entry.source === 'git') {
      newContent = await versionHistory.loadGitContent(entry)
    } else {
      newContent = entry.content ?? ''
    }

    // 获取前一版本 content(异步)
    const oldResult = await versionHistory.diffOldContentAsync(entry.id)
    const oldContent = oldResult.content ?? ''

    diffResult.value = diffLines(oldContent, newContent)
  }
  catch (e) {
    console.error('loadDiff 失败', e)
    diffResult.value = []
  }
  finally {
    loading.value = false
  }
}

// 选中条目变化时重新加载 diff
watch(() => versionHistory.selectedEntryId, () => {
  loadDiff()
}, { immediate: true })

// Git content 缓存变化时重新加载(gitContentCache 写入后 displayEntries 重算,
// selectedEntry 可能拿到新对象。但此时 loading 为 true 的会被跳过,
// 等 loadDiff 完成后 loading 变 false,如果 content 变了再触发一次)
watch(() => selected.value?.content, (newVal, oldVal) => {
  if (!loading.value && newVal !== oldVal) loadDiff()
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

function onRestore() {
  const entry = selected.value
  if (!entry) return
  emit('restore', entry)
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
          <!-- 未保存条目 -->
          <template v-if="isSelectedUnsaved">
            <span class="font-medium text-blue-600 dark:text-blue-400">未保存内容</span>
          </template>
          <!-- Git 条目 -->
          <template v-else-if="isSelectedGit">
            <span class="font-medium text-orange-600 dark:text-orange-400">{{ selected.git?.shortHash }}</span>
            <span class="truncate text-gray-400">{{ selected.git?.subject }}</span>
          </template>
          <!-- 本地快照 -->
          <template v-else>
            <span class="font-medium text-gray-700 dark:text-gray-200">{{ formatTime(selected.timestamp) }}</span>
          </template>
        </span>
        <ArrowRight class="h-3.5 w-3.5 text-gray-300 dark:text-gray-600" />
        <span>此版本</span>
        <span
          v-if="!loading && (diffStats.added > 0 || diffStats.removed > 0)"
          class="flex items-center gap-2"
        >
          <span class="text-green-600 dark:text-green-400">+{{ diffStats.added }}</span>
          <span class="text-red-600 dark:text-red-400">-{{ diffStats.removed }}</span>
        </span>
        <span v-else-if="!loading" class="text-gray-400">内容一致</span>
      </div>
      <div class="flex items-center gap-2">
        <!-- 未保存条目和 Git 条目不显示「恢复此版本」 -->
        <button
          v-if="!isSelectedUnsaved && !isSelectedGit"
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
    <div v-velo-scroll class="min-h-0 flex-1 overflow-y-auto">
      <!-- loading 态 -->
      <div
        v-if="loading"
        class="flex h-full items-center justify-center"
      >
        <Loader2 class="h-5 w-5 animate-spin text-gray-300 dark:text-gray-600" />
      </div>
      <!-- 空结果 -->
      <div
        v-else-if="diffResult.length === 0"
        class="flex h-full items-center justify-center text-xs text-gray-400"
      >
        <span>无 diff 内容</span>
      </div>
      <!-- diff 结果 -->
      <div v-else class="font-mono text-xs leading-relaxed">
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

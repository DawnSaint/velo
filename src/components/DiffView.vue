<script setup lang="ts">
// DiffView(#local-timeline):编辑器区 diff 视图。
// 当用户在侧栏 VersionHistoryPanel 选中某条目时,编辑器区切换为 DiffView,
// 展示该版本与其前一版本的行级 diff(同 VSCode Local History 语义)。
// 顶部工具栏:
//  - 左:版本时间 + diff 行数统计
//  - 右:「恢复」/「回退修改」+「关闭」(回到编辑器)
//
// 选中虚拟"未保存"条目(UNSAVED_ID)时显示「回退修改」按钮(回退到上一版本)。
// 选中 Git 条目时不显示「恢复」按钮(Git commit 不可直接恢复为编辑器内容)。
//
// Git 条目的 content 和前一版本 content 都可能需要异步加载(git show),
// 加载期间显示 loading spinner。
//
// 双模式(#diff-switch):
// - 源码 diff(sourceMode=true):行级列表,+/- 前缀,行背景色区分增删(原有实现)
// - 预览 diff(sourceMode=false):ProseMirror 只读渲染 + Decoration 增删标记(绿色背景=新增,红色背景=删除)
// 两种模式共用同一 Myers 算法实现,但不共用同一份结果(源码按行对齐、预览按 block 对齐);
// 切回预览会重建只读 EditorView 并重新解析 + 比对。
// 模式切换复用底部状态栏的 sourceMode toggle(Eye/Code2 按钮)。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X, Loader2, Undo2, ChevronUp, ChevronDown } from '@lucide/vue'
import { useVersionHistoryStore, UNSAVED_ID } from '@/stores/versionHistory'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { diffLines, isPureCharRemoval, type DiffLine } from '@/utils/lineDiff'
import { extractSourceAnchors, type DiffAnchor } from '@/utils/diffAnchors'
import type { TimelineEntry } from '@/stores/versionHistory'
import WysiwygDiffView from '@/components/ProseMirrorEditor/WysiwygDiffView.vue'
import DiffOverviewRuler from '@/components/DiffOverviewRuler.vue'

const versionHistory = useVersionHistoryStore()
const documentStore = useDocumentStore()
const editorStore = useEditorStore()

const emit = defineEmits<{
  'restore': [snapshot: TimelineEntry]
  'revert': [filePath: string, content: string]
}>()

const selected = computed<TimelineEntry | null>(() => versionHistory.selectedEntry)
const isSelectedUnsaved = computed(() => versionHistory.selectedEntryId === UNSAVED_ID)
const isSelectedGit = computed(() => selected.value?.source === 'git')

// diff 模式复用 documentStore.sourceMode:
// false = WYSIWYG 预览 diff; true = 源码行级 diff
// 状态栏的 Eye/Code2 按钮控制切换,不在此组件内自建按钮
const isSourceMode = computed(() => documentStore.sourceMode)

// ========== diff 数据 ==========

/** diff 结果(异步加载 Git content 时有 loading 态) */
const diffResult = ref<DiffLine[]>([])
/** 新版本和旧版本的原始 markdown(供 WYSIWYG diff 使用) */
const newContent = ref('')
const oldContent = ref('')
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

/** 源码模式展示行:「修改」配对(removed+added)合并为单行渲染,
 * 跳过被合并的 removed 行(VSCode inline diff 风格:
 * 整行浅绿 + 新增字符深绿 + 删除字符红色删除线) */
const displayRows = computed(() => diffResult.value.filter(l => !l.mergedIntoNext))

// ========== 变更锚点与 hunk 导航(#diff-autoscroll)==========

/** 实际渲染模式:newContent 为空时模板回退到源码列表,锚点来源与之对齐 */
const effectiveSourceMode = computed(() => isSourceMode.value || !newContent.value)
const sourceScrollRef = ref<HTMLElement | null>(null)
const wysiwygRef = ref<InstanceType<typeof WysiwygDiffView> | null>(null)

const rawSourceAnchors = computed(() => extractSourceAnchors(displayRows.value))
const measuredSourceAnchors = ref<DiffAnchor[]>([])
const sourceAnchors = computed(() => (
  measuredSourceAnchors.value.length === rawSourceAnchors.value.length
    ? measuredSourceAnchors.value
    : rawSourceAnchors.value
))
const wysiwygAnchors = ref<DiffAnchor[]>([])

let sourceRo: ResizeObserver | null = null
let sourceMeasureRaf: number | null = null

/** 源码模式用真实行 DOM 像素位置校正 ruler 比例(处理长行自动折行导致的比例偏移) */
function measureSourceAnchors() {
  const raw = rawSourceAnchors.value
  const scroller = sourceScrollRef.value
  if (!effectiveSourceMode.value || !scroller || raw.length === 0) {
    measuredSourceAnchors.value = raw
    return
  }
  const scrollHeight = scroller.scrollHeight
  const scrollerRect = scroller.getBoundingClientRect()
  if (scrollHeight <= 0 || scrollerRect.height <= 0) {
    measuredSourceAnchors.value = raw
    return
  }
  const scrollTop = scroller.scrollTop
  measuredSourceAnchors.value = raw.map((anchor) => {
    const startIdx = anchor.rowIndex
    const endIdx = anchor.rowEndIndex
    if (startIdx === undefined || endIdx === undefined) return anchor
    const firstRow = scroller.querySelector<HTMLElement>(`[data-diff-row-idx="${startIdx}"]`)
    const lastRow = scroller.querySelector<HTMLElement>(`[data-diff-row-idx="${Math.max(startIdx, endIdx - 1)}"]`)
    if (!firstRow || !lastRow) return anchor
    const topY = scrollTop + (firstRow.getBoundingClientRect().top - scrollerRect.top)
    const bottomY = scrollTop + (lastRow.getBoundingClientRect().bottom - scrollerRect.top)
    const startRatio = Math.min(1, Math.max(0, topY / scrollHeight))
    const endRatio = Math.min(1, Math.max(startRatio, bottomY / scrollHeight))
    return { ...anchor, startRatio, endRatio }
  })
}

function scheduleMeasureSourceAnchors() {
  if (sourceMeasureRaf !== null) return
  sourceMeasureRaf = requestAnimationFrame(() => {
    sourceMeasureRaf = null
    measureSourceAnchors()
  })
}

watch([rawSourceAnchors, effectiveSourceMode], () => {
  measuredSourceAnchors.value = rawSourceAnchors.value
  if (effectiveSourceMode.value) {
    void nextTick(() => scheduleMeasureSourceAnchors())
  }
}, { immediate: true })
const activeAnchors = computed(() =>
  effectiveSourceMode.value ? sourceAnchors.value : wysiwygAnchors.value,
)
const activeAnchorIndex = ref(-1)
const hasAnchors = computed(() => !loading.value && activeAnchors.value.length > 0)
const activeScrollElement = computed<HTMLElement | null>(() => (
  effectiveSourceMode.value
    ? sourceScrollRef.value
    : (wysiwygRef.value?.scrollContainerRef ?? null)
))

/** 新版本 diff 就绪后需要自动跳到第 0 处变更 */
let pendingAutoScroll = false
/** 从源码切回预览时,等 WysiwygDiffView 挂载并上报锚点后恢复当前序号 */
let pendingModeSync = false

function scrollSourceToRow(rowIndex: number) {
  const scroller = sourceScrollRef.value
  if (!scroller) return
  const rowEl = scroller.querySelector<HTMLElement>(`[data-diff-row-idx="${rowIndex}"]`)
  if (!rowEl) return
  const scrollerRect = scroller.getBoundingClientRect()
  const rowRect = rowEl.getBoundingClientRect()
  const targetTop = scroller.scrollTop + (rowRect.top - scrollerRect.top) - scroller.clientHeight * 0.25
  scroller.scrollTop = Math.max(0, targetTop)
}

function jumpToAnchor(idx: number) {
  const anchors = activeAnchors.value
  if (anchors.length === 0) {
    activeAnchorIndex.value = -1
    return
  }
  const wrapped = ((idx % anchors.length) + anchors.length) % anchors.length
  activeAnchorIndex.value = wrapped
  const anchor = anchors[wrapped]
  if (effectiveSourceMode.value) {
    scrollSourceToRow(anchor.rowIndex ?? 0)
  }
  else {
    wysiwygRef.value?.scrollToAnchor(anchor)
  }
}

function goToPrevAnchor() {
  if (!hasAnchors.value) return
  const nextIdx = activeAnchorIndex.value < 0
    ? activeAnchors.value.length - 1
    : activeAnchorIndex.value - 1
  jumpToAnchor(nextIdx)
}

function goToNextAnchor() {
  if (!hasAnchors.value) return
  const nextIdx = activeAnchorIndex.value < 0 ? 0 : activeAnchorIndex.value + 1
  jumpToAnchor(nextIdx)
}

function isRowInActiveHunk(idx: number): boolean {
  if (!effectiveSourceMode.value || activeAnchorIndex.value < 0) return false
  const anchor = activeAnchors.value[activeAnchorIndex.value]
  if (!anchor || anchor.rowIndex === undefined || anchor.rowEndIndex === undefined) return false
  return idx >= anchor.rowIndex && idx < anchor.rowEndIndex
}

function scheduleAutoScroll() {
  activeAnchorIndex.value = -1
  pendingAutoScroll = true
  pendingModeSync = false
  if (effectiveSourceMode.value) {
    void nextTick(() => {
      if (!pendingAutoScroll || loading.value || !effectiveSourceMode.value) return
      pendingAutoScroll = false
      if (sourceAnchors.value.length > 0) jumpToAnchor(0)
    })
  }
}

function onWysiwygAnchorsChange(anchors: DiffAnchor[]) {
  wysiwygAnchors.value = anchors
  if (loading.value || effectiveSourceMode.value) return
  if (pendingAutoScroll) {
    pendingAutoScroll = false
    if (anchors.length > 0) jumpToAnchor(0)
    return
  }
  if (pendingModeSync) {
    pendingModeSync = false
    if (anchors.length > 0) {
      const clamped = Math.max(0, Math.min(activeAnchorIndex.value, anchors.length - 1))
      jumpToAnchor(clamped)
    }
    else {
      activeAnchorIndex.value = -1
    }
  }
}

watch(isSourceMode, (toSource) => {
  if (loading.value) return
  if (toSource || !newContent.value) {
    pendingModeSync = false
    void nextTick(() => {
      if (sourceAnchors.value.length === 0) {
        activeAnchorIndex.value = -1
        return
      }
      const clamped = activeAnchorIndex.value < 0
        ? 0
        : Math.min(activeAnchorIndex.value, sourceAnchors.value.length - 1)
      jumpToAnchor(clamped)
    })
  }
  else {
    pendingModeSync = true
  }
})

function onKeydown(e: KeyboardEvent) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  if (!hasAnchors.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'ArrowUp') goToPrevAnchor()
  else goToNextAnchor()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (typeof ResizeObserver !== 'undefined' && sourceScrollRef.value) {
    sourceRo = new ResizeObserver(() => {
      if (effectiveSourceMode.value) scheduleMeasureSourceAnchors()
    })
    sourceRo.observe(sourceScrollRef.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  sourceRo?.disconnect()
  sourceRo = null
  if (sourceMeasureRaf !== null) {
    cancelAnimationFrame(sourceMeasureRaf)
    sourceMeasureRaf = null
  }
})

interface RowVisual {
  bg: string
  prefix: string
  prefixClass: string
  textClass: string
  lineNo: string
}

/** 源码行视觉(收敛到函数,模板不再重复判断 isPureCharRemoval) */
function rowVisual(line: DiffLine): RowVisual {
  if (line.type === 'removed' || isPureCharRemoval(line)) {
    return {
      bg: 'bg-red-50 dark:bg-red-950/30',
      prefix: '-',
      prefixClass: 'text-red-600 dark:text-red-400',
      textClass: 'text-red-700 dark:text-red-300',
      lineNo: String(line.oldLineNumber || ''),
    }
  }
  if (line.type === 'added') {
    return {
      bg: 'bg-green-50 dark:bg-green-950/30',
      prefix: '+',
      prefixClass: 'text-green-600 dark:text-green-400',
      textClass: 'text-green-700 dark:text-green-300',
      lineNo: String(line.newLineNumber ?? ''),
    }
  }
  return {
    bg: '',
    prefix: ' ',
    prefixClass: 'text-gray-300 dark:text-gray-600',
    textClass: 'text-gray-600 dark:text-gray-300',
    lineNo: String(line.oldLineNumber || ''),
  }
}

/** 异步加载 diff:选中条目变化时触发
 *  - 本地快照:content 和前一版本 content 都在内存中,同步计算
 *  - Git 条目:content 可能需要 git show 懒加载,前一版本 content 也可能需要
 *
 * 竞态守卫(loadSeq):`loadGitContent` / `diffOldContentAsync` 都是异步的,
 * Git 条目的 git show 可能比后选中的本地快照慢得多。快速切换条目时
 * (Git 条目 A → 本地条目 B),A 晚返回会把 B 的结果覆盖掉 —— 表现为
 * 工具栏时间是 B、正文却是 A 的 diff。用自增序号丢弃过期结果:
 * await 回来后不是最新一次请求就直接退出,且不得改动 loading 态。
 */
let loadSeq = 0

async function loadDiff() {
  const seq = ++loadSeq
  // 新一轮请求一律先清掉上一轮的 loading:旧请求可能永远卡在 await(Git 慢),
  // 若新条目走「内容已在内存」的同步快路径就直接 return,残留的 true 会让
  // spinner 一直盖住已经算好的 diff。下面两条异步路径会在同一同步执行段内
  // 重新置 true,Vue 批处理不会产生中间帧,也不影响「过期请求无权清 loading」。
  loading.value = false
  const entry = selected.value
  if (!entry) {
    diffResult.value = []
    newContent.value = ''
    oldContent.value = ''
    wysiwygAnchors.value = []
    activeAnchorIndex.value = -1
    pendingAutoScroll = false
    return
  }

  // 内容已在内存(本地快照 / 已预加载的 Git content):同步计算,不进 loading
  const cachedNew = entry.source === 'git'
    ? (versionHistory.gitContentCache.get(entry.id) ?? entry.content)
    : entry.content
  if (cachedNew !== undefined && cachedNew !== null) {
    const oldRaw = versionHistory.diffOldContentAsyncSync(entry.id)
    if (oldRaw !== null) {
      diffResult.value = diffLines(oldRaw, cachedNew)
      newContent.value = cachedNew
      oldContent.value = oldRaw
      scheduleAutoScroll()
      return
    }
    // 前一版本是 Git 条目且未加载 —— 走异步路径
    loading.value = true
    try {
      const r = await versionHistory.diffOldContentAsync(entry.id)
      if (seq !== loadSeq) return
      diffResult.value = diffLines(r.content ?? '', cachedNew)
      newContent.value = cachedNew
      oldContent.value = r.content ?? ''
      scheduleAutoScroll()
    }
    catch (e) {
      if (seq !== loadSeq) return
      console.error('loadDiff 失败', e)
    }
    finally {
      if (seq === loadSeq) loading.value = false
    }
    return
  }

  // Git content 尚未加载(未预加载到的旧 commit,或刚刷新完还没预加载好)
  loading.value = true
  try {
    let newContentRaw: string
    if (entry.source === 'git') {
      newContentRaw = await versionHistory.loadGitContent(entry)
    } else {
      newContentRaw = entry.content ?? ''
    }

    const oldResult = await versionHistory.diffOldContentAsync(entry.id)
    // 期间用户已切到别的条目 → 本次结果作废(不写 ref、不动 loading)
    if (seq !== loadSeq) return
    const oldContentRaw = oldResult.content ?? ''

    // 行级 diff:源码模式的行列表 + 工具栏 +/- 统计都用它;
    // 预览模式的 block diff 在 WysiwygDiffView 内部另算(不复用这份结果)
    diffResult.value = diffLines(oldContentRaw, newContentRaw)
    newContent.value = newContentRaw
    oldContent.value = oldContentRaw
    scheduleAutoScroll()
  }
  catch (e) {
    if (seq !== loadSeq) return
    console.error('loadDiff 失败', e)
    diffResult.value = []
    newContent.value = ''
    oldContent.value = ''
    wysiwygAnchors.value = []
    activeAnchorIndex.value = -1
    pendingAutoScroll = false
  }
  finally {
    // 过期请求无权清 loading —— 新请求可能正在加载
    if (seq === loadSeq) loading.value = false
  }
}

// 选中条目变化时重新加载 diff
watch(() => versionHistory.selectedEntryId, () => {
  loadDiff()
}, { immediate: true })

// Git content 缓存变化时重新加载(gitContentCache 写入后 displayEntries 重算,
// selectedEntry 可能拿到新对象)。loading 期间跳过,等 loadDiff 完成后
// loading 变 false;若此时 content 已变再触发一次,把新内容渲染上去。
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

/** 回退未保存修改:把编辑器内容恢复到上一版本(已保存内容) */
async function onRevert() {
  const entry = selected.value
  if (!entry) return
  const oldResult = await versionHistory.diffOldContentAsync(entry.id)
  const oldContent = oldResult.content ?? ''
  emit('revert', entry.filePath, oldContent)
  versionHistory.closeDiffView()
}

function onClose() {
  versionHistory.closeDiffView()
}
</script>

<template>
  <!-- 根节点注入 --md-font-size:源码 diff 列表与 WYSIWYG diff(.velo-editor)
       都读这个变量,跟随设置面板的字号 -->
  <div
    class="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--surface-2)]"
    :style="{ '--md-font-size': editorStore.fontSize }"
  >
    <!-- 工具栏 -->
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4 py-2">
      <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span v-if="selected" class="flex items-center gap-1.5">
          <!-- 未保存条目 -->
          <template v-if="isSelectedUnsaved">
            <span class="font-medium text-gray-700 dark:text-gray-200">未保存内容</span>
          </template>
          <!-- Git 条目 -->
          <template v-else-if="isSelectedGit">
            <span class="truncate font-medium text-gray-700 dark:text-gray-200">{{ selected.git?.subject }}</span>
            <span class="shrink-0 font-mono text-[11px] text-orange-600 dark:text-orange-400">{{ selected.git?.shortHash }}</span>
          </template>
          <!-- 本地快照 -->
          <template v-else>
            <span class="font-medium text-gray-700 dark:text-gray-200">{{ formatTime(selected.timestamp) }}</span>
          </template>
        </span>
        <span
          v-if="!loading && (diffStats.added > 0 || diffStats.removed > 0)"
          class="tabular-nums"
        >
          <span class="text-green-600 dark:text-green-400">+{{ diffStats.added }}</span>
          <span class="ml-1.5 text-red-600 dark:text-red-400">-{{ diffStats.removed }}</span>
        </span>
        <span v-else-if="!loading" class="text-gray-400">内容一致</span>
      </div>
      <div class="flex items-center gap-2">
        <!-- hunk 导航(#diff-autoscroll) -->
        <div
          v-if="hasAnchors"
          class="flex items-center gap-0.5 border-r border-[var(--surface-border)] pr-2"
        >
          <button
            class="rounded-md p-1 text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
            title="上一处变更 (Alt+↑)"
            aria-label="上一处变更"
            @click="goToPrevAnchor"
          >
            <ChevronUp class="h-3.5 w-3.5" />
          </button>
          <span
            data-diff-nav-counter
            class="min-w-[2.25rem] text-center text-xs tabular-nums text-gray-500 dark:text-gray-400"
          >{{ activeAnchorIndex >= 0 ? activeAnchorIndex + 1 : 0 }}/{{ activeAnchors.length }}</span>
          <button
            class="rounded-md p-1 text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
            title="下一处变更 (Alt+↓)"
            aria-label="下一处变更"
            @click="goToNextAnchor"
          >
            <ChevronDown class="h-3.5 w-3.5" />
          </button>
        </div>
        <!-- 本地快照:显示「恢复」 -->
        <button
          v-if="!isSelectedUnsaved && !isSelectedGit"
          class="rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          :disabled="!selected"
          @click="onRestore"
        >
          恢复此版本
        </button>
        <!-- 未保存条目:显示「回退修改」 -->
        <button
          v-else-if="isSelectedUnsaved"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          :disabled="!selected"
          @click="onRevert"
        >
          <Undo2 class="h-3.5 w-3.5" />
          回退修改
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

    <!-- diff 内容 + 右侧合一滚动标尺(#diff-ruler) -->
    <div class="flex min-h-0 flex-1">
      <div
        ref="sourceScrollRef"
        class="min-h-0 flex-1 overflow-y-auto"
        :class="{ 'velo-hide-scrollbar': hasAnchors }"
      >
        <!-- loading 态 -->
        <div
          v-if="loading"
          class="flex h-full items-center justify-center"
        >
          <Loader2 class="h-5 w-5 animate-spin text-gray-300 dark:text-gray-600" />
        </div>
        <!-- WYSIWYG diff 模式(sourceMode=false) -->
        <WysiwygDiffView
          v-else-if="!isSourceMode && newContent"
          ref="wysiwygRef"
          :new-content="newContent"
          :old-content="oldContent"
          :hide-scrollbar="hasAnchors"
          @anchors-change="onWysiwygAnchorsChange"
        />
        <!-- 源码 diff 模式(sourceMode=true) -->
        <template v-else>
          <!-- 空结果 -->
          <div
            v-if="diffResult.length === 0"
            class="flex h-full items-center justify-center text-xs text-gray-400"
          >
            <span>无 diff 内容</span>
          </div>
          <!-- diff 结果:字号走 --md-font-size(跟随设置),不再是写死的 text-xs -->
          <div
            v-else
            class="font-mono leading-relaxed"
            style="font-size: var(--md-font-size, 14px)"
          >
            <div
              v-for="(line, idx) in displayRows"
              :key="idx"
              :data-diff-row-idx="idx"
              class="flex border-l-2"
              :class="[
                rowVisual(line).bg,
                isRowInActiveHunk(idx)
                  ? 'border-l-blue-500 dark:border-l-blue-400'
                  : 'border-l-transparent',
              ]"
            >
              <span class="w-10 shrink-0 select-none border-r border-[var(--surface-border)] px-2 text-right text-gray-300 dark:text-gray-600">
                {{ rowVisual(line).lineNo }}
              </span>
              <span
                class="shrink-0 select-none px-2"
                :class="rowVisual(line).prefixClass"
              >
                {{ rowVisual(line).prefix }}
              </span>
              <span
                class="whitespace-pre-wrap px-1"
                :class="rowVisual(line).textClass"
              >
                <!-- 配对修改行优先用 mergedInlineDiff 单行渲染 -->
                <template v-if="line.mergedInlineDiff || line.inlineDiff">
                  <span
                    v-for="(seg, si) in (line.mergedInlineDiff ?? line.inlineDiff)"
                    :key="si"
                    :class="{
                      'bg-green-200/60 dark:bg-green-800/40': seg.type === 'added',
                      'bg-red-200/60 text-red-700/80 dark:bg-red-800/40 dark:text-red-300/80': seg.type === 'removed',
                    }"
                  >{{ seg.text }}</span>
                </template>
                <template v-else>{{ line.text || ' ' }}</template>
              </span>
            </div>
          </div>
        </template>
      </div>

      <!-- 滚动条与变更概览标尺合一(有变更时显示) -->
      <DiffOverviewRuler
        v-if="hasAnchors"
        :anchors="activeAnchors"
        :scroll-element="activeScrollElement"
        @select="jumpToAnchor"
      />
    </div>
  </div>
</template>

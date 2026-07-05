<script setup lang="ts">
// 工作区全文搜索面板(v0.5.2,v0.6.x 改为侧栏内嵌):
//
// 早期版本是 Teleport 到 body 的居中浮层;v0.6.x 迁入可折叠侧栏作为
// 第三个 tab(workspaceStore.sidebarTab === 'search'),与 FileTree /
// EditorOutline 互斥渲染 —— 关闭走 sidebar tab 切换,不再靠"点外部区域
// 关闭"。搜索逻辑在 utils/workspaceSearch.ts,本组件只负责输入 / 进度 /
// 结果分组 / 键盘导航。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { buildPattern, type FindOptions } from '@/components/ProseMirrorEditor/findreplace/findMatches'
import {
  createWorkspaceSearchController,
  initialWorkspaceSearchProgress,
  searchWorkspaceMarkdown,
  type WorkspaceSearchController,
  type WorkspaceSearchGroup,
  type WorkspaceSearchHit,
  type WorkspaceSearchProgress,
} from '@/utils/workspaceSearch'

const props = defineProps<{
  root: string | null
  initialQuery?: string
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  'open-result': [WorkspaceSearchHit]
}>()

const query = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const regex = ref(false)
const groups = ref<WorkspaceSearchGroup[]>([])
const progress = ref<WorkspaceSearchProgress>(initialWorkspaceSearchProgress())
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const selectedFlatIndex = ref(0)
// 鼠标 hover 位置与键盘选中位置独立 —— 上一轮把 hover 合并进 selectedFlatIndex
// 导致 hover 颜色被主色选中态盖掉(用户原意"hover 用菜单色,selected 用主色")。
// 拆成两个 state:selectedFlatIndex 由键盘 ArrowUp/Down + Click 共同控制,
// 主色底 inline style;hoveredFlatIndex 由 mouseenter/mouseleave 控制,
// 菜单色底走 .velo-ws-hovered class。selected 行的 inline style 优先级高于
// class,所以 selected + hover 同条时显示主色(selected 优先,符合"hover 是
// 预览、selected 是确认"的视觉语义)。Click 也改 selectedFlatIndex,因为
// v0.6.x 面板不自动关闭:连续点多个结果时需要保留"最后一次点的是哪条"的视觉
// 锚点,以及让紧随其后的 Enter 仍打开这条。
const hoveredFlatIndex = ref<number | null>(null)

interface HighlightSegment {
  text: string
  match: boolean
}

interface FlatRow {
  group: WorkspaceSearchGroup
  hit: WorkspaceSearchHit
  groupIndex: number
  hitIndex: number
}

const DEBOUNCE_MS = 250
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let activeController: WorkspaceSearchController | null = null
let runId = 0

const options = computed<FindOptions>(() => ({
  caseSensitive: caseSensitive.value,
  wholeWord: wholeWord.value,
  regex: regex.value,
}))

const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  groups.value.forEach((group, groupIndex) => {
    group.hits.forEach((hit, hitIndex) => out.push({ group, hit, groupIndex, hitIndex }))
  })
  return out
})

const isSearching = computed(() => progress.value.phase === 'scanning' || progress.value.phase === 'searching')
const invalidRegex = computed(() => {
  const q = query.value.trim()
  return Boolean(q && regex.value && !buildPattern(q, options.value))
})
const statusText = computed(() => {
  const p = progress.value
  if (!props.root) return '请先打开一个工作区'
  if (!query.value.trim()) return ''
  if (invalidRegex.value) return '正则表达式无效'
  if (p.phase === 'scanning') return `正在扫描工作区… 已发现 ${p.filesFound} 个 .md`
  if (p.phase === 'searching') return `正在搜索 ${p.filesSearched} / ${p.filesFound}… ${p.hits} 个结果`
  if (p.phase === 'canceled') return `已停止，显示当前 ${p.hits} 个结果`
  if (p.phase === 'error') return p.error ?? '搜索失败'
  if (p.phase === 'done') return p.hits ? `${p.hits} 个结果` : '无匹配项'
  return ''
})

function buildSegments(text: string, from: number, to: number): HighlightSegment[] {
  if (from < 0 || to <= from || from >= text.length) return [{ text, match: false }]
  const end = Math.min(to, text.length)
  const out: HighlightSegment[] = []
  if (from > 0) out.push({ text: text.slice(0, from), match: false })
  out.push({ text: text.slice(from, end), match: true })
  if (end < text.length) out.push({ text: text.slice(end), match: false })
  return out.filter(s => s.text.length > 0)
}

function cancelActive(markCanceled: boolean) {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  activeController?.cancel()
  activeController = null
  if (markCanceled && isSearching.value) {
    progress.value = { ...progress.value, phase: 'canceled' }
  }
}

function resetSearchState() {
  cancelActive(false)
  groups.value = []
  progress.value = initialWorkspaceSearchProgress()
  selectedFlatIndex.value = 0
}

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  cancelActive(false)

  const q = query.value.trim()
  if (!props.root || !q || invalidRegex.value) {
    groups.value = []
    progress.value = initialWorkspaceSearchProgress()
    return
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSearch(q)
  }, DEBOUNCE_MS)
}

async function runSearch(q: string) {
  const root = props.root
  if (!root) return
  const controller = createWorkspaceSearchController()
  activeController = controller
  const id = ++runId
  groups.value = []
  progress.value = initialWorkspaceSearchProgress()
  selectedFlatIndex.value = 0

  await searchWorkspaceMarkdown(root, q, options.value, controller, {
    onProgress(p) {
      if (id !== runId) return
      progress.value = p
    },
    onGroups(nextGroups) {
      if (id !== runId) return
      groups.value = nextGroups
      clampSelection()
    },
  })

  if (id === runId && activeController === controller) activeController = null
}

function close() {
  cancelActive(false)
  emit('update:open', false)
}

function stopSearch() {
  cancelActive(true)
}

function clampSelection() {
  const n = flatRows.value.length
  if (!n) {
    selectedFlatIndex.value = 0
    return
  }
  if (selectedFlatIndex.value < 0 || selectedFlatIndex.value >= n) selectedFlatIndex.value = 0
}

watch(flatRows, clampSelection)
watch([query, caseSensitive, wholeWord, regex, () => props.root], scheduleSearch)

// 每次 initialQuery 变化(首次挂载 immediate + 后续 Ctrl+Shift+F 改写)→
// 重置选项 + 应用新 query + 重新搜索 + focus + select 输入框。
//
// 单一 watcher 替代旧的 onMounted 块:v0.6.x 侧栏内嵌后组件没有"open 切换"
// 这一态,挂载时机和 prop 变化的处理路径一致 —— App.vue 在 Ctrl+Shift+F 时
// 改写 workspaceSearchInitialQuery → Sidebar 透传 initialQuery → 这里 watch
// 触发,把新内容写进搜索框并 focus;App.vue 同时设了"不在 search tab 也显示"
// 语义,行为统一。
watch(() => props.initialQuery, async (newQuery) => {
  query.value = newQuery ?? ''
  caseSensitive.value = false
  wholeWord.value = false
  regex.value = false
  resetSearchState()
  if (query.value.trim()) scheduleSearch()
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}, { immediate: true })

onBeforeUnmount(() => {
  cancelActive(false)
})

function moveSelection(delta: number) {
  const n = flatRows.value.length
  if (!n) return
  selectedFlatIndex.value = (selectedFlatIndex.value + delta + n) % n
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-flat-idx="${selectedFlatIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function openSelected() {
  const row = flatRows.value[selectedFlatIndex.value]
  if (!row) return
  emit('open-result', row.hit)
}

function onHitEnter(flatIndex: number) {
  hoveredFlatIndex.value = flatIndex
}

function onHitLeave() {
  hoveredFlatIndex.value = null
}

function onHitClick(flatIndex: number, hit: WorkspaceSearchHit) {
  // Click 同时把 selectedFlatIndex 推到被点击的条目:
  //   1. 用户能看到"我点中了这条"(主色高亮保留);
  //   2. v0.6.x 面板不自动关闭,下次 Enter 仍能打开刚点的条目(连续点多个
  //      结果的迭代体验);
  //   3. selectedFlatIndex 由键盘 ArrowUp/Down + Click 共同控制;hover
  //      仍走独立 hoveredFlatIndex,菜单色 hover 视觉反馈不动。
  selectedFlatIndex.value = flatIndex
  emit('open-result', hit)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); openSelected() }
  else if (e.key === 'Escape') { e.preventDefault(); close() }
}
</script>

<template>
  <!--
    v0.6.x 改为侧栏内嵌:不再 Teleport 到 body 也不再有遮罩背景。
    视觉节奏参考 EditorOutline —— 同样的内边距分配,顶栏与结果列表之间
    用 1px 边线分隔。data-workspace-search-panel 仍挂在根上,App.vue 的
    onKeydown 选择器靠它判断焦点是否在本面板内,避免重复触发全局快捷键。
    顶栏 / 输入框上下间距各 +4px(pt-3 / mb-3)以拉开呼吸感;Aa / W / .*
    三个开关自己成组(gap-0.5),与 input / 停止按钮的间距仍走外层 gap-2。
    关闭按钮去掉 —— 用户走 Esc / 再次点 ActivityBar 搜索图标收起。
    命中行 hover / selected 两套状态独立:selected 由键盘 ArrowUp/Down 与
    Click 共同改 selectedFlatIndex,inline style 主色底;hovered 由 mouseenter/
    leave 改 hoveredFlatIndex,`.velo-ws-hovered` class 走菜单色底。selected
    优先级高于 hover(selected + hover 同条时显示主色,"hover 是预览、
    selected 是确认")。Click 同时把 selectedFlatIndex 推到被点击条目,
    是因为 v0.6.x 面板不自动关闭:用户连续点多个结果时,需要保留"最后一次
    点的是哪条"的视觉锚点,以及让紧随其后的 Enter 仍打开这条。
  -->
  <div
    class="velo-workspace-search flex h-full min-w-0 flex-col overflow-hidden p-2 pt-4 pr-0"
    data-workspace-search-panel
    data-testid="workspace-search-panel"
  >
    <div class="mb-3 shrink-0 pr-2">
      <div class="flex items-center gap-2 rounded-xl border border-gray-200 bg-white mx-2 pl-3 pr-2 py-1 dark:border-gray-700 dark:bg-gray-900">
        <input
          ref="inputRef"
          v-model="query"
          type="text"
          spellcheck="false"
          placeholder="查找"
          data-testid="workspace-search-input"
          class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
          @keydown="onInputKeydown"
        />
        <div class="flex items-center gap-0.5">
          <button
            class="rounded px-1.5 py-0.5 text-[11px] font-semibold text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            :style="caseSensitive ? { color: 'var(--md-primary-color, #1F71D9)' } : undefined"
            title="区分大小写"
            data-testid="workspace-search-case"
            @click="caseSensitive = !caseSensitive"
          >
            Aa
          </button>
          <button
            class="rounded px-1.5 py-0.5 text-[11px] font-semibold text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            :style="wholeWord ? { color: 'var(--md-primary-color, #1F71D9)' } : undefined"
            title="全词匹配"
            data-testid="workspace-search-word"
            @click="wholeWord = !wholeWord"
          >
            W
          </button>
          <button
            class="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            :style="regex ? { color: 'var(--md-primary-color, #1F71D9)' } : undefined"
            title="正则表达式"
            data-testid="workspace-search-regex"
            @click="regex = !regex"
          >
            .*
          </button>
        </div>
        <button
          v-if="isSearching"
          class="rounded px-2 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
          data-testid="workspace-search-stop"
          @click="stopSearch"
        >
          停止
        </button>
      </div>
      <div
        v-if="query.trim() || progress.phase === 'error'"
        class="mt-1 pr-1 text-[11px]"
        :class="progress.phase === 'error' || invalidRegex ? 'text-red-500' : 'text-gray-400'"
        data-testid="workspace-search-status"
      >
        {{ statusText }}
      </div>
    </div>

    <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto pr-2">
      <div v-if="!props.root || invalidRegex || (!groups.length && !isSearching && (query.trim() || invalidRegex))" class="py-8 text-center text-xs text-gray-400">
        {{ statusText }}
      </div>
      <template v-else>
        <template v-for="(group, groupIdx) in groups" :key="group.file.fullPath">
          <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-2 py-1 text-[11px] dark:border-gray-800 dark:bg-[#202020]">
            <span class="min-w-0 truncate font-medium text-gray-600 dark:text-gray-300" :title="group.file.relPath">
              {{ group.file.relPath }}
            </span>
            <span class="shrink-0 text-gray-400">{{ group.hits.length }} 处</span>
          </div>
          <div
            v-for="(hit, hitIdx) in group.hits"
            :key="hit.id"
            :data-flat-idx="flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx)"
            :data-testid="`workspace-search-hit-${groupIdx}-${hitIdx}`"
            class="flex cursor-pointer gap-2 rounded px-2 py-1.5 text-xs"
            :class="hoveredFlatIndex === flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx)
              ? 'velo-ws-hovered'
              : ''"
            :style="selectedFlatIndex === flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx) ? {
              backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
            } : undefined"
            @mouseenter="onHitEnter(flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx))"
            @mouseleave="onHitLeave"
            @click="onHitClick(flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx), hit)"
          >
            <span class="min-w-0 flex-1 truncate font-mono text-gray-700 dark:text-gray-200">
              <template v-for="(seg, segIdx) in buildSegments(hit.lineText, hit.matchStartInLine, hit.matchEndInLine)" :key="segIdx">
                <!--
                  命中段高亮复用 .velo-find-match 样式 —— 与编辑器内 FindReplace
                  Decoration 视觉一致,金底 rgba(255,215,0,.35) 在浅 / 深主题下都
                  可见,不依赖 --md-primary-color(用户自定义主色过浅时会导致原
                  color-mix 22% 透明几乎不可见)。mark 默认有自己的 background,
                  改用 span 避免与 class 叠加冲突。
                -->
                <span
                  v-if="seg.match"
                  class="velo-find-match rounded px-0.5 font-semibold text-gray-900 dark:text-gray-50"
                >{{ seg.text }}</span>
                <span v-else>{{ seg.text }}</span>
              </template>
            </span>
          </div>
        </template>
      </template>
      <div v-if="isSearching && groups.length" class="px-3 py-2 text-center text-[11px] text-gray-400">
        {{ statusText }}
      </div>
      <div v-if="progress.phase === 'canceled' && groups.length" class="px-3 py-2 text-center text-[11px] text-gray-400">
        {{ statusText }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 鼠标 hover 命中行的菜单色底。
 *
 * 用独立 class 而非 Tailwind `hover:bg-*`:Tailwind 的 `:hover` 伪类是声明
 * 在 utility 之前的 CSS 变体,被 selected 行的 inline style backgroundColor
 * 压住看不到;且 Tailwind hover 不能"锁定"鼠标离开后保留视觉。拆成两个
 * state(hoveredFlatIndex + selectedFlatIndex)后,hover 走 class、selected
 * 走 inline style —— 后者优先级最高,所以 selected + hover 同条时显示主色
 * (selected 优先,"hover 是预览、selected 是确认"语义)。
 *
 * 深色模式直接写 `.dark .xxx`(memory [[vue-scoped-global-dark-drops-descendant]]:
 * :global(.dark) 写法会把后代 .xxx 也变成裸选择器,scoped 属性不命中,
 * 暗色覆盖静默失效)。
 */
.velo-ws-hovered {
  background-color: rgb(243 244 246);
}
.dark .velo-ws-hovered {
  background-color: rgb(55 65 81);
}
</style>

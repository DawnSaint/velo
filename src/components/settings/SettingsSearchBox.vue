<script setup lang="ts">
// 设置页搜索框 + 下拉结果列表（设置搜索功能）
//
// 放在 SettingsPage Tab 栏右侧（ml-auto）。输入文字后 debounce 50ms 调
// search(query) 得到 fuzzy 匹配结果，下拉列表展示"设置项 label · 分组标题"。
// 点击 / Enter 选中 → emit select(entry)，由 SettingsPage 切分组 + 滚动 + 高亮。
//
// 键盘导航沿用 QuickCommandPanel 同款线性 ↑/Down 语义：跨结果连续移动，
// 不分组。Esc 清空搜索。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Search, X } from '@lucide/vue'
import { buildCommandPaletteSegments, type HighlightSegment } from '@/utils/commandPalette'
import type { SettingsSearchEntry, SettingsSearchResult } from '@/composables/useSettingsSearchIndex'

const props = defineProps<{
  /** 搜索函数（来自 useSettingsSearchIndex） */
  search: (query: string) => SettingsSearchResult[]
}>()
const emit = defineEmits<{
  /** 选中某条结果：SettingsPage 切分组 + 滚动 + 高亮 */
  select: [entry: SettingsSearchEntry]
}>()

const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const boxRef = ref<HTMLElement | null>(null)
const open = ref(false)
const selectedIndex = ref(0)

const results = ref<SettingsSearchResult[]>([])

interface ResultRow {
  result: SettingsSearchResult
  labelSegments: HighlightSegment[]
}

const rows = computed<ResultRow[]>(() =>
  results.value.map(r => ({
    result: r,
    labelSegments: buildCommandPaletteSegments(r.entry.label, r.labelIndices),
  })),
)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function runSearch() {
  const q = query.value.trim()
  if (!q) {
    results.value = []
    open.value = false
    return
  }
  results.value = props.search(q)
  selectedIndex.value = 0
  open.value = results.value.length > 0
}

watch(query, () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(runSearch, 50)
})

function clampSelection() {
  const n = rows.value.length
  if (n === 0) { selectedIndex.value = 0; return }
  if (selectedIndex.value < 0) selectedIndex.value = 0
  else if (selectedIndex.value >= n) selectedIndex.value = n - 1
}

watch(rows, clampSelection)

function moveSelection(delta: number) {
  const n = rows.value.length
  if (n === 0) return
  selectedIndex.value = (selectedIndex.value + delta + n) % n
  scrollSelectedIntoView()
}

function scrollSelectedIntoView() {
  void nextTick(() => {
    const list = boxRef.value
    if (!list) return
    const el = list.querySelector<HTMLElement>(`[data-idx="${selectedIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function commitSelection() {
  const row = rows.value[selectedIndex.value]
  if (!row) return
  emit('select', row.result.entry)
  // 选中后清空搜索框，关闭下拉
  query.value = ''
  results.value = []
  open.value = false
}

function clearQuery() {
  query.value = ''
  results.value = []
  open.value = false
  inputRef.value?.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSelection(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSelection(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    commitSelection()
  } else if (e.key === 'Escape') {
    // 有 query 时 Esc 清空搜索（并 preventDefault 阻止设置页关闭）；
    // 无 query 时放行，让设置页 window 级 Escape 监听关闭设置页。
    if (query.value) {
      e.preventDefault()
      clearQuery()
    }
  }
}

// 点击外部关闭下拉
function onDocumentPointerDown(e: PointerEvent) {
  if (!boxRef.value) return
  if (boxRef.value.contains(e.target as Node)) return
  open.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <div
    ref="boxRef"
    class="relative ml-auto"
  >
    <div class="relative">
      <Search
        :size="13"
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
      />
      <input
        ref="inputRef"
        data-settings-search-input
        v-model="query"
        type="text"
        placeholder="搜索设置"
        class="w-48 h-8 rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-2)] pl-8 pr-6 text-xs text-gray-900/80 outline-none focus:border-[var(--md-primary-color)] dark:text-gray-100/80"
        @keydown="onKeydown"
        @focus="open = results.length > 0"
      >
      <button
        v-if="query"
        type="button"
        class="absolute right-1.5 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
        title="清空"
        @click="clearQuery"
      >
        <X class="size-3" :stroke-width="2.5" />
      </button>
    </div>

    <!-- 下拉结果列表 -->
    <div
      v-if="open && rows.length > 0"
      class="absolute right-0 top-full z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-[var(--surface-border)] bg-[var(--surface-3)] py-1 shadow-[var(--shadow-popover)]"
    >
      <button
        v-for="(row, idx) in rows"
        :key="row.result.entry.id"
        :data-idx="idx"
        type="button"
        class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors"
        :class="idx === selectedIndex
          ? 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100'
          : 'text-gray-700 hover:bg-[var(--surface-hover)] dark:text-gray-300'"
        @click="selectedIndex = idx; commitSelection()"
        @mouseenter="selectedIndex = idx"
      >
        <span class="min-w-0 flex-1 truncate">
          <template v-for="(seg, i) in row.labelSegments" :key="i">
            <span :class="seg.match ? 'font-semibold text-[var(--md-primary-color)]' : ''">{{ seg.text }}</span>
          </template>
        </span>
        <span class="shrink-0 text-gray-400 dark:text-gray-500">{{ row.result.groupTitle }}</span>
      </button>
    </div>
  </div>
</template>

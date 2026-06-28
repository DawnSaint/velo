<script setup lang="ts">
// Ctrl+Shift+F 工作区全文搜索浮层(v0.5.2)
//
// 只展示命中行:上下文行不渲染,避免结果列表膨胀。搜索逻辑在
// utils/workspaceSearch.ts,组件只负责输入 / 进度 / 结果分组 / 键盘导航。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
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
  open: boolean
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
const panelRef = ref<HTMLElement | null>(null)
const selectedFlatIndex = ref(0)

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
  if (!query.value.trim()) return '输入关键词搜索工作区 .md'
  if (invalidRegex.value) return '正则表达式无效'
  if (p.phase === 'scanning') return `正在扫描工作区… 已发现 ${p.filesFound} 个 .md`
  if (p.phase === 'searching') return `正在搜索 ${p.filesSearched} / ${p.filesFound}… ${p.hits} 个结果`
  if (p.phase === 'canceled') return `已停止，显示当前 ${p.hits} 个结果`
  if (p.phase === 'error') return p.error ?? '搜索失败'
  if (p.phase === 'done') return p.hits ? `${p.hits} 个结果` : '无匹配项'
  return '输入关键词搜索工作区 .md'
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

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  resetSearchState()
  query.value = props.initialQuery ?? ''
  caseSensitive.value = false
  wholeWord.value = false
  regex.value = false
  if (query.value.trim()) scheduleSearch()
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}, { immediate: true })

function moveSelection(delta: number) {
  const n = flatRows.value.length
  if (!n) return
  selectedFlatIndex.value = (selectedFlatIndex.value + delta + n) % n
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-flat-idx="${selectedFlatIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function selectRow(flatIndex: number) {
  selectedFlatIndex.value = flatIndex
}

function openSelected() {
  const row = flatRows.value[selectedFlatIndex.value]
  if (!row) return
  emit('open-result', row.hit)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); openSelected() }
  else if (e.key === 'Escape') { e.preventDefault(); close() }
}

function onGlobalPointerDown(e: PointerEvent) {
  if (!props.open) return
  const target = e.target as Node | null
  if (!target) return
  const panel = panelRef.value
  if (panel && (panel === target || panel.contains(target))) return
  close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
})

onBeforeUnmount(() => {
  cancelActive(false)
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="velo-workspace-search-overlay fixed inset-0 z-[110] flex justify-center bg-black/15 dark:bg-black/40"
      style="pointer-events: auto;"
    >
      <div
        ref="panelRef"
        class="velo-workspace-search-panel mt-[8vh] flex max-h-[65vh] w-[720px] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-[#1a1a1a]"
        data-workspace-search-panel
        data-testid="workspace-search-panel"
      >
        <div class="shrink-0 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <div class="flex items-center gap-2">
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              spellcheck="false"
              placeholder="搜索工作区 .md..."
              data-testid="workspace-search-input"
              class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
              @keydown="onInputKeydown"
            >
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
            <button
              v-if="isSearching"
              class="rounded px-2 py-0.5 text-[11px] text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              data-testid="workspace-search-stop"
              @click="stopSearch"
            >
              停止
            </button>
            <button
              class="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
              title="关闭"
              data-testid="workspace-search-close"
              @click="close"
            >
              <X :size="16" />
            </button>
          </div>
          <div
            v-if="query.trim() || progress.phase === 'error'"
            class="mt-1 text-[11px]"
            :class="progress.phase === 'error' || invalidRegex ? 'text-red-500' : 'text-gray-400'"
            data-testid="workspace-search-status"
          >
            {{ statusText }}
          </div>
        </div>

        <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="!query.trim() || invalidRegex || (!groups.length && !isSearching)" class="px-3 py-6 text-center text-xs text-gray-400">
            {{ statusText }}
          </div>
          <template v-else>
            <template v-for="(group, groupIdx) in groups" :key="group.file.fullPath">
              <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-100 bg-gray-50 px-3 py-1 text-[11px] dark:border-gray-800 dark:bg-[#202020]">
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
                class="flex cursor-pointer gap-3 px-3 py-1.5 text-xs"
                :class="selectedFlatIndex === flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx)
                  ? ''
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800/60'"
                :style="selectedFlatIndex === flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx) ? {
                  backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
                } : undefined"
                @mousemove="selectRow(flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx))"
                @click="emit('open-result', hit)"
              >
                <span class="w-10 shrink-0 text-right tabular-nums text-gray-400">{{ hit.lineNumber }}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-gray-700 dark:text-gray-200">
                  <template v-for="(seg, segIdx) in buildSegments(hit.lineText, hit.matchStartInLine, hit.matchEndInLine)" :key="segIdx">
                    <mark
                      v-if="seg.match"
                      class="rounded-sm px-0.5 font-semibold text-gray-900 dark:text-gray-50"
                      style="background-color: color-mix(in srgb, var(--md-primary-color, #1F71D9) 22%, transparent);"
                    >{{ seg.text }}</mark>
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
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// Ctrl+P 查找文件面板(v0.5.2)
//
// 顶部居中浮层,贴顶 8vh(VSCode 风格)。无工作区静默(由 App.vue:onKeydown 守门)。
//
// 双分区(用户优化):
//   - "最近打开" 段:从 workspaceStore.activeWorkspace.recentFiles 读,头部 = 最新;
//     该段始终保留 recent 顺序,query 激活时只对该段做 fuzzy 过滤(不重排,语义
//     是"最近优先",score 不夺序)。
//   - "其他" 段:扣掉 recent 的剩余 .md;空 query 字典序、有 query 按 fuzzyScore 降序。
//   - 两区都空 → "无匹配项";两区都有 → 各自带 section header。
//
// 行为细节:
//   - selectedIdx 升级为 { section, index } 跨区,Up/Down 在 visibleRows 上线性切;
//   - Esc 关闭;Enter / 单击打开(走 confirmDiscardIfDirty → openPath);
//   - 命中字符段只用 `font-bold` 加粗不写颜色,与大纲搜索一致;
//   - 文件名保留 .md 后缀(用户语义:看到的就是真实文件名);
//   - 截断:每区各自 MAX_PER_SECTION 50(recent 上限本就是 10,实际不会撞).

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { File } from '@lucide/vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'
import { fuzzyScore } from '@/utils/fuzzy'
import { ensureIndex, type QuickOpenEntry } from '@/utils/quickOpenIndex'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

const query = ref('')
const allEntries = ref<QuickOpenEntry[]>([])
const loading = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)

const MAX_PER_SECTION = 50

type SectionKey = 'recent' | 'other'
interface SelectionCursor {
  section: SectionKey
  index: number
}
const selection = ref<SelectionCursor>({ section: 'recent', index: 0 })

interface HighlightSegment {
  text: string
  match: boolean
}
interface VisualRow {
  entry: QuickOpenEntry
  /** 展示名 = 文件原名(含 .md 后缀,用户要求) */
  displayName: string
  /** 父目录的相对路径(可空,根级文件返回 '') */
  dirPath: string
  /** 命中索引切段(空 query 时整段非匹配) */
  nameSegments: HighlightSegment[]
}

/** displayName 按命中索引切成段(同 outlineFilter:buildSegments 的拆段法)。 */
function buildSegments(name: string, indices: number[] | undefined): HighlightSegment[] {
  if (!indices || indices.length === 0) return [{ text: name, match: false }]
  const set = new Set(indices)
  const out: HighlightSegment[] = []
  let buf = ''
  let bufMatch = false
  for (let i = 0; i < name.length; i++) {
    const m = set.has(i)
    if (buf.length === 0) { buf = name[i]; bufMatch = m }
    else if (m === bufMatch) buf += name[i]
    else { out.push({ text: buf, match: bufMatch }); buf = name[i]; bufMatch = m }
  }
  if (buf) out.push({ text: buf, match: bufMatch })
  return out
}

/** 把 "docs/ARCHITECTURE.md" 拆成 { name, dir },根级文件 dir 为空。 */
function splitRel(rel: string): { name: string, dir: string } {
  const i = rel.lastIndexOf('/')
  if (i === -1) return { name: rel, dir: '' }
  return { name: rel.slice(i + 1), dir: rel.slice(0, i + 1) }
}

function makeRow(entry: QuickOpenEntry, indices?: number[]): VisualRow {
  const { dir } = splitRel(entry.relPath)
  const displayName = entry.name
  return {
    entry,
    displayName,
    dirPath: dir,
    nameSegments: buildSegments(displayName, indices),
  }
}

// 按 fullPath 索引 allEntries —— recent 列表存的是 fullPath,逐项查回 entry,
// O(n) 单次构建即可。allEntries 不大(几百 .md 内),Map 即可。
const entriesByPath = computed<Map<string, QuickOpenEntry>>(() => {
  const m = new Map<string, QuickOpenEntry>()
  for (const e of allEntries.value) m.set(e.fullPath, e)
  return m
})

const recentRows = computed<VisualRow[]>(() => {
  const recent = workspace.activeWorkspace.recentFiles ?? []
  if (recent.length === 0) return []
  const q = query.value.trim()
  const out: VisualRow[] = []
  for (const path of recent) {
    const entry = entriesByPath.value.get(path)
    if (!entry) continue // 文件已不在工作区(被删 / 移走外部),静默跳过
    if (!q) {
      out.push(makeRow(entry))
    }
    else {
      const hit = fuzzyScore(entry.name, q)
      if (!hit) continue
      out.push(makeRow(entry, hit.indices))
    }
    if (out.length >= MAX_PER_SECTION) break
  }
  return out
})

const otherRows = computed<VisualRow[]>(() => {
  const recent = new Set(workspace.activeWorkspace.recentFiles ?? [])
  const q = query.value.trim()
  if (!q) {
    const out: VisualRow[] = []
    for (const e of allEntries.value) {
      if (recent.has(e.fullPath)) continue
      out.push(makeRow(e))
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
    return out.slice(0, MAX_PER_SECTION)
  }
  // 有 query:fuzzy 过滤 + score 降序
  type Scored = { row: VisualRow, score: number }
  const scored: Scored[] = []
  for (const e of allEntries.value) {
    if (recent.has(e.fullPath)) continue
    const hit = fuzzyScore(e.name, q)
    if (!hit) continue
    scored.push({ row: makeRow(e, hit.indices), score: hit.score })
  }
  scored.sort((a, b) => b.score - a.score || a.row.displayName.localeCompare(b.row.displayName, 'zh-Hans-CN'))
  return scored.slice(0, MAX_PER_SECTION).map(s => s.row)
})

/** 拍平的"可选行"列表 + 每行所属 section,用于 Up/Down 跨区切换. */
interface FlatRow {
  row: VisualRow
  section: SectionKey
  /** 在所在 section 内部的下标,渲染时回填到 data-* 用. */
  index: number
}
const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  recentRows.value.forEach((row, i) => out.push({ row, section: 'recent', index: i }))
  otherRows.value.forEach((row, i) => out.push({ row, section: 'other', index: i }))
  return out
})

const totalRows = computed(() => flatRows.value.length)
const isEmpty = computed(() => totalRows.value === 0)

/** 找选中行在 flatRows 中的位置;找不到回退 0。 */
const selectedFlatIndex = computed(() => {
  const idx = flatRows.value.findIndex(r => r.section === selection.value.section && r.index === selection.value.index)
  return idx === -1 ? 0 : idx
})

// 选中索引随 rows 变化做 clamp:始终落在第一行,避免悬空。
watch(flatRows, () => {
  if (totalRows.value === 0) {
    selection.value = { section: 'recent', index: 0 }
    return
  }
  // 现选中已不存在 → 跳第一行(优先 recent)
  const exists = flatRows.value.some(r =>
    r.section === selection.value.section && r.index === selection.value.index,
  )
  if (!exists) {
    const first = flatRows.value[0]
    selection.value = { section: first.section, index: first.index }
  }
})

watch(query, () => {
  // query 变 → 选中跳到第一个有效行(第一段优先)
  const first = flatRows.value[0]
  if (first) selection.value = { section: first.section, index: first.index }
  else selection.value = { section: 'recent', index: 0 }
})

async function refreshIndex() {
  const root = workspace.activeRoot
  if (!root) return
  loading.value = true
  try {
    allEntries.value = await ensureIndex(root)
  }
  catch (e) {
    console.warn('Ctrl+P 索引构建失败', e)
    allEntries.value = []
  }
  finally {
    loading.value = false
  }
}

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  query.value = ''
  selection.value = { section: 'recent', index: 0 }
  await refreshIndex()
  await nextTick()
  inputRef.value?.focus()
}, { immediate: true })

function close() {
  emit('update:open', false)
}

async function openRow(row: VisualRow) {
  const ok = await documentStore.openPathInTab(row.entry.fullPath)
  if (!ok) return
  workspace.setLastFile(row.entry.fullPath)
  close()
}

function moveSelection(delta: number) {
  const n = totalRows.value
  if (!n) return
  const next = (selectedFlatIndex.value + delta + n) % n
  const r = flatRows.value[next]
  selection.value = { section: r.section, index: r.index }
  // 滚到可视区
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-flat-idx="${next}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function selectRow(section: SectionKey, index: number) {
  selection.value = { section, index }
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const r = flatRows.value[selectedFlatIndex.value]
    if (r) void openRow(r.row)
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
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
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="velo-quickopen-overlay fixed inset-0 z-[100] flex justify-center bg-black/15 dark:bg-black/40"
      style="pointer-events: auto;"
    >
      <div
        ref="panelRef"
        class="velo-quickopen-panel mt-[8vh] flex max-h-[60vh] w-[520px] max-w-[90vw] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-[#1a1a1a]"
        data-testid="quick-open-panel"
      >
        <!-- 输入框 -->
        <div class="relative shrink-0 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="按文件名模糊查找..."
            data-testid="quick-open-input"
            class="w-full bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
            @keydown="onInputKeydown"
          >
        </div>

        <!-- 结果列表 -->
        <div
          ref="listRef"
          class="min-h-0 flex-1 overflow-y-auto py-1"
        >
          <div v-if="loading && !totalRows" class="px-3 py-4 text-center text-xs text-gray-400">
            正在扫描工作区...
          </div>
          <div v-else-if="isEmpty" class="px-3 py-4 text-center text-xs text-gray-400">
            {{ allEntries.length === 0 ? '工作区内没有 .md 文件' : '无匹配项' }}
          </div>
          <template v-else>
            <!-- 最近打开段 -->
            <template v-if="recentRows.length">
              <div class="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                最近打开
              </div>
              <div
                v-for="(row, idx) in recentRows"
                :key="`recent-${row.entry.fullPath}`"
                :data-flat-idx="idx"
                :data-testid="`quick-open-recent-${idx}`"
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
                :class="selection.section === 'recent' && selection.index === idx
                  ? ''
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800/60'"
                :style="selection.section === 'recent' && selection.index === idx ? {
                  backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
                } : undefined"
                @click="openRow(row)"
                @mousemove="selectRow('recent', idx)"
              >
                <File class="size-3.5 shrink-0 text-gray-400" />
                <span class="truncate text-gray-800 dark:text-gray-200">
                  <template v-for="(seg, i) in row.nameSegments" :key="i">
                    <span v-if="seg.match" class="font-bold">{{ seg.text }}</span>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span v-if="row.dirPath" class="ml-auto shrink-0 truncate pl-3 text-[10px] text-gray-400">
                  {{ row.dirPath }}
                </span>
              </div>
            </template>

            <!-- 其他段 -->
            <template v-if="otherRows.length">
              <div class="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                其他
              </div>
              <div
                v-for="(row, idx) in otherRows"
                :key="`other-${row.entry.fullPath}`"
                :data-flat-idx="recentRows.length + idx"
                :data-testid="`quick-open-other-${idx}`"
                class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs"
                :class="selection.section === 'other' && selection.index === idx
                  ? ''
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800/60'"
                :style="selection.section === 'other' && selection.index === idx ? {
                  backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
                } : undefined"
                @click="openRow(row)"
                @mousemove="selectRow('other', idx)"
              >
                <File class="size-3.5 shrink-0 text-gray-400" />
                <span class="truncate text-gray-800 dark:text-gray-200">
                  <template v-for="(seg, i) in row.nameSegments" :key="i">
                    <span v-if="seg.match" class="font-bold">{{ seg.text }}</span>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span v-if="row.dirPath" class="ml-auto shrink-0 truncate pl-3 text-[10px] text-gray-400">
                  {{ row.dirPath }}
                </span>
              </div>
            </template>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
input:focus {
  border-color: var(--md-primary-color, #1F71D9);
}
</style>

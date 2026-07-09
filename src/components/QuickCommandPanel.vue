<script setup lang="ts">
// 统一命令面板(v0.6.2):合并原 Ctrl+P 查找文件 + Ctrl+Shift+P 命令面板。
//
// 顶部居中浮层,贴顶 8vh(VSCode 风格)。一个输入框,首字符决定模式:
//   ''  → file      工作区 .md 模糊查找(原 QuickOpenPanel 双分区:最近打开 / 其他)
//   '>' → command   App shell 命令聚合(原 CommandPalettePanel:命令 / 工作区 / 最近文件)
//
// 模式由 parseQuickCommand(raw) 解析;前缀字符保留在 raw query 里(与旧
// CommandPalettePanel 的 '>' 行为一致),剥成 { mode, text } 后 text 喂给各
// 模式自己的过滤函数。输入框前不挂模式徽标 —— 命令模式的 '>' 本就在输入框里,
// 文件模式无前缀,模式靠首字符自然区分。
//
// 两套行视图统一成 UnifiedRow + UnifiedSection,共用一套 flatRows / selection /
// ArrowUp/Down/Enter/Esc 键盘导航(沿用两个旧面板的跨段线性切换)。
// file 行:文件名命中加粗 + 灰色相对路径右对齐副标(原 QuickOpenPanel 视觉)。
// command 行:图标盒 + 标题命中加粗 + 副标 + 快捷键(原 CommandPalettePanel 视觉)。

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import {
  AppWindowMac, AtSign, Code2, Download, File, FilePlusCorner, FileSearch, FileUp,
  FolderOpen, Folders, FolderX, History, List, ListOrdered, Replace, Save, Search, Settings, Terminal, Upload,
} from '@lucide/vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'
import { fuzzyScore } from '@/utils/fuzzy'
import { ensureIndex, type QuickOpenEntry } from '@/utils/quickOpenIndex'
import {
  buildCommandPaletteSections,
  buildCommandPaletteSegments,
  type CommandPaletteIcon,
  type CommandPaletteItem,
  type CommandPaletteRow,
  type CommandPaletteSection,
  type HighlightSegment,
} from '@/utils/commandPalette'
import { parseQuickCommand } from '@/utils/quickCommand'
import { parseHeadings, type HeadingItem } from '@/utils/outline'
import { getLineText, getLineCount } from '@/utils/revealHeading'
import { join } from '@/tauri/path'
import { exists, writeTextFile } from '@/tauri/fs'
import { finalName, validateName } from '@/components/Sidebar/treeUtils'

const props = defineProps<{
  open: boolean
  items: readonly CommandPaletteItem[]
  /** 打开时预填的 raw query(含前缀);Ctrl+Shift+P 传 '>',Ctrl+P 传 '' */
  initialQuery?: string
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  'reveal-heading': [{ level: number, displayText: string }]
  // : 行号模式生命周期:进入 → 切源码;实时预览 N;Enter 确认(留源码);Esc/离开/关闭 → 取消(恢复)
  'line-enter': []
  'line-preview': [number | null]
  'line-confirm': []
  'line-cancel': []
}>()

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

const query = ref('')
const parsed = computed(() => parseQuickCommand(query.value))
const mode = computed(() => parsed.value.mode)
const search = computed(() => parsed.value.text)

const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)

const MAX_PER_SECTION = 50

// ========== file 模式:工作区 .md 索引 ==========
const allEntries = ref<QuickOpenEntry[]>([])
const loading = ref(false)

async function refreshIndex() {
  const root = workspace.activeRoot
  if (!root) { allEntries.value = []; return }
  loading.value = true
  try {
    allEntries.value = await ensureIndex(root)
  }
  catch (e) {
    console.warn('[QuickCommand] 索引构建失败', e)
    allEntries.value = []
  }
  finally {
    loading.value = false
  }
}

function splitRel(rel: string): { name: string, dir: string } {
  const i = rel.lastIndexOf('/')
  if (i === -1) return { name: rel, dir: '' }
  return { name: rel.slice(i + 1), dir: rel.slice(0, i + 1) }
}

interface FileRow {
  entry: QuickOpenEntry
  nameSegments: HighlightSegment[]
  dirPath: string
}

function makeFileRow(entry: QuickOpenEntry, indices?: number[]): FileRow {
  const { dir } = splitRel(entry.relPath)
  return {
    entry,
    nameSegments: buildCommandPaletteSegments(entry.name, indices),
    dirPath: dir,
  }
}

const entriesByPath = computed<Map<string, QuickOpenEntry>>(() => {
  const m = new Map<string, QuickOpenEntry>()
  for (const e of allEntries.value) m.set(e.fullPath, e)
  return m
})

const recentFileRows = computed<FileRow[]>(() => {
  const recent = workspace.activeWorkspace.recentFiles ?? []
  if (recent.length === 0) return []
  const q = search.value.trim()
  const out: FileRow[] = []
  for (const path of recent) {
    const entry = entriesByPath.value.get(path)
    if (!entry) continue
    if (!q) out.push(makeFileRow(entry))
    else {
      const hit = fuzzyScore(entry.name, q)
      if (!hit) continue
      out.push(makeFileRow(entry, hit.indices))
    }
    if (out.length >= MAX_PER_SECTION) break
  }
  return out
})

const otherFileRows = computed<FileRow[]>(() => {
  const recent = new Set(workspace.activeWorkspace.recentFiles ?? [])
  const q = search.value.trim()
  if (!q) {
    const out: FileRow[] = []
    for (const e of allEntries.value) {
      if (recent.has(e.fullPath)) continue
      out.push(makeFileRow(e))
    }
    out.sort((a, b) => a.entry.name.localeCompare(b.entry.name, 'zh-Hans-CN'))
    return out.slice(0, MAX_PER_SECTION)
  }
  type Scored = { row: FileRow, score: number }
  const scored: Scored[] = []
  for (const e of allEntries.value) {
    if (recent.has(e.fullPath)) continue
    const hit = fuzzyScore(e.name, q)
    if (!hit) continue
    scored.push({ row: makeFileRow(e, hit.indices), score: hit.score })
  }
  scored.sort((a, b) => b.score - a.score || a.row.entry.name.localeCompare(b.row.entry.name, 'zh-Hans-CN'))
  return scored.slice(0, MAX_PER_SECTION).map(s => s.row)
})

// ========== command 模式:图标映射(原 CommandPalettePanel) ==========
const iconComponents: Record<CommandPaletteIcon, Component> = {
  'new-doc': FilePlusCorner,
  'new-window': AppWindowMac,
  'open-file': FileUp,
  'open-folder': FolderOpen,
  save: Save,
  'save-as': Upload,
  export: Download,
  find: Search,
  replace: Replace,
  source: Code2,
  'file-actions': File,
  settings: Settings,
  'quick-open': FileSearch,
  'workspace-search': Search,
  'workspace-files': Folders,
  outline: List,
  'workspace-close': FolderX,
  'workspace-switch': FolderOpen,
  'recent-file': History,
}

function iconFor(row: CommandPaletteRow, section: CommandPaletteSection): CommandPaletteIcon {
  if (row.item.icon) return row.item.icon
  if (row.item.id.startsWith('workspace.switch:')) return 'workspace-switch'
  if (row.item.id.startsWith('recent:')) return 'recent-file'

  const byId: Record<string, CommandPaletteIcon> = {
    'file.new': 'new-doc',
    'window.new': 'new-window',
    'file.open': 'open-file',
    'file.save': 'save',
    'file.saveAs': 'save-as',
    'file.export': 'export',
    'edit.find': 'find',
    'edit.replace': 'replace',
    'editor.toggleSource': 'source',
    'settings.open': 'settings',
    'workspace.openFolder': 'open-folder',
    'workspace.quickOpen': 'quick-open',
    'workspace.search': 'workspace-search',
    'workspace.files': 'workspace-files',
    'workspace.outline': 'outline',
    'workspace.close': 'workspace-close',
  }
  const icon = byId[row.item.id]
  if (icon) return icon
  if (section.key === 'recent') return 'recent-file'
  if (section.key === 'workspace') return 'workspace-files'
  return 'file-actions'
}

// ========== @ symbol 模式:当前文档标题 ==========
const headingsTree = computed<HeadingItem[]>(() => parseHeadings(documentStore.content))

interface SymbolRow {
  key: string
  level: number
  displayText: string
  segments: HighlightSegment[]
}
const symbolRows = computed<SymbolRow[]>(() => {
  const q = search.value.trim()
  const out: SymbolRow[] = []
  function walk(items: HeadingItem[]) {
    for (const it of items) {
      if (!q) {
        out.push({ key: it.key, level: it.level, displayText: it.displayText, segments: buildCommandPaletteSegments(it.displayText, undefined) })
      }
      else {
        const hit = fuzzyScore(it.displayText, q)
        if (hit) out.push({ key: it.key, level: it.level, displayText: it.displayText, segments: buildCommandPaletteSegments(it.displayText, hit.indices) })
      }
      walk(it.children)
    }
  }
  walk(headingsTree.value)
  return out
})

// ========== 统一行视图 ==========
interface UnifiedRow {
  key: string
  primarySegments: HighlightSegment[]
  subtitle?: string
  icon?: Component
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  /** symbol 模式标题层级(1-6),用于行缩进 */
  level?: number
  /** 前缀介绍行(@/:/>):不抢默认选中,resetSelectionToFirst 跳过 */
  isHelp?: boolean
  run: () => void | Promise<void>
}
interface UnifiedSection {
  key: string
  label: string
  rows: UnifiedRow[]
}

const sections = computed<UnifiedSection[]>(() => {
  if (mode.value === 'command') {
    const cmdSections = buildCommandPaletteSections(props.items, search.value)
    return cmdSections.map(s => ({
      key: s.key,
      label: s.label,
      rows: s.rows.map(r => ({
        key: r.item.id,
        primarySegments: r.titleSegments,
        subtitle: r.item.subtitle,
        icon: iconComponents[iconFor(r, s)],
        shortcut: r.item.shortcut,
        disabled: r.item.disabled,
        disabledReason: r.item.disabledReason,
        run: () => runCommand(r),
      })),
    }))
  }
  if (mode.value === 'symbol') {
    return [{
      key: 'symbols',
      label: '',
      rows: symbolRows.value.map(r => ({
        key: r.key,
        primarySegments: r.segments,
        level: r.level,
        run: () => activateHeading(r),
      })),
    }]
  }
  if (mode.value === 'line') {
    // : 行号模式不走行视图:实时滚动 + 行高亮由 App.vue 直接驱动,面板只保留输入框
    return []
  }
  const out: UnifiedSection[] = []
  // 顶部前缀介绍行(@/:/>,VSCode ? help 风格):仅空 query + 有文件时显示,
  // 选中即自动填入对应前缀切模式。isHelp 标记让 resetSelectionToFirst 跳过,不抢文件行的默认选中。
  if (!search.value.trim() && allEntries.value.length > 0) {
    out.push({ key: 'help', label: '', rows: buildHelpRows() })
  }
  // 「没找到 → 新建」行(Obsidian / Sublime 风格):无任何模糊命中时插到列表顶部,
  // Enter 即建盘 + 打开。resetSelectionToFirst 会把选中重置到首行 = 新建行。
  const createRow = buildCreateRow()
  if (createRow) {
    out.push({ key: 'create', label: '', rows: [createRow] })
  }
  if (recentFileRows.value.length) {
    out.push({
      key: 'recent',
      label: '最近打开',
      rows: recentFileRows.value.map(r => ({
        key: r.entry.fullPath,
        primarySegments: r.nameSegments,
        subtitle: r.dirPath,
        icon: File,
        run: () => openFileRow(r.entry),
      })),
    })
  }
  if (otherFileRows.value.length) {
    out.push({
      key: 'other',
      label: '其他',
      rows: otherFileRows.value.map(r => ({
        key: r.entry.fullPath,
        primarySegments: r.nameSegments,
        subtitle: r.dirPath,
        icon: File,
        run: () => openFileRow(r.entry),
      })),
    })
  }
  return out
})

interface FlatRow {
  row: UnifiedRow
  sectionIndex: number
  rowIndex: number
}
const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  sections.value.forEach((section, sectionIndex) => {
    section.rows.forEach((row, rowIndex) => out.push({ row, sectionIndex, rowIndex }))
  })
  return out
})
const totalRows = computed(() => flatRows.value.length)
const isEmpty = computed(() => totalRows.value === 0)

const emptyMessage = computed(() => {
  if (mode.value === 'command') return '无匹配命令'
  if (mode.value === 'symbol') {
    return headingsTree.value.length === 0 ? '当前文档没有标题' : '无匹配项'
  }
  if (loading.value) return '正在扫描工作区...'
  return allEntries.value.length === 0 ? '工作区内没有 .md 文件' : '无匹配项'
})

// : 行号模式输入框右侧 hint(VSCode 风格,显示当前文档总行数)
const lineHint = computed(() => `输入要跳转的行号(从 1 到 ${getLineCount(documentStore.content)})`)

interface SelectionCursor {
  section: number
  index: number
}
const selection = ref<SelectionCursor>({ section: 0, index: 0 })

const selectedFlatIndex = computed(() => {
  const idx = flatRows.value.findIndex(r => r.sectionIndex === selection.value.section && r.rowIndex === selection.value.index)
  return idx === -1 ? 0 : idx
})

function resetSelectionToFirst() {
  // 跳过 isHelp 行:前缀介绍行在顶部但不抢默认选中 —— Enter 仍打开第一个文件, ArrowUp 才到介绍行
  const first = flatRows.value.find(r => !r.row.isHelp) ?? flatRows.value[0]
  selection.value = first
    ? { section: first.sectionIndex, index: first.rowIndex }
    : { section: 0, index: 0 }
}

watch(flatRows, () => {
  if (!totalRows.value) {
    selection.value = { section: 0, index: 0 }
    return
  }
  const cur = flatRows.value.find(r => r.sectionIndex === selection.value.section && r.rowIndex === selection.value.index)
  // 选中行消失,或停在 isHelp 介绍行上(异步索引加载后 {0,0} 可能命中介绍行)→ 重置到第一个非介绍行
  if (!cur || cur.row.isHelp) resetSelectionToFirst()
})

// 文本 / 模式变化 → 选中跳到第一行(模式切换时即便 text 相同也要重置,因为两套 sections 不同)
watch([mode, search], resetSelectionToFirst)

watch(() => props.open, async (isOpen) => {
  if (!isOpen) {
    // 关闭时仍处 : 行号模式 → 视为取消(Enter/Esc 已先 emit 过的话,App.vue 端 lineSession 已清,no-op)
    if (mode.value === 'line') emit('line-cancel')
    return
  }
  query.value = props.initialQuery ?? ''
  // 以 ':' 打开时 mode watcher 尚未注册(或 mode 未变化),补发 line-enter;
  // 运行时敲 ':' 由 mode watcher 发(两路径在 App.vue 端 lineSession 守卫去重)
  if (mode.value === 'line') emit('line-enter')
  resetSelectionToFirst()
  if (mode.value === 'file') void refreshIndex()
  await nextTick()
  inputRef.value?.focus()
  const len = query.value.length
  inputRef.value?.setSelectionRange(len, len)
}, { immediate: true })

// 模式切换:file 补索引;: 行号生命周期(进入 → line-enter,离开 → line-cancel)
watch(mode, (m, prev) => {
  if (m === 'file' && props.open) void refreshIndex()
  if (m === 'line' && prev !== 'line' && props.open) emit('line-enter')
  else if (m !== 'line' && prev === 'line' && props.open) emit('line-cancel')
})

// : 行号模式实时预览:解析行号,有效 + 存在 → emit N(滚动 + 高亮);否则 emit null(清高亮)
watch(search, (s) => {
  if (mode.value !== 'line' || !props.open) return
  const n = parseInt(s.trim(), 10)
  if (Number.isFinite(n) && n >= 1 && getLineText(documentStore.content, n).exists) {
    emit('line-preview', n)
  } else {
    emit('line-preview', null)
  }
})

// : 行号模式切源码时,CM6 挂载会抢焦(SourceModeEditor.onMounted view.focus());
// 切换后把焦点拉回输入框 —— nextTick 跑在挂载之后,赢过抢焦。
watch(() => documentStore.sourceMode, () => {
  if (mode.value === 'line' && props.open) {
    nextTick(() => inputRef.value?.focus())
  }
})

function close() {
  emit('update:open', false)
}

function activateHeading(h: { level: number, displayText: string }) {
  emit('reveal-heading', { level: h.level, displayText: h.displayText })
  close()
}

async function runCommand(row: CommandPaletteRow) {
  if (row.item.disabled) return
  close()
  try {
    await row.item.run()
  }
  catch (e) {
    console.error('[QuickCommand] 命令执行失败', e)
  }
}

async function openFileRow(entry: QuickOpenEntry) {
  const ok = await documentStore.openPathInTab(entry.fullPath)
  if (!ok) return
  workspace.setLastFile(entry.fullPath)
  close()
}

/**
 * file 模式顶部前缀介绍行(VSCode `?` help 风格):介绍 @ / : / > 三种前缀的用途 + 快捷键,
 * 选中即把对应前缀填入输入框并切模式(`parseQuickCommand` 自然分发)。isHelp 标记使其不抢默认选中。
 */
function buildHelpRows(): UnifiedRow[] {
  // 图标(Terminal/AtSign/ListOrdered)即前缀视觉,文本不再重复写 > / @ / : 字符
  return [
    {
      key: 'help-command',
      primarySegments: [{ text: '命令模式', match: false }],
      subtitle: '运行命令 · Ctrl+Shift+P',
      icon: Terminal,
      isHelp: true,
      run: () => switchToPrefix('>'),
    },
    {
      key: 'help-symbol',
      primarySegments: [{ text: '标题跳转', match: false }],
      subtitle: '跳转到当前文档标题',
      icon: AtSign,
      isHelp: true,
      run: () => switchToPrefix('@'),
    },
    {
      key: 'help-line',
      primarySegments: [{ text: '行号跳转', match: false }],
      subtitle: '跳转到行号',
      icon: ListOrdered,
      isHelp: true,
      run: () => switchToPrefix(':'),
    },
  ]
}

function switchToPrefix(prefix: string) {
  query.value = prefix
  nextTick(() => {
    inputRef.value?.focus()
    const len = query.value.length
    inputRef.value?.setSelectionRange(len, len)
  })
}

/**
 * file 模式「没找到 → 新建」行:query 非空、无任何模糊命中、有 activeRoot 且名称合法时,
 * 返回「新建文件: <name>.md」行。Enter 走 createAndOpen。
 *
 * 不复用 file.new 命令 —— 它只开未命名临时 tab,不写盘也不接受文件名;此处的建盘半段
 * 复用 FileTree 的 writeTextFile(''),打开半段与 openFileRow 完全一致(openPathInTab + setLastFile)。
 */
function buildCreateRow(): UnifiedRow | null {
  const q = search.value.trim()
  if (!q) return null
  // 有命中(最近 / 其他)时不显示——只做"没找到"兜底,避免与模糊结果抢默认选中
  if (recentFileRows.value.length || otherFileRows.value.length) return null
  const root = workspace.activeRoot
  if (!root) return null
  // 用户可能已敲 .md(如 "foo.md"),剥掉再由 finalName 统一补,避免 "foo.md.md"
  const stem = q.replace(/\.md$/i, '')
  if (!stem) return null
  const fullName = finalName(stem, { kind: 'newFile' })
  if (validateName(fullName, null, null)) return null
  return {
    key: 'create',
    primarySegments: [
      { text: '新建文件: ', match: false },
      { text: fullName, match: true },
    ],
    icon: FilePlusCorner,
    run: () => createAndOpen(q),
  }
}

async function createAndOpen(rawName: string) {
  const root = workspace.activeRoot
  if (!root) return
  const name = rawName.trim()
  if (!name) return
  const stem = name.replace(/\.md$/i, '')
  if (!stem) return
  const fullName = finalName(stem, { kind: 'newFile' })
  if (validateName(fullName, null, null)) return
  try {
    const targetPath = await join(root, fullName)
    // exists 守门:已存在(大小写不敏感 FS / 竞态)直接打开,绝不覆写丢数据
    if (!(await exists(targetPath))) await writeTextFile(targetPath, '')
    const ok = await documentStore.openPathInTab(targetPath)
    if (!ok) return
    workspace.setLastFile(targetPath)
    close()
  }
  catch (e) {
    console.warn('[QuickCommand] 新建文件失败', e)
  }
}

function activateSelected() {
  const r = flatRows.value[selectedFlatIndex.value]
  if (r) void r.row.run()
}

function moveSelection(delta: number) {
  const n = totalRows.value
  if (!n) return
  const next = (selectedFlatIndex.value + delta + n) % n
  const r = flatRows.value[next]
  selection.value = { section: r.sectionIndex, index: r.rowIndex }
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-flat-idx="${next}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function selectRow(section: number, index: number) {
  selection.value = { section, index }
}

function onInputKeydown(e: KeyboardEvent) {
  if (mode.value === 'line') {
    // : 行号模式:Enter 确认(留源码 + 当前行)、Esc 取消(恢复);无行可选,Arrow 键不响应
    if (e.key === 'Enter') { e.preventDefault(); emit('line-confirm'); close() }
    else if (e.key === 'Escape') { e.preventDefault(); emit('line-cancel'); close() }
    return
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') {
    e.preventDefault()
    activateSelected()
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

function onGlobalKeydown(e: KeyboardEvent) {
  if (!props.open || e.key !== 'Escape') return
  e.preventDefault()
  close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  window.addEventListener('keydown', onGlobalKeydown, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
  window.removeEventListener('keydown', onGlobalKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[120] flex justify-center"
      style="pointer-events: auto;"
    >
      <div
        ref="panelRef"
        class="mt-[4vh] flex max-h-[62vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-[#1a1a1a]"
        :class="mode === 'line' ? 'self-start' : ''"
        data-quick-command-panel
        data-testid="quick-command-panel"
      >
        <div class="shrink-0 px-3 py-2" :class="mode === 'line' ? '' : 'border-b border-gray-200 dark:border-gray-800'">
          <div class="flex items-center gap-2">
            <input
              ref="inputRef"
              v-model="query"
              type="text"
              spellcheck="false"
              :placeholder="mode === 'command' ? '输入命令...' : '按文件名模糊查找...'"
              data-testid="quick-command-input"
              class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
              @keydown="onInputKeydown"
            >
            <span v-if="mode === 'line'" data-testid="quick-command-line-hint" class="shrink-0 whitespace-nowrap text-[10px] text-gray-400">
              {{ lineHint }}
            </span>
          </div>
        </div>

        <div
          v-if="mode !== 'line'"
          ref="listRef"
          class="min-h-0 flex-1 overflow-y-auto py-1"
        >
          <div v-if="isEmpty" class="px-3 py-4 text-center text-xs text-gray-400">
            {{ emptyMessage }}
          </div>
          <template v-else>
            <template v-for="(section, sectionIdx) in sections" :key="section.key">
              <div v-if="section.label" class="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {{ section.label }}
              </div>
              <button
                v-for="(row, rowIdx) in section.rows"
                :key="row.key"
                type="button"
                :data-flat-idx="flatRows.findIndex(r => r.sectionIndex === sectionIdx && r.rowIndex === rowIdx)"
                :data-testid="`quick-command-row-${row.key}`"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors"
                :class="[
                  row.disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
                  selection.section === sectionIdx && selection.index === rowIdx
                    ? ''
                    : row.disabled ? '' : 'hover:bg-gray-100 dark:hover:bg-gray-800/60',
                ]"
                :style="selection.section === sectionIdx && selection.index === rowIdx ? {
                  backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
                } : undefined"
                :aria-disabled="row.disabled ? 'true' : undefined"
                @click="row.run()"
                @mousemove="selectRow(sectionIdx, rowIdx)"
              >
                <!-- file 行:文件图标 + 文件名命中加粗 + 右对齐相对路径 -->
                <template v-if="mode === 'file'">
                  <component :is="row.icon" class="size-3.5 shrink-0 text-gray-400" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">
                    <template v-for="(seg, i) in row.primarySegments" :key="i">
                      <span v-if="seg.match" class="font-bold">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span v-if="row.subtitle" class="ml-auto shrink-0 truncate pl-3 text-[10px] text-gray-400">
                    {{ row.subtitle }}
                  </span>
                </template>
                <!-- symbol 行:按标题层级缩进 + 标题命中加粗 -->
                <template v-else-if="mode === 'symbol'">
                  <span class="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200" :style="{ paddingLeft: `${Math.max((row.level ?? 1) - 1, 0)}rem` }">
                    <template v-for="(seg, i) in row.primarySegments" :key="i">
                      <span v-if="seg.match" class="font-bold">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                </template>
                <!-- command 行:图标盒 + 标题命中加粗 + 副标 + 快捷键 -->
                <template v-else>
                  <span class="flex size-5 shrink-0 items-center justify-center rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300" aria-hidden="true">
                    <component :is="row.icon" :size="14" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-gray-800 dark:text-gray-200">
                      <template v-for="(seg, i) in row.primarySegments" :key="i">
                        <span v-if="seg.match" class="font-bold">{{ seg.text }}</span>
                        <template v-else>{{ seg.text }}</template>
                      </template>
                    </span>
                    <span v-if="row.subtitle || row.disabledReason" class="block truncate text-[10px] text-gray-400">
                      {{ row.disabled ? (row.disabledReason || row.subtitle) : row.subtitle }}
                    </span>
                  </span>
                  <span
                    v-if="row.shortcut"
                    class="ml-auto shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                  >
                    {{ row.shortcut }}
                  </span>
                </template>
              </button>
            </template>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  buildCommandPaletteSections,
  type CommandPaletteIcon,
  type CommandPaletteItem,
  type CommandPaletteRow,
  type CommandPaletteSection,
} from '@/utils/commandPalette'

const props = defineProps<{
  open: boolean
  items: readonly CommandPaletteItem[]
}>()
const emit = defineEmits<{ 'update:open': [boolean] }>()

const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)

interface SelectionCursor {
  section: number
  index: number
}
const selection = ref<SelectionCursor>({ section: 0, index: 0 })

interface SvgNode {
  kind: 'path' | 'polyline' | 'line' | 'rect' | 'circle'
  d?: string
  points?: string
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  x?: number
  y?: number
  width?: number
  height?: number
  rx?: number
  cx?: number
  cy?: number
  r?: number
}

const iconNodes: Record<CommandPaletteIcon, SvgNode[]> = {
  'new-doc': [
    { kind: 'path', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
    { kind: 'polyline', points: '14 2 14 8 20 8' },
    { kind: 'path', d: 'M12 10v6' },
    { kind: 'path', d: 'M9 13h6' },
  ],
  'new-window': [
    { kind: 'rect', x: 3, y: 3, width: 14, height: 14, rx: 2 },
    { kind: 'path', d: 'M7 21h12a2 2 0 0 0 2-2V7' },
  ],
  'open-file': [
    { kind: 'path', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
    { kind: 'polyline', points: '14 2 14 8 20 8' },
    { kind: 'path', d: 'M12 18v-6' },
    { kind: 'path', d: 'm9 15 3-3 3 3' },
  ],
  'open-folder': [
    { kind: 'path', d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' },
  ],
  save: [
    { kind: 'path', d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' },
    { kind: 'polyline', points: '17 21 17 13 7 13 7 21' },
    { kind: 'polyline', points: '7 3 7 8 15 8' },
  ],
  'save-as': [
    { kind: 'path', d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { kind: 'polyline', points: '17 8 12 3 7 8' },
    { kind: 'line', x1: 12, y1: 3, x2: 12, y2: 15 },
  ],
  export: [
    { kind: 'path', d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' },
    { kind: 'polyline', points: '7 10 12 15 17 10' },
    { kind: 'line', x1: 12, y1: 15, x2: 12, y2: 3 },
  ],
  find: [
    { kind: 'circle', cx: 11, cy: 11, r: 7 },
    { kind: 'path', d: 'M20 20l-4-4' },
  ],
  replace: [
    { kind: 'path', d: 'M7 7h10' },
    { kind: 'path', d: 'm14 4 3 3-3 3' },
    { kind: 'path', d: 'M17 17H7' },
    { kind: 'path', d: 'm10 14-3 3 3 3' },
  ],
  source: [
    { kind: 'path', d: 'm8 9-4 3 4 3' },
    { kind: 'path', d: 'm16 9 4 3-4 3' },
    { kind: 'path', d: 'm14 4-4 16' },
  ],
  'file-actions': [
    { kind: 'path', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
    { kind: 'polyline', points: '14 2 14 8 20 8' },
  ],
  settings: [
    { kind: 'path', d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' },
    { kind: 'circle', cx: 12, cy: 12, r: 3 },
  ],
  'quick-open': [
    { kind: 'path', d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' },
    { kind: 'polyline', points: '14 2 14 8 20 8' },
    { kind: 'circle', cx: 11, cy: 14, r: 3 },
    { kind: 'path', d: 'M14 17l2 2' },
  ],
  'workspace-search': [
    { kind: 'circle', cx: 11, cy: 11, r: 7 },
    { kind: 'path', d: 'M20 20l-4-4' },
  ],
  'workspace-files': [
    { kind: 'path', d: 'M3 7.5V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8L12 6.5H19a2 2 0 0 1 2 2v1' },
    { kind: 'path', d: 'M3 9.5h18l-1.4 8.4a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-1.6L3 9.5z' },
  ],
  outline: [
    { kind: 'path', d: 'M4 6h16' },
    { kind: 'path', d: 'M4 12h10' },
    { kind: 'path', d: 'M4 18h7' },
    { kind: 'path', d: 'M17 12l3 3-3 3' },
  ],
  'workspace-close': [
    { kind: 'path', d: 'M3 7.5V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8L12 6.5H19a2 2 0 0 1 2 2v1' },
    { kind: 'path', d: 'M3 9.5h18l-1.4 8.4a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-1.6L3 9.5z' },
    { kind: 'path', d: 'M9 14h6' },
  ],
  'workspace-switch': [
    { kind: 'path', d: 'M3 7.5V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8L12 6.5H19a2 2 0 0 1 2 2v1' },
    { kind: 'path', d: 'M3 9.5h18l-1.4 8.4a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-1.6L3 9.5z' },
    { kind: 'path', d: 'M8 14h7' },
    { kind: 'path', d: 'm12 11 3 3-3 3' },
  ],
  'recent-file': [
    { kind: 'circle', cx: 12, cy: 12, r: 9 },
    { kind: 'path', d: 'M12 7v5l3 2' },
  ],
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
    'view.fileActions': 'file-actions',
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

interface FlatRow {
  row: CommandPaletteRow
  sectionIndex: number
  rowIndex: number
}

const sections = computed<CommandPaletteSection[]>(() => buildCommandPaletteSections(props.items, query.value))
const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  sections.value.forEach((section, sectionIndex) => {
    section.rows.forEach((row, rowIndex) => out.push({ row, sectionIndex, rowIndex }))
  })
  return out
})
const totalRows = computed(() => flatRows.value.length)
const isEmpty = computed(() => totalRows.value === 0)

const selectedFlatIndex = computed(() => {
  const idx = flatRows.value.findIndex(r => r.sectionIndex === selection.value.section && r.rowIndex === selection.value.index)
  return idx === -1 ? 0 : idx
})

function resetSelectionToFirst() {
  const first = flatRows.value[0]
  selection.value = first
    ? { section: first.sectionIndex, index: first.rowIndex }
    : { section: 0, index: 0 }
}

watch(flatRows, () => {
  if (!totalRows.value) {
    selection.value = { section: 0, index: 0 }
    return
  }
  const exists = flatRows.value.some(r => r.sectionIndex === selection.value.section && r.rowIndex === selection.value.index)
  if (!exists) resetSelectionToFirst()
})

watch(query, resetSelectionToFirst)

watch(() => props.open, async (isOpen) => {
  if (!isOpen) return
  query.value = ''
  resetSelectionToFirst()
  await nextTick()
  inputRef.value?.focus()
}, { immediate: true })

function close() {
  emit('update:open', false)
}

async function runRow(row: CommandPaletteRow) {
  if (row.item.disabled) return
  close()
  try {
    await row.item.run()
  }
  catch (e) {
    console.error('[CommandPalette] 命令执行失败', e)
  }
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
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') {
    e.preventDefault()
    const r = flatRows.value[selectedFlatIndex.value]
    if (r) void runRow(r.row)
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
      class="velo-command-palette-overlay fixed inset-0 z-[120] flex justify-center bg-black/15 dark:bg-black/40"
      style="pointer-events: auto;"
    >
      <div
        ref="panelRef"
        class="velo-command-palette-panel mt-[8vh] flex max-h-[62vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-2xl dark:border-gray-800 dark:bg-[#1a1a1a]"
        data-command-palette-panel
        data-testid="command-palette-panel"
      >
        <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
          <span class="font-mono text-sm font-semibold text-gray-400">&gt;</span>
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="输入命令..."
            data-testid="command-palette-input"
            class="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
            @keydown="onInputKeydown"
          >
        </div>

        <div
          ref="listRef"
          class="min-h-0 flex-1 overflow-y-auto py-1"
        >
          <div v-if="isEmpty" class="px-3 py-4 text-center text-xs text-gray-400">
            无匹配命令
          </div>
          <template v-else>
            <template v-for="(section, sectionIdx) in sections" :key="section.key">
              <div class="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                {{ section.label }}
              </div>
              <button
                v-for="(row, rowIdx) in section.rows"
                :key="row.item.id"
                type="button"
                :data-flat-idx="flatRows.findIndex(r => r.sectionIndex === sectionIdx && r.rowIndex === rowIdx)"
                :data-testid="`command-palette-row-${row.item.id}`"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors"
                :class="[
                  row.item.disabled ? 'cursor-default opacity-50' : 'cursor-pointer',
                  selection.section === sectionIdx && selection.index === rowIdx
                    ? ''
                    : row.item.disabled ? '' : 'hover:bg-gray-100 dark:hover:bg-gray-800/60',
                ]"
                :style="selection.section === sectionIdx && selection.index === rowIdx ? {
                  backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
                } : undefined"
                :aria-disabled="row.item.disabled ? 'true' : undefined"
                @click="runRow(row)"
                @mousemove="selectRow(sectionIdx, rowIdx)"
              >
                <span class="flex size-5 shrink-0 items-center justify-center rounded bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300" aria-hidden="true">
                  <svg
                    class="size-3.5"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                  >
                    <template v-for="(node, nodeIdx) in iconNodes[iconFor(row, section)]" :key="nodeIdx">
                      <path v-if="node.kind === 'path'" :d="node.d" />
                      <polyline v-else-if="node.kind === 'polyline'" :points="node.points" />
                      <line v-else-if="node.kind === 'line'" :x1="node.x1" :y1="node.y1" :x2="node.x2" :y2="node.y2" />
                      <rect v-else-if="node.kind === 'rect'" :x="node.x" :y="node.y" :width="node.width" :height="node.height" :rx="node.rx" />
                      <circle v-else-if="node.kind === 'circle'" :cx="node.cx" :cy="node.cy" :r="node.r" />
                    </template>
                  </svg>
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-gray-800 dark:text-gray-200">
                    <template v-for="(seg, i) in row.titleSegments" :key="i">
                      <span v-if="seg.match" class="font-bold">{{ seg.text }}</span>
                      <template v-else>{{ seg.text }}</template>
                    </template>
                  </span>
                  <span v-if="row.item.subtitle || row.item.disabledReason" class="block truncate text-[10px] text-gray-400">
                    {{ row.item.disabled ? (row.item.disabledReason || row.item.subtitle) : row.item.subtitle }}
                  </span>
                </span>
                <span
                  v-if="row.item.shortcut"
                  class="ml-auto shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
                >
                  {{ row.item.shortcut }}
                </span>
              </button>
            </template>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

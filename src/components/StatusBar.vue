<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { computeDocumentStats } from '@/utils/documentStats'
import { normalizeDisplayPath } from '@/utils/statusPath'
import type { CursorPosition } from '@/utils/editorCursor'

const props = defineProps<{
  activeRoot: string | null
  knownRoots: string[]
  currentFilePath: string | null
  content: string
  dirty: boolean
  sourceMode: boolean
  cursor: CursorPosition
}>()

const emit = defineEmits<{
  'pick-workspace': []
  'set-active-root': [root: string | null]
  'toggle-source-mode': []
}>()

const workspaceMenuOpen = ref(false)
const statsOpen = ref(false)

const fmt = new Intl.NumberFormat('zh-CN')

const stats = computed(() => computeDocumentStats(props.content))
const workspaceLabel = computed(() => props.activeRoot ? normalizeDisplayPath(props.activeRoot) : '无工作区')
const workspaceTitle = computed(() => props.activeRoot ? normalizeDisplayPath(props.activeRoot) : '未打开工作区')
const roots = computed(() => props.knownRoots)

function closePopovers() {
  workspaceMenuOpen.value = false
  statsOpen.value = false
}

function toggleWorkspaceMenu() {
  const next = !workspaceMenuOpen.value
  closePopovers()
  workspaceMenuOpen.value = next
}

function toggleStats() {
  const next = !statsOpen.value
  closePopovers()
  statsOpen.value = next
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePopovers()
}

function onRootPointerdown(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (!target?.closest('[data-statusbar-popover]')) closePopovers()
}

function selectRoot(root: string | null) {
  emit('set-active-root', root)
  closePopovers()
}

function pickWorkspace() {
  emit('pick-workspace')
  closePopovers()
}

document.addEventListener('pointerdown', onRootPointerdown)
document.addEventListener('keydown', onKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onRootPointerdown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <footer
    class="relative z-20 flex h-7 shrink-0 items-center gap-1 border-t border-gray-200 bg-white pr-2 text-xs text-gray-500 dark:border-gray-800 dark:bg-[#111] dark:text-gray-400"
    data-statusbar-popover
  >
    <button
        type="button"
        class="statusbar-segment max-w-[34vw]"
        :title="workspaceTitle"
        aria-haspopup="menu"
        :aria-expanded="workspaceMenuOpen"
        @click="toggleWorkspaceMenu"
      >
      <span>工作区</span>
      <span data-testid="status-workspace-label" class="truncate tabular-nums">{{ workspaceLabel }}</span>
    </button>
    <div
      v-if="workspaceMenuOpen"
      class="absolute bottom-7 left-0 z-30 w-80 overflow-hidden rounded-lg bg-white py-1 text-xs text-gray-600 shadow-lg dark:bg-gray-800 dark:text-gray-200"
      role="menu"
    >
      <div v-if="roots.length" class="max-h-64 overflow-auto py-1">
        <button
          v-for="root in roots"
          :key="root"
          type="button"
          class="workspace-menu-item"
          :class="{ 'workspace-menu-item-active': root === activeRoot }"
          :title="normalizeDisplayPath(root)"
          role="menuitem"
          @click="selectRoot(root)"
        >
          <span class="truncate">{{ normalizeDisplayPath(root) }}</span>
          <span v-if="root === activeRoot" class="shrink-0 text-[10px]">当前</span>
        </button>
      </div>
      <div v-else class="px-3 py-2 text-gray-400 dark:text-gray-500">暂无历史工作区</div>
      <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
      <button type="button" class="workspace-menu-item" role="menuitem" @click="pickWorkspace">
        打开文件夹…
      </button>
      <button
        type="button"
        class="workspace-menu-item"
        role="menuitem"
        :disabled="!activeRoot"
        @click="selectRoot(null)"
      >
        关闭工作区
      </button>
    </div>

    <span
      v-if="dirty"
      class="ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-amber-600 dark:text-amber-400"
      title="当前文档有未保存修改"
    >
      <span class="h-1 w-1 rounded-full bg-amber-500" />
      未保存
    </span>

    <div class="min-w-4 flex-1" />

    <button
      type="button"
      class="statusbar-segment statusbar-icon-segment"
      :class="{ 'statusbar-segment-active': sourceMode }"
      :title="sourceMode ? '切换到所见即所得 (Ctrl+`)' : '切换到源码模式 (Ctrl+`)'"
      :aria-label="sourceMode ? '切换到所见即所得' : '切换到源码模式'"
      :aria-pressed="sourceMode"
      @click="emit('toggle-source-mode')"
    >
      <svg
        v-if="sourceMode"
        class="size-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M4 5h16" />
        <path d="M4 12h10" />
        <path d="M4 19h16" />
        <path d="M18 9l3 3-3 3" />
      </svg>
      <svg
        v-else
        class="size-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    </button>
    <button
      type="button"
      class="statusbar-segment"
      aria-haspopup="dialog"
      :aria-expanded="statsOpen"
      @click="toggleStats"
    >
      字数 <span class="tabular-nums">{{ fmt.format(stats.words) }}</span>
    </button>

    <div
      v-if="statsOpen"
      class="absolute bottom-7 right-0 z-30 w-56 rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-[#1e1e1e]"
      role="dialog"
      aria-label="文档统计"
    >
      <div class="mb-2 text-xs font-semibold text-gray-500 dark:text-gray-300">文档统计</div>
      <dl class="space-y-1.5 text-xs">
        <div class="flex justify-between gap-4">
          <dt class="text-gray-400 dark:text-gray-500">字数</dt>
          <dd class="tabular-nums text-gray-700 dark:text-gray-200">{{ fmt.format(stats.words) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-gray-400 dark:text-gray-500">字符数</dt>
          <dd class="tabular-nums text-gray-700 dark:text-gray-200">{{ fmt.format(stats.characters) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-gray-400 dark:text-gray-500">段落数</dt>
          <dd class="tabular-nums text-gray-700 dark:text-gray-200">{{ fmt.format(stats.paragraphs) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-gray-400 dark:text-gray-500">预计阅读</dt>
          <dd class="tabular-nums text-gray-700 dark:text-gray-200">
            {{ stats.estimatedReadingMinutes === 0 ? '0 分钟' : `${fmt.format(stats.estimatedReadingMinutes)} 分钟` }}
          </dd>
        </div>
      </dl>
    </div>

    <span class="shrink-0 px-1 tabular-nums">
      行 {{ fmt.format(cursor.line) }}, 列 {{ fmt.format(cursor.column) }}
    </span>
  </footer>
</template>

<style scoped>
.statusbar-segment {
  display: inline-flex;
  min-width: 0;
  height: 100%;
  align-items: center;
  gap: 0.25rem;
  border-radius: 0;
  padding: 0 0.375rem;
  transition: background-color 120ms ease, color 120ms ease;
}

.statusbar-icon-segment { 
  width: 1.75rem;
  justify-content: center;
  padding: 0;
}

button.statusbar-segment:not(:disabled):hover,
button.statusbar-segment:not(:disabled):focus-visible,
.statusbar-segment-active {
  background: rgb(243 244 246);
  color: rgb(75 85 99);
  outline: none;
}

:global(.dark button.statusbar-segment:not(:disabled):hover),
:global(.dark button.statusbar-segment:not(:disabled):focus-visible),
:global(.dark .statusbar-segment-active) {
  background: rgb(55 65 81);
  color: rgb(209 213 219);
}

.workspace-menu-item {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.375rem 0.75rem;
  text-align: left;
  transition: background-color 120ms ease, color 120ms ease;
}

.workspace-menu-item:not(:disabled):hover,
.workspace-menu-item:not(:disabled):focus-visible,
.workspace-menu-item-active {
  background: rgb(243 244 246);
  color: rgb(75 85 99);
  outline: none;
}

:global(.dark .workspace-menu-item:not(:disabled):hover),
:global(.dark .workspace-menu-item:not(:disabled):focus-visible),
:global(.dark .workspace-menu-item-active) {
  background: rgb(55 65 81);
  color: rgb(229 231 235);
}

.workspace-menu-item:disabled {
  cursor: default;
  opacity: 0.45;
}
</style>

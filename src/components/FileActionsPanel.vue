<script setup lang="ts">
import { computed } from 'vue'

type FileActionEvent = 'new-doc' | 'new-window' | 'open-file' | 'open-folder' | 'save' | 'save-as' | 'export'
type FileActionKey = FileActionEvent

interface FileActionRow {
  key: FileActionKey
  label: string
  shortcut: string
  event: FileActionEvent
  disabled?: boolean
}

const props = defineProps<{
  isTauri: boolean
  exporting: boolean
}>()

const emit = defineEmits<{
  'new-doc': []
  'new-window': []
  'open-file': []
  'open-folder': []
  'save': []
  'save-as': []
  'export': []
}>()

const groups = computed<FileActionRow[][]>(() => [
  [
    { key: 'new-doc', label: '新建文件', shortcut: 'Ctrl+N', event: 'new-doc' },
    ...(props.isTauri
      ? [{ key: 'new-window' as const, label: '新窗口', shortcut: 'Ctrl+Shift+N', event: 'new-window' as const }]
      : []),
  ],
  [
    { key: 'open-file', label: '打开文件', shortcut: 'Ctrl+O', event: 'open-file' },
    { key: 'open-folder', label: '打开文件夹', shortcut: '—', event: 'open-folder' },
  ],
  [
    { key: 'save', label: '保存', shortcut: 'Ctrl+S', event: 'save' },
    { key: 'save-as', label: '另存为', shortcut: 'Ctrl+Shift+S', event: 'save-as' },
    { key: 'export', label: props.exporting ? '导出中…' : '导出', shortcut: 'Ctrl+Shift+E', event: 'export', disabled: props.exporting },
  ],
])

function emitAction(event: FileActionEvent) {
  if (event === 'new-doc') emit('new-doc')
  else if (event === 'new-window') emit('new-window')
  else if (event === 'open-file') emit('open-file')
  else if (event === 'open-folder') emit('open-folder')
  else if (event === 'save') emit('save')
  else if (event === 'save-as') emit('save-as')
  else emit('export')
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-col overflow-hidden bg-white text-gray-700 transition-colors dark:bg-[#111] dark:text-gray-200" aria-label="文件操作">
    <header class="shrink-0 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
      <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 dark:text-gray-500">File</p>
      <h2 class="mt-1 text-sm font-semibold text-gray-800 dark:text-gray-100">文件</h2>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
      <template v-for="(group, groupIndex) in groups" :key="groupIndex">
        <div
          v-if="groupIndex > 0"
          class="my-2 border-t border-gray-100 dark:border-gray-800"
          data-testid="file-actions-separator"
        />
        <button
          v-for="row in group"
          :key="row.key"
          type="button"
          class="file-action-row mx-1 flex w-[calc(100%-0.5rem)] items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-primary-color)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
          :disabled="row.disabled"
          :aria-label="row.label"
          @click="emitAction(row.event)"
        >
          <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300" aria-hidden="true">
            <svg v-if="row.key === 'new-doc'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M12 10v6" />
              <path d="M9 13h6" />
            </svg>
            <svg v-else-if="row.key === 'new-window'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="14" height="14" rx="2" />
              <path d="M7 21h12a2 2 0 0 0 2-2V7" />
            </svg>
            <svg v-else-if="row.key === 'open-file'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M12 18v-6" />
              <path d="m9 15 3-3 3 3" />
            </svg>
            <svg v-else-if="row.key === 'open-folder'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
            </svg>
            <svg v-else-if="row.key === 'save'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            <svg v-else-if="row.key === 'save-as'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </span>
          <span class="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-100">{{ row.label }}</span>
          <span class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 dark:bg-gray-800 dark:text-gray-500">{{ row.shortcut }}</span>
        </button>
      </template>
    </div>
  </section>
</template>

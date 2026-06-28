<script setup lang="ts">
import { computed } from 'vue'
import { FilePlusCorner, AppWindowMac, FileUp, FolderOpen, Save, Upload, Download } from '@lucide/vue'

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
            <FilePlusCorner v-if="row.key === 'new-doc'" :size="16" />
            <AppWindowMac v-else-if="row.key === 'new-window'" :size="16" />
            <FileUp v-else-if="row.key === 'open-file'" :size="16" />
            <FolderOpen v-else-if="row.key === 'open-folder'" :size="16" />
            <Save v-else-if="row.key === 'save'" :size="16" />
            <Upload v-else-if="row.key === 'save-as'" :size="16" />
            <Download v-else :size="16" />
          </span>
          <span class="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-100">{{ row.label }}</span>
          <span class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 dark:bg-gray-800 dark:text-gray-500">{{ row.shortcut }}</span>
        </button>
      </template>
    </div>
  </section>
</template>

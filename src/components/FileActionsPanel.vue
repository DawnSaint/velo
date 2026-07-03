<script setup lang="ts">
import { computed } from 'vue'
import { FilePlusCorner, AppWindowMac, FileUp, FolderOpen, Save, Upload, Download, BookOpen } from '@lucide/vue'
import { SAMPLE } from '@/utils/samples'

type FileActionEvent = 'new-doc' | 'new-window' | 'open-file' | 'open-folder' | 'save' | 'save-as' | 'export' | 'open-sample'

interface FileActionRow {
  /** Vue :key,需在所有 row 间唯一。sample 复用 SAMPLE_ENTRIES.key,其它 action 用 event 名。 */
  key: string
  label: string
  shortcut: string
  event: FileActionEvent
  disabled?: boolean
}

interface FileActionGroup {
  /** 选填小标题,显示在该组第一条之上;空字符串 / undefined 不渲染。 */
  header?: string
  rows: FileActionRow[]
}

const props = defineProps<{
  isTauri: boolean
  exporting: boolean
  /** 示例文档是否可读 —— false 时不展示示例入口。 */
  samplesAvailable: boolean
}>()

const emit = defineEmits<{
  'new-doc': []
  'new-window': []
  'open-file': []
  'open-folder': []
  'save': []
  'save-as': []
  'export': []
  /** 传 SAMPLE_ENTRIES.key('syntax' / 'code') */
  'open-sample': [key: string]
}>()

const groups = computed<FileActionGroup[]>(() => {
  const g: FileActionGroup[] = [
    {
      rows: [
        { key: 'new-doc', label: '新建文件', shortcut: 'Ctrl+N', event: 'new-doc' },
        ...(props.isTauri
          ? [{ key: 'new-window', label: '新窗口', shortcut: 'Ctrl+Shift+N', event: 'new-window' as FileActionEvent }]
          : []),
      ],
    },
    {
      rows: [
        { key: 'open-file', label: '打开文件', shortcut: 'Ctrl+O', event: 'open-file' },
        { key: 'open-folder', label: '打开文件夹', shortcut: '—', event: 'open-folder' },
      ],
    },
    {
      rows: [
        { key: 'save', label: '保存', shortcut: 'Ctrl+S', event: 'save' },
        { key: 'save-as', label: '另存为', shortcut: 'Ctrl+Shift+S', event: 'save-as' },
        { key: 'export', label: props.exporting ? '导出中…' : '导出', shortcut: 'Ctrl+Shift+E', event: 'export', disabled: props.exporting },
      ],
    },
  ]
  if (props.samplesAvailable) {
    g.push({
      header: '示例文档',
      rows: [
        { key: SAMPLE.key, label: SAMPLE.label, shortcut: '—', event: 'open-sample' },
      ],
    })
  }
  return g
})

function emitAction(row: FileActionRow) {
  // open-sample 多带 key 区分两个 sample,单独分支;其它 event 名跟 emit 同名
  // 用 if/else 让 TS 把 row.event narrow 到字面量,匹配 defineEmits 的重载。
  if (row.event === 'open-sample') emit('open-sample', row.key)
  else if (row.event === 'new-doc') emit('new-doc')
  else if (row.event === 'new-window') emit('new-window')
  else if (row.event === 'open-file') emit('open-file')
  else if (row.event === 'open-folder') emit('open-folder')
  else if (row.event === 'save') emit('save')
  else if (row.event === 'save-as') emit('save-as')
  else if (row.event === 'export') emit('export')
}
</script>

<template>
  <section class="flex h-full min-w-0 flex-col overflow-hidden bg-white text-gray-700 dark:bg-[#111] dark:text-gray-200" aria-label="文件操作">
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
        <div
          v-if="group.header"
          class="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500"
        >
          {{ group.header }}
        </div>
        <button
          v-for="row in group.rows"
          :key="row.key"
          type="button"
          class="file-action-row mx-1 flex w-[calc(100%-0.5rem)] items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-primary-color)] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
          :disabled="row.disabled"
          :aria-label="row.label"
          @click="emitAction(row)"
        >
          <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-300" aria-hidden="true">
            <FilePlusCorner v-if="row.key === 'new-doc'" :size="16" />
            <AppWindowMac v-else-if="row.key === 'new-window'" :size="16" />
            <FileUp v-else-if="row.key === 'open-file'" :size="16" />
            <FolderOpen v-else-if="row.key === 'open-folder'" :size="16" />
            <Save v-else-if="row.key === 'save'" :size="16" />
            <Upload v-else-if="row.key === 'save-as'" :size="16" />
            <BookOpen v-else-if="row.key === 'syntax' || row.key === 'code'" :size="16" />
            <Download v-else :size="16" />
          </span>
          <span class="min-w-0 flex-1 truncate font-medium text-gray-700 dark:text-gray-100">{{ row.label }}</span>
          <span class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 dark:bg-gray-800 dark:text-gray-500">{{ row.shortcut }}</span>
        </button>
      </template>
    </div>
  </section>
</template>
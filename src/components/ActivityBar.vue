<script setup lang="ts">
import { File, Folders, List, Search, Settings } from '@lucide/vue'

export type ActivityBarItem = 'fileActions' | 'files' | 'outline' | 'search' | 'settings'

defineProps<{
  active: ActivityBarItem | null
}>()

const emit = defineEmits<{
  'select-file-actions': []
  'select-files': []
  'select-outline': []
  'select-search': []
  'select-settings': []
}>()

const primaryItems = [
  { key: 'fileActions', label: '文件', event: 'select-file-actions' },
  { key: 'files', label: '工作区', event: 'select-files' },
  { key: 'outline', label: '大纲', event: 'select-outline' },
  { key: 'search', label: '全局搜索', event: 'select-search' },
] as const

const settingsItem = { key: 'settings', label: '设置', event: 'select-settings' } as const

type ActivityBarEvent = typeof primaryItems[number]['event'] | typeof settingsItem['event']

function select(event: ActivityBarEvent) {
  if (event === 'select-file-actions') emit('select-file-actions')
  else if (event === 'select-files') emit('select-files')
  else if (event === 'select-outline') emit('select-outline')
  else if (event === 'select-search') emit('select-search')
  else emit('select-settings')
}
</script>

<template>
  <nav
    class="activity-bar flex w-12 shrink-0 flex-col items-center justify-between py-2 border-r border-gray-200  text-gray-900 transition-colors dark:border-gray-800 dark:bg-[#1a1a1a] dark:text-gray-100"
    aria-label="功能栏"
  >
    <div class="flex flex-col items-center gap-1">
      <button
        v-for="item in primaryItems"
        :key="item.key"
        class="activity-bar__button"
        :class="{ 'activity-bar__button--active': active === item.key }"
        :title="item.label"
        :aria-label="item.label"
        :aria-pressed="active === item.key"
        @click="select(item.event)"
      >
        <File v-if="item.key === 'fileActions'" :size="20" aria-hidden="true" />
        <Folders v-else-if="item.key === 'files'" :size="20" aria-hidden="true" />
        <List v-else-if="item.key === 'outline'" :size="20" aria-hidden="true" />
        <Search v-else :size="20" aria-hidden="true" />
      </button>
    </div>

    <button
      class="activity-bar__button"
      :class="{ 'activity-bar__button--active': active === settingsItem.key }"
      :title="settingsItem.label"
      :aria-label="settingsItem.label"
      :aria-pressed="active === settingsItem.key"
      @click="select(settingsItem.event)"
    >
      <span class="activity-bar__accent" aria-hidden="true" />
      <Settings :size="20" aria-hidden="true" />
    </button>
  </nav>
</template>

<style scoped>
.activity-bar__button {
  position: relative;
  display: inline-flex;
  width: 38px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  color: #9ca3af;
  transition:
    color 140ms ease,
    background-color 140ms ease,
    transform 140ms ease;
}

.activity-bar__button:hover {
  background: rgba(148, 163, 184, 0.16);
  color: #4b5563;
}

:global(.dark.activity-bar__button:hover) {
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}

.activity-bar__button:focus-visible {
  outline: 2px solid var(--md-primary-color, #1F71D9);
  outline-offset: 2px;
}

.activity-bar__button--active {
  background: color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent);
  color: var(--md-primary-color, #1F71D9);
}

.activity-bar__button--active:hover {
  color: var(--md-primary-color, #1F71D9);
}
</style>

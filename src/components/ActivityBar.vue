<script setup lang="ts">
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
        <svg v-if="item.key === 'fileActions'" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <svg v-else-if="item.key === 'files'" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 7.5V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.6.8L12 6.5H19a2 2 0 0 1 2 2v1" />
          <path d="M3 9.5h18l-1.4 8.4a2 2 0 0 1-2 1.6H6.4a2 2 0 0 1-2-1.6L3 9.5z" />
        </svg>
        <svg v-else-if="item.key === 'outline'" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 6h16" />
          <path d="M4 12h10" />
          <path d="M4 18h7" />
          <path d="M17 12l3 3-3 3" />
        </svg>
        <svg v-else class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
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
      <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
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

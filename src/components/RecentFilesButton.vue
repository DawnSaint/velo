<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { normalizeDisplayPath, basenameOfPath } from '@/utils/statusPath'
import type { RecentFileEntry } from '@/stores/persistence'

const props = defineProps<{
  entries: RecentFileEntry[]
}>()

const emit = defineEmits<{
  'open-recent': [path: string]
}>()

const MENU_LIMIT = 12
const open = ref(false)

const visibleEntries = computed(() => props.entries.slice(0, MENU_LIMIT))

function closeMenu() {
  open.value = false
}

function toggleMenu() {
  open.value = !open.value
}

function onRootPointerdown(event: PointerEvent) {
  const target = event.target as HTMLElement | null
  if (!target?.closest('[data-recent-files-menu]')) closeMenu()
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closeMenu()
}

function openRecent(path: string) {
  emit('open-recent', path)
  closeMenu()
}

document.addEventListener('pointerdown', onRootPointerdown)
document.addEventListener('keydown', onKeydown)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onRootPointerdown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="relative" data-recent-files-menu>
    <button
      type="button"
      class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
      title="打开最近文件"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggleMenu"
    >
      <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <path d="M3 3v6h6" />
        <path d="M12 7v5l3 2" />
      </svg>
    </button>

    <div
      v-if="open"
      class="absolute right-0 top-10 z-50 w-80 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 text-xs text-gray-600 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
      role="menu"
      aria-label="最近文件"
    >
      <div class="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
        最近文件
      </div>
      <div v-if="visibleEntries.length" class="max-h-80 overflow-auto pb-1">
        <button
          v-for="entry in visibleEntries"
          :key="entry.path"
          type="button"
          class="mx-1 flex w-[calc(100%-0.5rem)] flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
          :title="normalizeDisplayPath(entry.path)"
          role="menuitem"
          @click="openRecent(entry.path)"
        >
          <span class="truncate font-medium text-gray-700 dark:text-gray-100">{{ basenameOfPath(entry.path) }}</span>
          <span class="truncate text-[11px] text-gray-400 dark:text-gray-500">{{ normalizeDisplayPath(entry.path) }}</span>
        </button>
      </div>
      <div v-else class="px-3 py-3 text-gray-400 dark:text-gray-500">
        暂无最近文件
      </div>
    </div>
  </div>
</template>

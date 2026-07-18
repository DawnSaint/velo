<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'

const store = useEditorStore()
</script>

<template>
  <section class="space-y-5">
    <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-200">外观</h2>

    <!-- 主色 -->
    <div class="velo-setting-row h-8">
      <span class="velo-setting-label">主色</span>
      <span class="flex items-center gap-2">
        <span class="text-sm tabular-nums text-gray-600 dark:text-gray-300">{{ store.primaryColor }}</span>
        <input
          v-model="store.primaryColor"
          type="color"
          class="velo-color-circle h-6 w-6 cursor-pointer rounded-full p-0 dark:border-gray-700"
        />
      </span>
    </div>

    <label class="velo-setting-row h-8 cursor-pointer">
      <span class="velo-setting-label">暗色模式</span>
      <input
        v-model="store.darkMode"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </label>
  </section>
</template>

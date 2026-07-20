<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import SettingsItem from '../SettingsItem.vue'

const store = useEditorStore()
</script>

<template>
  <section class="space-y-5 pt-6">
    <!-- 主色 -->
    <SettingsItem label="主色" :keywords="['primary', 'color', '主题色', 'accent']">
      <span class="flex items-center gap-2">
        <span class="text-sm tabular-nums text-gray-600 dark:text-gray-300">{{ store.primaryColor }}</span>
        <input
          v-model="store.primaryColor"
          type="color"
          class="velo-color-circle h-6 w-6 cursor-pointer rounded-full p-0 dark:border-gray-700"
        />
      </span>
    </SettingsItem>

    <SettingsItem label="暗色模式" :keywords="['dark', 'mode', '夜间', '深色']" clickable>
      <input
        v-model="store.darkMode"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>
  </section>
</template>

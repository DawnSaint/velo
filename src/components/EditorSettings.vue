<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'

const store = useEditorStore()
const documentStore = useDocumentStore()
</script>

<template>
  <div class="min-w-64 p-4 pl-0">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-400">设置</h2>

    <div class="space-y-4">
      <!-- 字号 -->
      <div>
        <label class="mb-1 block text-xs text-gray-400">字号</label>
        <select
          v-model="store.fontSize"
          class="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10 dark:border-gray-700 dark:bg-[#252525]"
        >
          <option value="12px">12px</option>
          <option value="13px">13px</option>
          <option value="14px">14px</option>
          <option value="15px">15px</option>
          <option value="16px">16px</option>
        </select>
      </div>

      <!-- 主色 -->
      <div>
        <label class="mb-1 block text-xs text-gray-400">主色</label>
        <div class="flex items-center gap-2">
          <input
            v-model="store.primaryColor"
            type="color"
            class="h-8 w-8 cursor-pointer rounded-lg border dark:border-gray-700"
          >
          <span class="text-xs text-gray-400">{{ store.primaryColor }}</span>
        </div>
      </div>

      <!-- 开关项 -->
      <div class="space-y-3 pt-1">
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="store.isMacCodeBlock" type="checkbox" class="rounded">
          <span>Mac 代码块圆点</span>
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="store.darkMode" type="checkbox" class="rounded">
          <span>暗色模式</span>
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="documentStore.autoSaveEnabled" type="checkbox" class="rounded">
          <span>自动保存（1 秒）</span>
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="documentStore.autoSaveOnBlur" type="checkbox" class="rounded">
          <span>失焦时保存</span>
        </label>
      </div>
    </div>
  </div>
</template>

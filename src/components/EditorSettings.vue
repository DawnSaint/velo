<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import { BUNDLED_THEMES } from './ProseMirrorEditor/nodes/CodeBlockLangs'

const store = useEditorStore()
const documentStore = useDocumentStore()

const lightThemes = computed(() =>
  BUNDLED_THEMES.filter(t => t.type === 'light'),
)
const darkThemes = computed(() =>
  BUNDLED_THEMES.filter(t => t.type === 'dark'),
)

function themeLabel(t: { displayName: string, id: string }): string {
  return t.displayName || t.id
}
</script>

<template>
  <div class="flex h-full min-w-0 flex-col p-4">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-400">设置</h2>

    <div class="flex-1 space-y-4">
      <!-- 字号 -->
      <div>
        <label class="mb-1 block text-xs text-gray-400">字号</label>
        <select
          v-model="store.fontSize"
          class="w-full rounded-lg border bg-white p-1.5 text-sm outline-none dark:border-gray-700 dark:bg-[#252525]"
        >
          <option value="12px">12px</option>
          <option value="13px">13px</option>
          <option value="14px">14px</option>
          <option value="15px">15px</option>
          <option value="16px">16px</option>
        </select>
      </div>

      <!-- 代码块主题:浅色 + 深色,各一个下拉(带过滤)。切换走
        lazy load(~100-300ms),由 App.vue watch store 触发 ensureTheme +
        dispatch rebuild。独立于 darkMode toggle(后者是纯 CSS 切色)。 -->
      <div>
        <label class="mb-1 block text-xs text-gray-400">代码块主题(浅色)</label>
        <select
          v-model="store.codeLightTheme"
          class="w-full rounded-lg border bg-white p-1.5 text-sm outline-none dark:border-gray-700 dark:bg-[#252525]"
        >
          <option v-for="t in lightThemes" :key="t.id" :value="t.id">{{ themeLabel(t) }}</option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-xs text-gray-400">代码块主题(深色)</label>
        <select
          v-model="store.codeDarkTheme"
          class="w-full rounded-lg border bg-white p-1.5 text-sm outline-none dark:border-gray-700 dark:bg-[#252525]"
        >
          <option v-for="t in darkThemes" :key="t.id" :value="t.id">{{ themeLabel(t) }}</option>
        </select>
      </div>

      <!-- 启动时打开内容 -->
      <div>
        <label class="mb-1 block text-xs text-gray-400">启动时打开</label>
        <select
          v-model="store.startupMode"
          class="w-full rounded-lg border bg-white p-1.5 text-sm outline-none dark:border-gray-700 dark:bg-[#252525]"
        >
          <option value="last-file">上次打开的文件</option>
          <option value="new-doc">新文档</option>
        </select>
      </div>

      <!-- 主色 -->
      <div>
        <label class="mb-1 block text-xs text-gray-400">主色</label>
        <div class="flex items-center gap-2">
          <input
            v-model="store.primaryColor"
            type="color"
            class="velo-color-circle h-6 w-6 cursor-pointer rounded-full border p-0 dark:border-gray-700"
          />
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
          <span>自动保存</span>
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="documentStore.autoSaveOnBlur" type="checkbox" class="rounded">
          <span>失焦保存</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 去掉 input[type=color] 默认外观,内部色块(::-webkit-color-swatch / ::-moz-color-swatch)
 * 撑满整个圆,否则只有外框是圆的,中间是方形色块。 */
.velo-color-circle {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  overflow: hidden;
}
.velo-color-circle::-webkit-color-swatch-wrapper {
  padding: 0;
}
.velo-color-circle::-webkit-color-swatch {
  border: none;
  border-radius: 9999px;
}
.velo-color-circle::-moz-color-swatch {
  border: none;
  border-radius: 9999px;
}
</style>

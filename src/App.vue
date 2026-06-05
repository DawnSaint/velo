<script setup lang="ts">
import { ref, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'
import MilkdownEditor from '@/components/MilkdownEditor/index.vue'
import EditorSettings from '@/components/EditorSettings.vue'
import EditorOutline from '@/components/EditorOutline.vue'
import sampleMd from '@/assets/sample.md?raw'
import veloLogo from '@/assets/Velo.png'

const store = useEditorStore()
const markdownContent = ref(sampleMd)
const showOutline = ref(false)
const showSettings = ref(false)

// 将 dark class 同步到 <html>，使 Tailwind dark: 变体全局生效
watch(
  () => store.darkMode,
  (val) => {
    document.documentElement.classList.toggle('dark', val)
  },
  { immediate: true },
)
</script>

<template>
  <div
    :class="{ 'dark': store.darkMode }"
    class="flex h-screen flex-col bg-[#f5f5f5] text-gray-900 transition-colors dark:bg-[#1a1a1a] dark:text-gray-100"
  >
    <!-- 顶栏 -->
    <header class="flex items-center justify-between px-6 py-3">
      <div class="flex items-center gap-2">
        <button
          class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          :class="{ 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': showOutline }"
          title="大纲"
          @click="showOutline = !showOutline"
        >
          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
        </button>
        <h1 class="flex items-center text-lg font-bold tracking-tight">
          <img :src="veloLogo" alt="Velo" class="h-6 w-6" />
          <span :style="{ color: store.primaryColor }">elo Editor</span>
        </h1>
      </div>
      <button
        class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        :class="{ 'bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300': showSettings }"
        title="设置"
        @click="showSettings = !showSettings"
      >
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>
    </header>

    <!-- 主体 -->
    <div class="flex flex-1 overflow-hidden">
      <!-- 大纲面板 -->
      <aside
        class="outline-panel shrink-0 overflow-hidden border-gray-200 bg-[#f5f5f5] dark:border-gray-800 dark:bg-[#1a1a1a]"
        :class="showOutline ? 'w-64' : 'w-0'"
      >
        <EditorOutline
          :model-value="markdownContent"
        />
      </aside>

      <!-- 编辑器区域 -->
      <MilkdownEditor
        v-model="markdownContent"
        :font-family="store.fontFamily"
        :font-size="store.fontSize"
        :primary-color="store.primaryColor"
        :is-mac-code-block="store.isMacCodeBlock"
        :dark-mode="store.darkMode"
      />

      <!-- 设置面板 -->
      <aside
        class="settings-panel shrink-0 overflow-hidden border-gray-200 bg-[#f5f5f5] dark:border-gray-800 dark:bg-[#1a1a1a]"
        :class="showSettings ? 'w-64' : 'w-0'"
      >
        <EditorSettings />
      </aside>
    </div>
  </div>
</template>

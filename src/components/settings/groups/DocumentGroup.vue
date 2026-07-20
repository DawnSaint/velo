<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'

const store = useEditorStore()
const documentStore = useDocumentStore()
</script>

<template>
  <section class="space-y-5 pt-6">
    <!-- 启动时打开内容 -->
    <div>
      <label class="velo-setting-toplabel">启动时打开</label>
      <select
        v-model="store.startupMode"
        class="velo-select w-full rounded-lg border p-1.5 text-sm outline-none"
      >
        <option value="last-file">上次打开的文件</option>
        <option value="new-doc">新文档</option>
      </select>
    </div>

    <div class="space-y-3 pt-1">
      <label class="velo-setting-row h-8 cursor-pointer">
        <span class="velo-setting-label">自动保存</span>
        <input
          v-model="documentStore.autoSaveEnabled"
          type="checkbox"
          role="switch"
          class="velo-switch"
        >
      </label>
      <label class="velo-setting-row h-8 cursor-pointer">
        <span class="velo-setting-label">失焦保存</span>
        <input
          v-model="documentStore.autoSaveOnBlur"
          type="checkbox"
          role="switch"
          class="velo-switch"
        >
      </label>
    </div>
  </section>
</template>

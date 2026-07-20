<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import SettingsItem from '../SettingsItem.vue'

const store = useEditorStore()
const documentStore = useDocumentStore()
</script>

<template>
  <section class="space-y-5 pt-6">
    <!-- 启动时打开内容 -->
    <SettingsItem label="启动时打开" :keywords="['startup', '启动', 'open']">
      <select
        v-model="store.startupMode"
        class="velo-select w-48 rounded-lg border p-1.5 text-sm outline-none"
      >
        <option value="last-file">上次打开的文件</option>
        <option value="new-doc">新文档</option>
      </select>
    </SettingsItem>

    <div class="space-y-3 pt-1">
      <SettingsItem label="自动保存" :keywords="['auto', 'save', '自动']" clickable>
        <input
          v-model="documentStore.autoSaveEnabled"
          type="checkbox"
          role="switch"
          class="velo-switch"
        >
      </SettingsItem>
      <SettingsItem label="失焦保存" :keywords="['blur', 'focus', 'save', '失焦']" clickable>
        <input
          v-model="documentStore.autoSaveOnBlur"
          type="checkbox"
          role="switch"
          class="velo-switch"
        >
      </SettingsItem>
    </div>
  </section>
</template>

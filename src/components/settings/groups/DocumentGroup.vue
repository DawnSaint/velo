<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import SettingsItem from '../SettingsItem.vue'
import VeloSelect from '../VeloSelect.vue'

const store = useEditorStore()
const documentStore = useDocumentStore()

const startupModeOptions = [
  { value: 'last-file', label: '上次打开的文件' },
  { value: 'new-doc', label: '新文档' },
]
</script>

<template>
  <section class="space-y-4 pt-6">
    <!-- 启动时打开内容 -->
    <SettingsItem label="启动时打开" :keywords="['startup', '启动', 'open']">
      <VeloSelect
        v-model="store.startupMode"
        :options="startupModeOptions"
        aria-label="启动时打开"
      />
    </SettingsItem>

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

  </section>
</template>

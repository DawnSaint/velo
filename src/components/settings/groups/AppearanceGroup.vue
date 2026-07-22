<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import SettingsItem from '../SettingsItem.vue'

const store = useEditorStore()
</script>

<template>
  <section class="space-y-4 pt-6">
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

    <!-- 主题色影响文档颜色:默认关闭,文档内容(标题/加粗/列表/折叠/表格等)用各自默认色;
         开启后文档内容色跟随主色(旧行为)。UI  chrome(侧栏/设置/分割线)始终跟随主色。 -->
    <SettingsItem label="主题色影响文档颜色" :keywords="['primary', 'color', '文档', '主题色', '标题', '影响']" clickable>
      <input
        v-model="store.themeColorAffectsDoc"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>

    <SettingsItem label="主题模式" :keywords="['dark', 'mode', '夜间', '深色', 'theme', 'system', '系统', '跟随']">
      <select
        v-model="store.themeMode"
        class="velo-select w-40 rounded-lg border p-1.5 text-sm outline-none"
      >
        <option value="system">跟随系统</option>
        <option value="light">始终浅色</option>
        <option value="dark">始终暗色</option>
      </select>
    </SettingsItem>
  </section>
</template>

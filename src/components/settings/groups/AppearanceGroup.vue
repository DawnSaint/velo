<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import SettingsItem from '../SettingsItem.vue'
import VeloSelect from '../VeloSelect.vue'

const store = useEditorStore()

const themeModeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '始终浅色' },
  { value: 'dark', label: '始终暗色' },
]
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
      <VeloSelect
        v-model="store.themeMode"
        :options="themeModeOptions"
        aria-label="主题模式"
      />
    </SettingsItem>

    <!-- 中文字间距:给中文字符添加微量字间距,提升排版可读性。纯视觉装饰,不影响文档内容。 -->
    <SettingsItem label="中文字间距" :keywords="['中文', '字间距', 'letter', 'spacing', '汉字', '排版']" clickable>
      <input
        v-model="store.cjkLetterSpacing"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>
  </section>
</template>

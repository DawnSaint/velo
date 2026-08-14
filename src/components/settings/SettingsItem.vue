<script setup lang="ts">
// 设置项包装组件（设置搜索功能）
//
// 职责：
//   1. 布局 —— 承担现有 .velo-setting-row / .velo-setting-toplabel 的布局职责，
//      减少各 group 组件的重复样板。
//   2. 搜索注册 —— onMounted 时经 provide/inject 把自身 label + keywords 注册到
//      搜索索引，onBeforeUnmount 注销。新增设置项只需用 <SettingsItem> 包裹即
//      自动纳入搜索，无需手动维护元数据。
//
// variant:
//   - 'row'      左 label 右控件（复用 .velo-setting-row 样式）
//   - 'toplabel' 上 label 下控件（复用 .velo-setting-toplabel 样式）

import { computed, getCurrentInstance, inject, onBeforeUnmount, onMounted } from 'vue'
import type { SettingsSearchEntry } from '@/composables/useSettingsSearchIndex'

const props = withDefaults(defineProps<{
  /** 设置项显示名称（用户看到的 label 文本，同时作为搜索主文本） */
  label: string
  /** 搜索别名：英文、拼音、缩写等 label 之外的补充词 */
  keywords?: string[]
  /** 行布局：row=左label右控件 / toplabel=上label下控件 */
  variant?: 'row' | 'toplabel'
  /** 是否可点击（switch 行需要 cursor-pointer） */
  clickable?: boolean
  /** label 下方次要提示文本（如版本号、说明文字等） */
  hint?: string
}>(), {
  variant: 'row',
  clickable: false,
})

// 唯一 id：label 去空格 + Vue 实例 uid，保证 DOM 定位唯一。
const uid = getCurrentInstance()?.uid ?? 0
const itemId = computed(() => `${props.label.replace(/\s+/g, '-')}-${uid}`)

// SettingsGroupWrapper provide 的分组 id。
const groupId = inject<string>('settingsGroupId', '')

// SettingsPage provide 的注册 / 注销函数（独立挂载 / 测试时无 provide 安全回退）。
const register = inject<(item: SettingsSearchEntry) => void>('settingsSearchRegister', () => {})
const unregister = inject<(id: string) => void>('settingsSearchUnregister', () => {})

onMounted(() => {
  register({
    id: itemId.value,
    label: props.label,
    keywords: props.keywords ?? [],
    groupId,
  })
})

onBeforeUnmount(() => {
  unregister(itemId.value)
})
</script>

<template>
  <!-- variant="row"：左 label 右控件，复用现有 .velo-setting-row 样式 -->
  <div
    v-if="variant === 'row'"
    :data-settings-item="itemId"
    class="flex flex-col justify-center"
    :class="{ 'cursor-pointer': clickable }"
    :style="hint ? undefined : { height: '2rem' }"
  >
    <div class="flex items-center justify-between">
      <span class="velo-setting-label">{{ label }}</span>
      <slot />
    </div>
    <span v-if="hint" class="velo-setting-hint">{{ hint }}</span>
  </div>
  <!-- variant="toplabel"：上 label 下控件，复用现有 .velo-setting-toplabel 样式 -->
  <div
    v-else
    :data-settings-item="itemId"
  >
    <label class="velo-setting-toplabel">{{ label }}</label>
    <slot />
  </div>
</template>

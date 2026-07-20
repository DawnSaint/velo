<script setup lang="ts">
// 设置分组的薄包装：provide groupId 给内部的 <SettingsItem>，
// 让 SettingsItem 在 onMounted 时能把自身注册到搜索索引并带上所属分组。
//
// SettingsPage 改为 v-show 渲染所有分组后，每个分组都用此组件包裹，
// 内部 group 组件无需感知 groupId。

import { provide } from 'vue'

const props = defineProps<{
  groupId: string
}>()

provide('settingsGroupId', props.groupId)
</script>

<template>
  <div><slot /></div>
</template>

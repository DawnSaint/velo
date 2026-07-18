<script setup lang="ts">
// 设置页主组件（#settings-panel 重做）
//
// 取代旧 EditorSettings.vue(原挤在工作区左侧栏 ~256px 宽)。现为整页布局,
// 接管编辑器主区域:左导航(分组列表)+ 右内容(当前分组组件)。
// VSCode / Obsidian 设置页风格,给设置项更宽裕的展示空间。
//
// 分组来源:registry.ts 的 getSettingsGroups()(由 registerGroups.ts 注册内置 4 组,
// 未来新设置项只需注册一行)。本组件不硬编码任何分组,纯靠 registry 驱动渲染。
//
// 关闭/失活途径(两态):设置 tab 可后台保留,切文档 tab 只失活不关闭。
//   彻底关闭(X / 中键)→ TabBar emit('close-settings') → App.vue closeSettings()
//   失活(Escape / 切文档 tab / ActivityBar toggle)→ settingsActive=false,tab 保留
//   Escape 由本组件 emit('close') → App.vue 设 settingsActive=false(不关 settingsOpen)。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getSettingsGroups } from './registry'

const emit = defineEmits<{ 'close': [] }>()

const groups = computed(() => getSettingsGroups())

// 当前激活分组 id。默认取首个(注册后必有至少一组;非 Windows 也至少有 editor/appearance/document)。
const activeGroupId = ref<string>(groups.value[0]?.id ?? '')

const activeGroup = computed(() =>
  groups.value.find(g => g.id === activeGroupId.value) ?? groups.value[0] ?? null,
)

function selectGroup(id: string) {
  activeGroupId.value = id
}

// Escape 关闭设置页
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="settings-page flex h-full min-w-0 flex-1 overflow-hidden bg-white dark:bg-[#1e1e1e]">
    <!-- 左导航 + 右内容(顶栏由 TabBar 的设置 tab 承担,本组件无自带 header) -->
    <nav class="w-48 shrink-0 overflow-y-auto border-r border-gray-200 py-2 dark:border-gray-800" aria-label="设置分组">
      <button
        v-for="g in groups"
        :key="g.id"
        type="button"
        class="settings-nav-item"
        :class="{ 'settings-nav-item--active': g.id === activeGroupId }"
        :aria-current="g.id === activeGroupId ? 'page' : undefined"
        @click="selectGroup(g.id)"
      >
        <component :is="g.icon" :size="16" aria-hidden="true" />
        <span>{{ g.title }}</span>
      </button>
    </nav>

    <!-- 右内容:居中限宽,纵向滚动 -->
    <div class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-2xl px-8 py-6">
        <component :is="activeGroup?.component" v-if="activeGroup" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 左导航项:与 ActivityBar 视觉语言一致 —— active 用主色 12% 半透明底 + 主色文本。
   高度 32px,左贴边圆角,hover 浅灰底。 */
.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: calc(100% - 8px);
  margin: 1px 4px;
  height: 32px;
  padding: 0 0.625rem;
  border-radius: 7px;
  color: rgb(75 85 99); /* gray-600 */
  font-size: 0.8125rem;
  font-weight: 500;
  text-align: left;
  transition: background-color 120ms ease, color 120ms ease;
}

.settings-nav-item:hover {
  background: rgb(243 244 246); /* gray-100 */
  color: rgb(31 41 55); /* gray-800 */
}

.settings-nav-item--active {
  background: color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent);
  color: var(--md-primary-color, #1F71D9);
}

.settings-nav-item--active:hover {
  background: color-mix(in srgb, var(--md-primary-color, #1F71D9) 16%, transparent);
  color: var(--md-primary-color, #1F71D9);
}

.settings-nav-item:focus-visible {
  outline: 2px solid var(--md-primary-color, #1F71D9);
  outline-offset: 2px;
}

.dark .settings-nav-item {
  color: rgb(156 163 175); /* gray-400 */
}
.dark .settings-nav-item:hover {
  background: rgb(38 38 38);
  color: rgb(229 231 235); /* gray-200 */
}
</style>

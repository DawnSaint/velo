<script setup lang="ts">
// 左贴边功能栏(v0.6.x):
//  - 入口:文件(下拉面板,FileMenuButton 提供)/ 工作区 / 大纲 / 全局搜索 / 设置。
//    「文件」原侧栏 FileActionsPanel + 顶栏 RecentFilesButton + dev 欢迎按钮
//    三合一,统一走 FileMenuButton 的 `#trigger` 插槽渲染,ActivityBar 仅
//    转发 FileMenuButton 的事件(命令发到 App.vue,App.vue 接管同一批 handler)。
//  - 视觉:38×42 主色块按钮,active 用 `color-mix(in srgb, var(--md-primary-color) 12%, transparent)`
//    + 主色文本;hover 走 rgba 半透明,亮/暗双主题均一致。
//  - 高度:在 App.vue 外层 flex-row 直接接顶(不再压在 header 之下),与
//    leftPanelView 的侧栏(sidebar / settings)同列高对齐。
//  - 「文件」按钮的 active 状态直接用 FileMenuButton 的 open 状态(slot scope),
//    不再走 active prop —— 下拉面板是组件自管的瞬时态,不适合混进 ActivityBar
//    的「当前面板」长态。其它按钮(active = files/outline/search/settings)
//    继续由 App.vue 通过 active prop 控制。

import { Folders, List, Search, Settings, File } from '@lucide/vue'
import FileMenuButton from './FileMenuButton.vue'
import type { RecentFileEntry } from '@/stores/persistence'

export type ActivityBarItem = 'files' | 'outline' | 'search' | 'settings'

defineProps<{
  active: ActivityBarItem | null
  isTauri: boolean
  exporting: boolean
  recentEntries: RecentFileEntry[]
  welcomeEnabled: boolean
}>()

const emit = defineEmits<{
  'select-files': []
  'select-outline': []
  'select-search': []
  'select-settings': []
  // —— FileMenuButton 转发(v0.6.x)——
  'new-doc': []
  'new-window': []
  'open-file': []
  'open-folder': []
  'save': []
  'save-as': []
  'export': []
  'open-recent': [path: string]
  'open-welcome': []
}>()

const navItems = [
  { key: 'files', label: '工作区', event: 'select-files' },
  { key: 'outline', label: '大纲', event: 'select-outline' },
  { key: 'search', label: '全局搜索', event: 'select-search' },
] as const

const settingsItem = { key: 'settings', label: '设置', event: 'select-settings' } as const

type NavEvent = typeof navItems[number]['event'] | typeof settingsItem['event']

function select(event: NavEvent) {
  if (event === 'select-files') emit('select-files')
  else if (event === 'select-outline') emit('select-outline')
  else if (event === 'select-search') emit('select-search')
  else emit('select-settings')
}
</script>

<template>
  <nav
    class="activity-bar flex w-12 shrink-0 flex-col items-center justify-between py-2 border-r border-gray-200 text-gray-900 dark:border-gray-800 dark:bg-[#1a1a1a] dark:text-gray-100"
    aria-label="功能栏"
  >
    <div class="flex flex-col items-center gap-1">
      <!-- 文件(下拉面板,FileMenuButton 提供) -->
      <FileMenuButton
        :is-tauri="isTauri"
        :exporting="exporting"
        :recent-entries="recentEntries"
        :welcome-enabled="welcomeEnabled"
        @new-doc="emit('new-doc')"
        @new-window="emit('new-window')"
        @open-file="emit('open-file')"
        @open-folder="emit('open-folder')"
        @save="emit('save')"
        @save-as="emit('save-as')"
        @export="emit('export')"
        @open-recent="(p) => emit('open-recent', p)"
        @open-welcome="emit('open-welcome')"
      >
        <!-- FileMenuButton 用 `#trigger` slot 暴露 `open / toggle / registerRef`:
             `registerRef` 必须在自定义 button 上 `:ref` 调一次把元素喂回去,否则
             `recomputeMenuPos` 走 `if (!btn) { menuPos = null; return }`,主菜单
             永远不渲染(用户点了毫无反应)。slot 默认按钮已自带 `:ref="registerRef"`,
             走默认分支不踩这个坑;ActivityBar 这种"自定义视觉"路径必须显式绑。 -->
        <template #trigger="{ open, toggle, registerRef }">
          <button
            :ref="registerRef"
            type="button"
            class="activity-bar__button"
            :class="{ 'activity-bar__button--active': open }"
            title="文件"
            aria-label="文件"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click="toggle"
          >
            <File :size="20" aria-hidden="true" />
          </button>
        </template>
      </FileMenuButton>

      <button
        v-for="item in navItems"
        :key="item.key"
        class="activity-bar__button"
        :class="{ 'activity-bar__button--active': active === item.key }"
        :title="item.label"
        :aria-label="item.label"
        :aria-pressed="active === item.key"
        @click="select(item.event)"
      >
        <Folders v-if="item.key === 'files'" :size="20" aria-hidden="true" />
        <List v-else-if="item.key === 'outline'" :size="20" aria-hidden="true" />
        <Search v-else :size="20" aria-hidden="true" />
      </button>
    </div>

    <button
      class="activity-bar__button"
      :class="{ 'activity-bar__button--active': active === settingsItem.key }"
      :title="settingsItem.label"
      :aria-label="settingsItem.label"
      :aria-pressed="active === settingsItem.key"
      @click="select(settingsItem.event)"
    >
      <span class="activity-bar__accent" aria-hidden="true" />
      <Settings :size="20" aria-hidden="true" />
    </button>
  </nav>
</template>

<style scoped>
.activity-bar__button {
  position: relative;
  display: inline-flex;
  width: 38px;
  height: 42px;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  color: #9ca3af;
  transition:
    color 140ms ease,
    background-color 140ms ease,
    transform 140ms ease;
}

.activity-bar__button:hover {
  background: rgba(148, 163, 184, 0.16);
  color: #4b5563;
}

:global(.dark.activity-bar__button:hover) {
  background: rgba(255, 255, 255, 0.08);
  color: #e5e7eb;
}

.activity-bar__button:focus-visible {
  outline: 2px solid var(--md-primary-color, #1F71D9);
  outline-offset: 2px;
}

.activity-bar__button--active {
  background: color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent);
  color: var(--md-primary-color, #1F71D9);
}

.activity-bar__button--active:hover {
  color: var(--md-primary-color, #1F71D9);
}
</style>
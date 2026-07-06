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
//
// v0.6.1 自定义(排序 / 隐藏):
//  - 3 个视图入口(工作区 / 大纲 / 全局搜索)可拖拽重排 + 可隐藏;顺序 / 隐藏态
//    持久化在 editorStore(全局 UI 偏好,见 docs/architecture/file-tree.md)。
//  - 「设置」固定底部(不可拖拽),可隐藏。
//  - 「文件」固定顶部,不参与排序 / 隐藏。
//  - 右键功能栏任意位置 → 上下文菜单(4 项勾选 toggle + 重置默认),恢复隐藏入口。
//  - 拖拽范式对齐 TabBar(HTML5 draggable + dropTarget={key,side});差异:
//    纵向列表 → 用 clientY 判 before/after(TabBar 横向用 clientX)。

import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Folders, List, Search, Settings, File } from '@lucide/vue'
import FileMenuButton from './FileMenuButton.vue'
import ActivityBarContextMenu from './ActivityBarContextMenu.vue'
import { useEditorStore, type ActivityBarItem } from '@/stores/editor'
import type { RecentFileEntry } from '@/stores/persistence'

export type { ActivityBarItem }

defineProps<{
  active: ActivityBarItem | null
  isTauri: boolean
  exporting: boolean
  recentEntries: RecentFileEntry[]
  welcomeEnabled: boolean
  alwaysOnTop: boolean
  focusMode: boolean
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
  'toggle-always-on-top': []
  'toggle-focus-mode': []
}>()

const editorStore = useEditorStore()

// 入口元数据:key → label / 图标 / select 事件。展示顺序由 editorStore 决定
// (visibleActivityBarItems 已按用户排序 + 过滤隐藏);这里只提供静态映射。
const ITEM_LABELS: Record<ActivityBarItem, string> = {
  files: '工作区',
  outline: '大纲',
  search: '全局搜索',
  settings: '设置',
}
const ITEM_ICONS = {
  files: Folders,
  outline: List,
  search: Search,
  settings: Settings,
}

function selectItem(key: ActivityBarItem) {
  if (key === 'files') emit('select-files')
  else if (key === 'outline') emit('select-outline')
  else if (key === 'search') emit('select-search')
  else emit('select-settings')
}

// ===== 拖拽重排(v0.6.1,对齐 TabBar 范式) =====
const draggingKey = ref<ActivityBarItem | null>(null)
const dropTarget = ref<{ key: ActivityBarItem, side: 'before' | 'after' } | null>(null)

function onDragStart(event: DragEvent, key: ActivityBarItem) {
  if (!event.dataTransfer) return
  // 拖拽源关掉可能挂着的右键菜单 —— 否则拖拽中途菜单残留。
  closeContextMenu()
  event.dataTransfer.setData('application/x-velo-activity-key', key)
  event.dataTransfer.effectAllowed = 'move'
  draggingKey.value = key
}

function onDragOver(event: DragEvent, key: ActivityBarItem) {
  if (draggingKey.value === null) return
  if (draggingKey.value === key) {
    dropTarget.value = null
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const isAfter = event.clientY - rect.top > rect.height / 2
  // 落点规范化(对齐 TabBar):任意两个相邻图标之间的缝隙统一表示为
  // 「before 下一个」,而非「after 上一个」——否则上半扫下半时分处两条
  // 位置(before 在下图标顶、after 在上图标底),divider 会跳动。仅末尾
  // 项没有「下一个」可借,才退回 after 表示尾部。
  if (isAfter) {
    const items = editorStore.visibleActivityBarItems
    const next = items[items.indexOf(key) + 1]
    dropTarget.value = next ? { key: next, side: 'before' } : { key, side: 'after' }
  } else {
    dropTarget.value = { key, side: 'before' }
  }
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  const fromKey = draggingKey.value
  const target = dropTarget.value
  if (fromKey && target) {
    editorStore.reorderActivityBar(fromKey, target.key, target.side)
  }
  resetDragState()
}

function onDragEnd() {
  resetDragState()
}

function resetDragState() {
  draggingKey.value = null
  dropTarget.value = null
}

// ===== 右键菜单(v0.6.1,对齐 TabContextMenu 范式) =====
//
// 本地 ref 记坐标,Teleport 到 body,全局 pointerdown / Escape handler 关闭。
// 菜单元件 (ActivityBarContextMenu.vue) 只展示 + emit,父级统一管「点外部关闭」,
// 与 FileTreeContextMenu / TabContextMenu 同款 —— 不在组件内自己挂全局 listener。
const contextMenu = ref<{ x: number, y: number } | null>(null)
const contextMenuRef = ref<InstanceType<typeof ActivityBarContextMenu> | null>(null)

/** 菜单条目:固定展示序(不随用户自定义顺序变),每项带当前显隐态。
 *  仅列可隐藏的 3 个视图入口;'settings' 固定显示,不进勾选列表。 */
const contextMenuItems = computed(() => {
  const hideable: ActivityBarItem[] = ['files', 'outline', 'search']
  return hideable.map(key => ({
    key,
    label: ITEM_LABELS[key],
    visible: !editorStore.isActivityBarItemHidden(key),
  }))
})

function onActivityContextMenu(event: MouseEvent) {
  event.preventDefault()
  // 视口约束:菜单宽 ~176 / 高 ~210(4 行:3 勾选 + 重置);贴边留 8px 安全距
  const MENU_W = 176
  const MENU_H = 210
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - MENU_W - 8))
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - MENU_H - 8))
  contextMenu.value = { x, y }
}

function closeContextMenu() {
  contextMenu.value = null
}

function onToggleItem(key: ActivityBarItem) {
  // 不关菜单:用户通常连续调多项
  editorStore.toggleActivityBarHidden(key)
}

function onResetActivityBar() {
  editorStore.resetActivityBar()
  closeContextMenu()
}

// —— 全局 listener:点外部关闭 + Escape 关闭 ——
function onGlobalPointerDown(event: PointerEvent) {
  if (!contextMenu.value) return
  const target = event.target as Node | null
  if (!target) return
  const menuEl = contextMenuRef.value?.rootEl ?? null
  if (menuEl && (menuEl === target || menuEl.contains(target))) return
  closeContextMenu()
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  if (contextMenu.value) closeContextMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onGlobalPointerDown, true)
  document.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onGlobalPointerDown, true)
  document.removeEventListener('keydown', onGlobalKeydown)
})
</script>

<template>
  <nav
    class="activity-bar flex w-12 shrink-0 flex-col items-center justify-between py-2 border-r border-gray-200 text-gray-900 dark:border-gray-800 dark:bg-[#1a1a1a] dark:text-gray-100"
    aria-label="功能栏"
    @contextmenu.prevent="onActivityContextMenu"
  >
    <div class="flex flex-col items-center gap-1">
      <!-- 文件(下拉面板,FileMenuButton 提供)—— 固定顶部,不参与排序/隐藏 -->
      <FileMenuButton
        :is-tauri="isTauri"
        :exporting="exporting"
        :recent-entries="recentEntries"
        :welcome-enabled="welcomeEnabled"
        :always-on-top="alwaysOnTop"
        :focus-mode="focusMode"
        @new-doc="emit('new-doc')"
        @new-window="emit('new-window')"
        @open-file="emit('open-file')"
        @open-folder="emit('open-folder')"
        @save="emit('save')"
        @save-as="emit('save-as')"
        @export="emit('export')"
        @open-recent="(p) => emit('open-recent', p)"
        @open-welcome="emit('open-welcome')"
        @toggle-always-on-top="emit('toggle-always-on-top')"
        @toggle-focus-mode="emit('toggle-focus-mode')"
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
        v-for="item in editorStore.visibleActivityBarItems"
        :key="item"
        class="activity-bar__button"
        :class="{
          'activity-bar__button--active': active === item,
          'activity-bar__button--dragging': draggingKey === item,
          'activity-bar__button--drop-before': dropTarget?.key === item && dropTarget?.side === 'before',
          'activity-bar__button--drop-after': dropTarget?.key === item && dropTarget?.side === 'after',
        }"
        :title="ITEM_LABELS[item]"
        :aria-label="ITEM_LABELS[item]"
        :aria-pressed="active === item"
        draggable="true"
        @click="selectItem(item)"
        @dragstart="onDragStart($event, item)"
        @dragover="onDragOver($event, item)"
        @drop="onDrop($event)"
        @dragend="onDragEnd"
      >
        <component :is="ITEM_ICONS[item]" :size="20" aria-hidden="true" />
      </button>
    </div>

    <button
      class="activity-bar__button"
      :class="{ 'activity-bar__button--active': active === 'settings' }"
      title="设置"
      aria-label="设置"
      :aria-pressed="active === 'settings'"
      @click="selectItem('settings')"
    >
      <span class="activity-bar__accent" aria-hidden="true" />
      <Settings :size="20" aria-hidden="true" />
    </button>
  </nav>

  <!-- 右键菜单(Teleport 在子组件内,作为 nav 兄弟根避免干扰 justify-between)。 -->
  <ActivityBarContextMenu
    v-if="contextMenu"
    ref="contextMenuRef"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :items="contextMenuItems"
    @toggle="onToggleItem"
    @reset="onResetActivityBar"
  />
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

/* 拖拽重排视觉(v0.6.1):被拖项半透明;落点上下 2px 主色横线。
 * 纵向列表 → before 走 ::before(顶),after 走 ::after(底)。 */
.activity-bar__button--dragging {
  opacity: 0.5;
}

.activity-bar__button--drop-before::before,
.activity-bar__button--drop-after::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  border-radius: 1px;
  background: var(--md-primary-color, #1F71D9);
  pointer-events: none;
  z-index: 1;
}

.activity-bar__button--drop-before::before {
  top: -2px;
}

.activity-bar__button--drop-after::after {
  bottom: -2px;
}
</style>

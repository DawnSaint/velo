<script setup lang="ts">
// 左贴边功能栏(v0.7.x):
//  - 入口:工作区 / 大纲 / 全局搜索 / 资产(可拖拽重排 + 可隐藏)+ 设置(固定底部)。
//    「文件」下拉面板(FileMenuButton)已从这里移出,改挂在 App.vue 顶栏 logo 位
//    (向下箭头触发),ActivityBar 不再承载文件命令入口。
//  - 视觉:38×40 按钮,active 仅主色文本;hover 仅切文字色,无背景。
//  - 高度:在 App.vue 外层 flex-row 直接接顶(不再压在 header 之下),与
//    leftPanelView 的侧栏(sidebar / settings)同列高对齐。
//
// v0.6.1 自定义(排序 / 隐藏):
//  - 3 个视图入口(工作区 / 大纲 / 全局搜索)可拖拽重排 + 可隐藏;顺序 / 隐藏态
//    持久化在 editorStore(全局 UI 偏好,见 docs/architecture/file-tree.md)。
//  - 「设置」固定底部(不可拖拽),可隐藏。
//  - 「文件」固定顶部,不参与排序 / 隐藏。
//  - 右键功能栏任意位置 → 上下文菜单(4 项勾选 toggle + 重置默认),恢复隐藏入口。
//  - 拖拽范式对齐 TabBar(HTML5 draggable + dropTarget={key,side});差异:
//    纵向列表 → 用 clientY 判 before/after(TabBar 横向用 clientX)。

import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Files, List, Search, Settings, Image as ImageIcon, History } from '@lucide/vue'
import ActivityBarContextMenu from './ActivityBarContextMenu.vue'
import { useContextMenu, clampToViewport } from '@/composables/useContextMenu'
import { useEditorStore, type ActivityBarItem } from '@/stores/editor'

export type { ActivityBarItem }

const props = defineProps<{
  active: ActivityBarItem | null
}>()
const emit = defineEmits<{
  'select-files': []
  'select-outline': []
  'select-search': []
  'select-assets': []
  'select-history': []
  'select-settings': []
}>()

const editorStore = useEditorStore()

// 入口元数据:key → label / 图标 / select 事件。展示顺序由 editorStore 决定
// (visibleActivityBarItems 已按用户排序 + 过滤隐藏);这里只提供静态映射。
const ITEM_LABELS: Record<ActivityBarItem, string> = {
  files: '工作区',
  outline: '大纲',
  search: '全局搜索',
  assets: '资产',
  history: '版本历史',
  settings: '设置',
}
const ITEM_ICONS = {
  files: Files,
  outline: List,
  search: Search,
  assets: ImageIcon,
  history: History,
  settings: Settings,
}

function selectItem(key: ActivityBarItem) {
  if (key === 'files') emit('select-files')
  else if (key === 'outline') emit('select-outline')
  else if (key === 'search') emit('select-search')
  else if (key === 'assets') emit('select-assets')
  else if (key === 'history') emit('select-history')
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

// ===== 右键菜单(v0.6.1) =====
//
// 走 useContextMenu composable 统一管全局 listener + 视口 clamp。
// 菜单元件 (ActivityBarContextMenu.vue) 只展示 + emit。
const contextMenu = ref<{ x: number, y: number } | null>(null)
const contextMenuRef = ref<InstanceType<typeof ActivityBarContextMenu> | null>(null)

useContextMenu({
  isOpen: () => contextMenu.value !== null,
  getMenuEl: () => contextMenuRef.value?.rootEl ?? null,
  close: () => { contextMenu.value = null },
})

/** 菜单条目:固定展示序(不随用户自定义顺序变),每项带当前显隐态。
 *  仅列可隐藏的 3 个视图入口;'settings' 固定显示,不进勾选列表。 */
const contextMenuItems = computed(() => {
  const hideable: ActivityBarItem[] = ['files', 'outline', 'search', 'assets', 'history']
  return hideable.map(key => ({
    key,
    label: ITEM_LABELS[key],
    visible: !editorStore.isActivityBarItemHidden(key),
  }))
})

function closeContextMenu() {
  contextMenu.value = null
}

function onActivityContextMenu(event: MouseEvent) {
  event.preventDefault()
  const { x, y } = clampToViewport(event.clientX, event.clientY, 176, 210)
  contextMenu.value = { x, y }
}

function onToggleItem(key: ActivityBarItem) {
  // 不关菜单:用户通常连续调多项
  editorStore.toggleActivityBarHidden(key)
}

function onResetActivityBar() {
  editorStore.resetActivityBar()
  closeContextMenu()
}

// ========== active 指示器滑动动效(参考 SettingsPage Tab 下划线) ==========
// 单一 accent 元素根据当前激活按钮的 DOM 位置(top)滑动,CSS transition 驱动平滑过渡。
const navRef = ref<HTMLElement | null>(null)
const accentTop = ref(0)
const accentVisible = ref(false)
const ACCENT_HEIGHT = 36

function updateAccent() {
  const nav = navRef.value
  const key = props.active
  if (!nav || !key) {
    accentVisible.value = false
    return
  }
  const el = nav.querySelector<HTMLElement>(`[data-activity-key="${key}"]`)
  if (!el) {
    accentVisible.value = false
    return
  }
  const navRect = nav.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  accentTop.value = elRect.top - navRect.top + (elRect.height - ACCENT_HEIGHT) / 2
  accentVisible.value = true
}

onMounted(() => {
  nextTick(() => updateAccent())
})
watch(() => props.active, () => {
  nextTick(() => updateAccent())
})
watch(() => editorStore.visibleActivityBarItems, () => {
  nextTick(() => updateAccent())
}, { deep: true })
</script>

<template>
  <nav
    ref="navRef"
    class="activity-bar relative flex w-11 shrink-0 flex-col items-center justify-between bg-[var(--surface-0)] py-2 text-gray-900 dark:text-gray-100"
    aria-label="功能栏"
    @contextmenu.prevent="onActivityContextMenu"
  >
    <span
      class="activity-bar__accent"
      :class="{ 'activity-bar__accent--visible': accentVisible }"
      :style="{ top: `${accentTop}px` }"
      aria-hidden="true"
    />
    <div class="flex flex-col items-center gap-1">
      <button
        v-for="item in editorStore.visibleActivityBarItems"
        :key="item"
        :data-activity-key="item"
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
      data-activity-key="settings"
      class="activity-bar__button"
      :class="{ 'activity-bar__button--active': active === 'settings' }"
      title="设置"
      aria-label="设置"
      :aria-pressed="active === 'settings'"
      @click="selectItem('settings')"
    >
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
  height: 40px;
  align-items: center;
  justify-content: center;
  border-radius: 13px;
  color: var(--chrome-text-secondary);
  transition:
    color 140ms ease,
    transform 140ms ease;
}

.activity-bar__button:hover {
  color: var(--chrome-text-primary);
}

:global(.dark .activity-bar__button:hover) {
  color: var(--chrome-text-primary);
}

.activity-bar__button:focus-visible {
  outline: 2px solid var(--md-primary-color, #1F71D9);
  outline-offset: 2px;
}

.activity-bar__button--active {
  color: var(--md-primary-color, #1F71D9);
}

.activity-bar__button--active:hover {
  color: var(--md-primary-color, #1F71D9);
}

/* active 左侧竖条指示器(单一共享元素,参考 SettingsPage Tab 下划线滑动):
 * 根据 active 按钮的 DOM 位置算 top,CSS transition 驱动滑动;
 * left:0 贴 nav 左缘;height 固定 20px 在按钮内垂直居中。 */
.activity-bar__accent {
  position: absolute;
  left: 0;
  width: 2px;
  height: 36px;
  border-radius: 1px;
  background: var(--md-primary-color, #1F71D9);
  opacity: 0;
  transition: top 200ms ease-out, opacity 140ms ease;
  pointer-events: none;
}

.activity-bar__accent--visible {
  opacity: 1;
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

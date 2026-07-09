<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { X, Plus } from '@lucide/vue'
import { useDocumentStore } from '@/stores/document'
import { useWorkspaceStore } from '@/stores/workspace'
import { writeClipboardText } from '@/utils/clipboard'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { message } from '@/tauri/dialog'
import { relativePathWithinRoot } from '@/utils/statusPath'
import { basename } from '@/components/Sidebar/treeUtils'
import { useContextMenu, clampToViewport } from '@/composables/useContextMenu'
import TabContextMenu from './TabContextMenu.vue'

const documentStore = useDocumentStore()
const workspaceStore = useWorkspaceStore()

const emit = defineEmits<{
  /** 在文件树中高亮并定位到当前标签对应的文件 —— App.vue 拼装
   *  showSidebarTab('files') + sidebarRef.revealFile(path)。TabBar 不持有
   *  sidebarRef,emit 上去由 App.vue 持有侧栏引用。 */
  (e: 'reveal-in-tree', path: string): void
}>()

async function onClose(id: string) {
  await documentStore.closeTab(id)
}

// ===== 拖拽重排(v0.6.x) =====
const draggingId = ref<string | null>(null)
const dropTarget = ref<{ tabId: string, side: 'before' | 'after' } | null>(null)

function onDragStart(event: DragEvent, id: string) {
  if (!event.dataTransfer) return
  // 拖拽源关掉可能挂着的菜单 —— 否则拖拽中途菜单残留,drop 时全局 pointerdown
  // 会把菜单误关闭后又冒出新菜单(FileTree 同款范式,见 file-tree.md)。
  closeContextMenu()
  event.dataTransfer.setData('application/x-velo-tab-id', id)
  event.dataTransfer.effectAllowed = 'move'
  draggingId.value = id
}

function onDragOver(event: DragEvent, tabId: string) {
  if (draggingId.value === null) return
  if (draggingId.value === tabId) {
    dropTarget.value = null
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const isAfter = event.clientX - rect.left > rect.width / 2
  if (isAfter) {
    const idx = documentStore.tabs.findIndex(t => t.id === tabId)
    const nextTab = documentStore.tabs[idx + 1]
    if (nextTab) {
      dropTarget.value = { tabId: nextTab.id, side: 'before' }
    }
    else {
      dropTarget.value = { tabId, side: 'after' }
    }
  }
  else {
    dropTarget.value = { tabId, side: 'before' }
  }
}

function onDragLeave(_tabId: string) {
  // 不可信:子元素冒泡也会触发 → 用 dragend 全局兜底清
}

function onTabDrop(event: DragEvent) {
  event.preventDefault()
  const fromId = draggingId.value
  const target = dropTarget.value
  if (fromId && target) {
    documentStore.reorderTabs(fromId, target.tabId, target.side)
  }
  resetDragState()
}

function onDragOverNewTab(event: DragEvent) {
  if (draggingId.value === null) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const tabs = documentStore.tabs
  const last = tabs[tabs.length - 1]
  if (last && last.id !== draggingId.value) {
    dropTarget.value = { tabId: last.id, side: 'after' }
  }
}

function onDropToEnd(event: DragEvent) {
  event.preventDefault()
  onTabDrop(event)
}

function onDragEnd() {
  resetDragState()
}

function resetDragState() {
  draggingId.value = null
  dropTarget.value = null
}

// ===== 右键菜单(v0.6.x) =====
//
// 走 useContextMenu composable 统一管「点外部关闭」+「Escape 关闭」的全局
// listener + 视口 clamp。菜单元件 (TabContextMenu.vue) 只负责展示与 emit。
// composable 不持有菜单状态——本组件自管 contextMenu ref（含 tabId + 坐标），
// 通过 isOpen / getMenuEl / close 三个 callback 与 composable 交互。

interface ContextMenuState {
  tabId: string
  /** 视口坐标 */
  x: number
  y: number
}

const contextMenu = ref<ContextMenuState | null>(null)
const contextMenuRef = ref<InstanceType<typeof TabContextMenu> | null>(null)

useContextMenu({
  isOpen: () => contextMenu.value !== null,
  getMenuEl: () => contextMenuRef.value?.rootEl ?? null,
  close: () => { contextMenu.value = null },
})

/** 触发菜单的 tab 元数据(同时算 currentFilePath / active / dirty / readOnly),
 *  给 TabContextMenu 用 —— store 没有暴露 DocState 的入口,这里从 tabs 列表推。 */
const tabMenuPayload = computed(() => {
  const cm = contextMenu.value
  if (!cm) return null
  const tab = documentStore.tabs.find(t => t.id === cm.tabId)
  if (!tab) return null
  return {
    tabId: tab.id,
    filePath: documentStore.documents.get(tab.id)?.currentFilePath ?? null,
    active: tab.active,
    dirty: tab.dirty,
    readOnly: tab.readOnlyLocked,
    activeRoot: workspaceStore.activeRoot,
  }
})

/** 当前右键 tab 在 tabs 列表的索引(用于「关闭右侧」项的可见性)。 */
const tabMenuIndex = computed(() => {
  const cm = contextMenu.value
  if (!cm) return -1
  return documentStore.tabs.findIndex(t => t.id === cm.tabId)
})

function closeContextMenu() {
  contextMenu.value = null
}

function onTabContextMenu(event: MouseEvent, tabId: string) {
  event.preventDefault()
  const { x, y } = clampToViewport(event.clientX, event.clientY, 192, 320)
  contextMenu.value = { tabId, x, y }
}

// —— 菜单动作 ——

async function onCloseThis() {
  const id = contextMenu.value?.tabId
  closeContextMenu()
  if (id) await documentStore.closeTab(id)
}

async function onCloseOthers() {
  const id = contextMenu.value?.tabId
  closeContextMenu()
  if (id) await documentStore.closeOtherTabs(id)
}

async function onCloseRight() {
  const id = contextMenu.value?.tabId
  closeContextMenu()
  if (id) await documentStore.closeTabsToRight(id)
}

function onCloseSaved() {
  documentStore.closeSavedTabs()
  closeContextMenu()
}

async function onCloseAll() {
  closeContextMenu()
  await documentStore.closeAllTabs()
}

async function onSave() {
  const id = contextMenu.value?.tabId
  closeContextMenu()
  if (id) await documentStore.saveTabById(id)
}

function currentFilePath(): string | null {
  const id = contextMenu.value?.tabId
  if (!id) return null
  return documentStore.documents.get(id)?.currentFilePath ?? null
}

async function copyToClipboardWithToast(text: string, what: string) {
  const ok = await writeClipboardText(text)
  if (!ok) {
    // 写不进剪贴板时给个原生 message(没 toast 系统);静默吞则用户以为复制了
    await message(`复制${what}失败,请检查剪贴板权限`, { title: '复制失败', kind: 'error' })
  }
  closeContextMenu()
}

function onCopyPath() {
  const p = currentFilePath()
  if (!p) return
  void copyToClipboardWithToast(p, '路径')
}

function onCopyFilename() {
  const p = currentFilePath()
  if (!p) return
  void copyToClipboardWithToast(basename(p), '文件名')
}

function onCopyRelativePath() {
  const p = currentFilePath()
  if (!p) return
  void copyToClipboardWithToast(relativePathWithinRoot(p, workspaceStore.activeRoot) ?? basename(p), '相对路径')
}

function onRevealInTree() {
  const p = currentFilePath()
  closeContextMenu()
  if (p) emit('reveal-in-tree', p)
}

async function onRevealInExplorer() {
  const p = currentFilePath()
  closeContextMenu()
  if (!p) return
  try {
    await revealItemInDir(p)
  }
  catch {
    await message('打开文件管理器失败', { title: '操作失败', kind: 'error' })
  }
}

// 拖拽兜底:tab row 的 @dragend 可能丢,文档级 dragend 保险清拖拽状态。
// 菜单的全局 listener 已由 useContextMenu 管理,这里只管 dragend。
function onGlobalDragEnd() {
  resetDragState()
}

onMounted(() => {
  document.addEventListener('dragend', onGlobalDragEnd)
})

onBeforeUnmount(() => {
  document.removeEventListener('dragend', onGlobalDragEnd)
})
</script>

<template>
  <div class="flex h-full min-w-0 flex-1 items-stretch pl-1 border-b border-gray-200 dark:border-gray-800">
    <div class="tab-bar flex min-w-0 items-end">
      <div
        v-for="(tab, i) in documentStore.tabs"
        :key="tab.id"
        class="tab group"
        :class="{
          'tab-active': tab.active,
          'tab-divider': i > 0 && !tab.active && !documentStore.tabs[i - 1].active,
          'tab-divider-right': i === documentStore.tabs.length - 1 && !tab.active,
          'tab-dragging': draggingId === tab.id,
          'tab-drop-before': dropTarget?.tabId === tab.id && dropTarget.side === 'before',
          'tab-drop-after': dropTarget?.tabId === tab.id && dropTarget.side === 'after',
        }"
        role="tab"
        :aria-selected="tab.active"
        :title="tab.fileName + (tab.dirty ? ' •' : '')"
        tabindex="0"
        draggable="true"
        @click="documentStore.switchTab(tab.id)"
        @auxclick.middle.prevent="onClose(tab.id)"
        @keydown.enter="documentStore.switchTab(tab.id)"
        @dragstart="onDragStart($event, tab.id)"
        @dragover="onDragOver($event, tab.id)"
        @dragleave="onDragLeave(tab.id)"
        @drop="onTabDrop($event)"
        @dragend="onDragEnd"
        @contextmenu.prevent="onTabContextMenu($event, tab.id)"
      >
        <div class="tab-content flex w-full items-center gap-1">
          <span class="tab-dot" :class="{ 'tab-dot-on': tab.dirty }" />
          <span class="tab-title">{{ tab.fileName }}</span>
          <button
            type="button"
            class="tab-close"
            :title="`关闭 ${tab.fileName}`"
            @click.stop="onClose(tab.id)"
          >
          <X :size="13" />
          </button>
        </div>
      </div>

      <button
        type="button"
        class="tab-new"
        title="新标签 (Ctrl+N)"
        @click="documentStore.newDoc()"
        @dragover="onDragOverNewTab"
        @drop="onDropToEnd"
      >
        <Plus :size="15" />
      </button>
    </div>
    <!-- 拖拽区(填满标签右侧空白);标签溢出时缩到 0 -->
    <span data-tauri-drag-region class="flex-1" />
  </div>

  <!-- 右键菜单(Teleport 在子组件内)。 -->
  <TabContextMenu
    v-if="contextMenu && tabMenuPayload"
    ref="contextMenuRef"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :total-tabs="documentStore.tabs.length"
    :tab-index="tabMenuIndex"
    :tab="tabMenuPayload"
    @close="onCloseThis"
    @close-others="onCloseOthers"
    @close-right="onCloseRight"
    @close-saved="onCloseSaved"
    @close-all="onCloseAll"
    @save="onSave"
    @copy-path="onCopyPath"
    @copy-filename="onCopyFilename"
    @copy-relative-path="onCopyRelativePath"
    @reveal-in-tree="onRevealInTree"
    @reveal-in-explorer="onRevealInExplorer"
  />
</template>

<style scoped lang="scss">

/* 默认宽 200px;溢出时 flex-shrink 等等比压缩至 min-width 80px。
 * 非活动标签无边框,仅相邻两个非活动标签之间用竖线分隔(类右上角三件套)。
 * hover 高亮落在内层 .tab-content(.tab 留 2px padding 作间隔,呈内嵌灰块);
 * 活动标签 bg 在 .tab 上铺满到底,与编辑器衔接。 */
.tab {
  position: relative;
  display: inline-flex;
  height: 32px;
  padding: 2px 4px;
  flex: 0 1 auto;
  width: 200px;
  min-width: 80px;
  border: 1px solid transparent;
  background: transparent;
  color: rgb(107 114 128);
  user-select: none;

  &:not(.tab-active):hover .tab-content {
    background: rgb(229 231 235);
    color: rgb(55 65 81);
  }

  &::before,
  &::after {
    content: '';
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 1px;
    height: calc(var(--spacing) * 5);
    border-radius: 1px;
    background: transparent;
    pointer-events: none;
  }
  &::before { left: 0; }
  &::after { right: 0; }
  &.tab-divider::before,
  &.tab-divider-right::after {
    background: rgb(229 231 235);
  }

  &.tab-active {
    background: #fff;
    color: rgb(31 41 55);
    border-color: rgb(229 231 235);
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    border-bottom-color: #fff;
    transition: none;
  }

  &.tab-dragging {
    opacity: 0.5;
  }

  &.tab-drop-before::before,
  &.tab-drop-after::after {
    background: rgb(59 130 246);
    width: 2px;
  }

}

.tab-content {
  padding: 0 0.5rem;
  border-radius: 6px;
  transition: background-color 100ms ease;
}

.tab-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: transparent;
  &.tab-dot-on {
    background: rgb(245 158 11);
  }
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: inherit;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 100ms ease, background-color 100ms ease;
}
.tab:hover .tab-close,
.tab-active .tab-close {
  opacity: 0.6;
}
.tab-close:hover {
  opacity: 1 !important;
  background: rgb(229 231 235);
}

.tab-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  margin-left: 4px;
  margin-bottom: 4px;
  color: rgb(156 163 175);
  border-radius: 4px;
  transition: background-color 100ms ease, color 100ms ease;
  &:hover {
    background: rgb(243 244 246);
    color: rgb(55 65 81);
  }
}

.dark .tab {
  color: rgb(156 163 175);
  &:not(.tab-active):hover .tab-content {
    background: rgb(38 38 38);
    color: rgb(209 213 219);
  }
  &.tab-divider::before,
  &.tab-divider-right::after {
    background: rgb(55 65 81);
  }
  &.tab-drop-before::before,
  &.tab-drop-after::after {
    background: rgb(96 165 250);
  }
  &.tab-active {
    background: #1e1e1e;
    color: rgb(229 231 235);
    border-color: rgb(31 41 55);
    border-bottom-color: #1e1e1e;
  }
}
.dark .tab-close:hover {
  background: rgb(55 65 81);
}
.dark .tab-dot-on {
  background: rgb(251 191 36);
}
.dark .tab-new:hover {
  background: rgb(38 38 38);
  color: rgb(209 213 219);
}
</style>

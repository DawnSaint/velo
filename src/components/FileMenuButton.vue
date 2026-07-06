<script setup lang="ts">
// 「文件」下拉面板(v0.6.x):
//  - 收纳原侧栏 FileActionsPanel 命令入口 + 原顶栏 RecentFilesButton + 开发
//    模式欢迎按钮,统一暴露为单个面板触发器。视觉与 TabContextMenu /
//    FileTreeContextMenu 对齐(同 min-w-48 / 圆角白底 / dark:bg-gray-800 /
//    hover:bg-gray-100 / dark:hover:bg-gray-700);不抽通用 ContextMenu 组件 —
//    这里多带 shortcut、子菜单展开与外部触发器范式,与右键菜单的"是否显示
//    某项"分支逻辑不重合,合并会让判断散到调用方。
//  - 触发器:通过 `#trigger` 插槽由调用方提供(顶栏用紧凑图标按钮,ActivityBar
//    用 38×42 主色块按钮),FileMenuButton 只管面板状态 / 定位 / 关闭。
//    触发器 button 通过 slot scope 的 `registerRef(el)` 把元素喂回来,菜单
//    定位时读它的 getBoundingClientRect —— 与 FileMenuButton 自管按钮时同
//    一套视口 clamp 算法。
//  - 子菜单:「最近文件」条目右侧挂 ChevronRight;点击展开右侧第二面板,
//    展示 basename + 路径两行卡片(同 RecentFilesButton) + 空态。子菜单
//    位置 = 主菜单右缘 + 4px,顶对齐。
//  - 关闭:全局 pointerdown(走 `closest('[data-file-menu], [data-file-menu-panel]')`
//    排除内部)+ Escape(先关子菜单再关主菜单)。两个 Teleport 面板共享
//    `data-file-menu-panel` 标记;主按钮若走默认 slot 也自带 `data-file-menu`。
//  - 事件定义与 FileActionsPanel 对齐(emit 名一一对应),App.vue 接管
//    原本挂在 FileActionsPanel / RecentFilesButton / dev 欢迎按钮上的同一
//    批 handler。

import { computed, nextTick, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { File, ChevronRight, Check } from '@lucide/vue'
import { basenameOfPath, normalizeDisplayPath } from '@/utils/statusPath'
import type { RecentFileEntry } from '@/stores/persistence'

type FileActionEvent = 'new-doc' | 'new-window' | 'open-file' | 'open-folder' | 'save' | 'save-as' | 'export' | 'toggle-always-on-top'

interface FileActionRow {
  key: string
  label: string
  shortcut: string
  event: FileActionEvent
  disabled?: boolean
  /** 勾选态(toggle 项):true 时右侧显示 Check 图标代替 shortcut badge */
  checked?: boolean
}

const SUBMENU_GAP = 4
const SUBMENU_LIMIT = 12

const props = defineProps<{
  isTauri: boolean
  exporting: boolean
  /** 顶栏全局最近文件列表(由 recentFilesStore.entries 传入) */
  recentEntries: RecentFileEntry[]
  /** true 时显示「欢迎」入口 —— 仅开发模式需要(用于重看欢迎对话框) */
  welcomeEnabled: boolean
  /** 窗口置顶态(toggle 项勾选指示) */
  alwaysOnTop: boolean
}>()

const emit = defineEmits<{
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
}>()

const open = ref(false)
const submenu = ref<'recent' | null>(null)
/** 触发器元素 —— 由 #trigger 插槽通过 registerRef 喂回(也兼容默认按钮)。 */
const buttonRef = ref<HTMLElement | null>(null)
/** 主菜单 DOM 引用 —— 子菜单定位时拿它的右缘 + 顶 y。 */
const menuRef = ref<HTMLDivElement | null>(null)
/** 视口坐标,由 open 变 true 后 nextTick 算(等按钮稳定在 DOM 上)。
 *  与 TabContextMenu 的 x/y 同款:用 fixed 定位避开 overflow 容器,
 *  贴边留 8px 安全距 clamp。 */
const menuPos = ref<{ x: number, y: number, width: number, height: number } | null>(null)
/** 子菜单视口坐标;子菜单 y 与主菜单顶对齐,贴右/下 clamp。 */
const submenuPos = ref<{ x: number, y: number, height: number } | null>(null)

const groups = computed<{ rows: FileActionRow[] }[]>(() => {
  return [
    {
      rows: [
        { key: 'new-doc', label: '新建文件', shortcut: 'Ctrl+N', event: 'new-doc' },
        ...(props.isTauri
          ? [{ key: 'new-window', label: '新窗口', shortcut: 'Ctrl+Shift+N', event: 'new-window' as FileActionEvent }]
          : []),
      ],
    },
    {
      rows: [
        { key: 'open-file', label: '打开文件', shortcut: 'Ctrl+O', event: 'open-file' },
        { key: 'open-folder', label: '打开文件夹', shortcut: '—', event: 'open-folder' },
      ],
    },
    {
      rows: [
        // 「最近文件」是子菜单入口(右侧 ChevronRight);不直接 emit,点击/hover 展开
        // 右侧第二面板(见 handleRecentEntry)。shell 与其它 row 共享一组样式。
        { key: 'recent', label: '最近文件', shortcut: '', event: 'export', disabled: false },
      ],
    },
    {
      rows: [
        { key: 'save', label: '保存', shortcut: 'Ctrl+S', event: 'save' },
        { key: 'save-as', label: '另存为', shortcut: 'Ctrl+Shift+S', event: 'save-as' },
        { key: 'export', label: props.exporting ? '导出中…' : '导出', shortcut: 'Ctrl+Shift+E', event: 'export', disabled: props.exporting },
      ],
    },
    // 窗口级 toggle 项:勾选态由 props.alwaysOnTop 驱动,右侧显示 Check 代替 shortcut
    ...(props.isTauri
      ? [{
          rows: [
            { key: 'always-on-top', label: '保持窗口最前', shortcut: '', event: 'toggle-always-on-top' as FileActionEvent, checked: props.alwaysOnTop },
          ],
        }]
      : []),
    ...(props.welcomeEnabled
      ? [{
          rows: [
            { key: 'welcome', label: '欢迎对话框', shortcut: '', event: 'export' as FileActionEvent, disabled: false },
          ],
        }]
      : []),
  ]
})

const visibleRecent = computed(() => props.recentEntries.slice(0, SUBMENU_LIMIT))

/** 触发器元素 callback ref —— 插槽里的按钮 :ref 调它,
 *  FileMenuButton 拿它做菜单定位。允许 null(组件 unmount 时清理)。 */
function registerRef(el: Element | ComponentPublicInstance | null) {
  buttonRef.value = (el as HTMLElement | null) ?? null
}

function closeAll() {
  open.value = false
  submenu.value = null
}

async function toggleMenu() {
  if (open.value) {
    closeAll()
    return
  }
  submenu.value = null
  open.value = true
  await nextTick()
  recomputeMenuPos()
}

async function recomputeMenuPos() {
  const btn = buttonRef.value
  if (!btn) {
    menuPos.value = null
    return
  }
  const rect = btn.getBoundingClientRect()
  // 等 menuRef 真实 DOM 挂上后再算偏移 —— 占位宽算出来的 x 在真实窄菜单下
  // 会偏左不够贴右。
  await nextTick()
  const menuEl = menuRef.value
  const w = menuEl ? menuEl.getBoundingClientRect().width : 240
  const h = menuEl ? menuEl.getBoundingClientRect().height : 480
  // 展开方向(用户偏好):**主菜单左边界贴 ActivityBar 的 `border-right` 那条 1px
  // 边线** (= rect.right,0 gap),视觉上像从 ActivityBar "吐"出来的一片 panel,
  // 与下方"按钮底下展开"的旧版不同 —— 38×42 这种窄按钮向下展开会
  // 跟按钮脱离,语义错位。+4 gap 也算脱离,现在 0 gap 让两者**完全重合**。
  // y 与触发器顶部对齐(rect.top),因为这是水平 popover,不需要垂直留缝。
  // 子菜单位置仍走 (main.x + main.width + SUBMENU_GAP) 留在主菜单右侧并留 4px gap,
  // 形成"主菜单贴 ActivityBar 右 border / 子菜单离主菜单"的视觉层次。
  menuPos.value = {
    x: Math.min(rect.right, window.innerWidth - w - 8),
    y: Math.min(rect.top, window.innerHeight - h - 8),
    width: w,
    height: h,
  }
}

async function openRecentSubmenu() {
  submenu.value = 'recent'
  await nextTick()
  computeSubmenuPos()
}

function computeSubmenuPos() {
  const main = menuPos.value
  if (!main) return
  const SUBMENU_W = 320
  const SUBMENU_H_MAX = 360
  // 子菜单水平:贴主菜单右缘 + gap,贴右 clamp;竖直:与主菜单顶对齐,贴下 clamp
  const x = Math.min(main.x + main.width + SUBMENU_GAP, window.innerWidth - SUBMENU_W - 8)
  const y = Math.min(main.y, window.innerHeight - SUBMENU_H_MAX - 8)
  const subEl = document.querySelector('[data-file-menu-panel="recent"]') as HTMLElement | null
  const h = subEl ? subEl.getBoundingClientRect().height : SUBMENU_H_MAX
  submenuPos.value = { x, y, height: h }
}

function emitAction(row: FileActionRow) {
  if (row.disabled) return
  if (row.key === 'recent') return // 子菜单入口,不应走 emitAction
  if (row.key === 'welcome') {
    emit('open-welcome')
    closeAll()
    return
  }
  if (row.event === 'new-doc') emit('new-doc')
  else if (row.event === 'new-window') emit('new-window')
  else if (row.event === 'open-file') emit('open-file')
  else if (row.event === 'open-folder') emit('open-folder')
  else if (row.event === 'save') emit('save')
  else if (row.event === 'save-as') emit('save-as')
  else if (row.event === 'export') emit('export')
  else if (row.event === 'toggle-always-on-top') emit('toggle-always-on-top')
  closeAll()
}

function openRecent(path: string) {
  emit('open-recent', path)
  closeAll()
}

// —— 全局 listener:点外部关闭 + Escape 关闭 ——
function onRootPointerDown(event: PointerEvent) {
  if (!open.value) return
  const target = event.target as HTMLElement | null
  if (!target) return
  // 主按钮在原生 wrapper(自带 data-file-menu),Teleport 后的两个面板共享
  // `data-file-menu-panel`,任一命中都不关闭。
  if (target.closest('[data-file-menu], [data-file-menu-panel]')) return
  closeAll()
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !open.value) return
  // Escape:先关子菜单(若开),否则关主菜单
  if (submenu.value) {
    submenu.value = null
    submenuPos.value = null
  }
  else {
    closeAll()
  }
}

document.addEventListener('pointerdown', onRootPointerDown)
document.addEventListener('keydown', onKeyDown)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onRootPointerDown)
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="relative" data-file-menu>
    <!-- 触发器:由调用方决定视觉(顶栏紧凑图标 / ActivityBar 主色块)。
         slot scope 把 open / toggle / registerRef 暴露出去;
         调用方在自己的 button 上 :ref="registerRef",菜单定位走该元素。 -->
    <slot name="trigger" :open="open" :toggle="toggleMenu" :register-ref="registerRef">
      <button
        :ref="registerRef"
        type="button"
        class="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        title="文件"
        aria-label="文件"
        aria-haspopup="menu"
        :aria-expanded="open"
        @click="toggleMenu"
      >
        <File :size="16" aria-hidden="true" />
      </button>
    </slot>

    <Teleport to="body">
      <!-- 主菜单 -->
      <div
        v-if="open && menuPos"
        ref="menuRef"
        data-file-menu-panel="main"
        class="velo-file-menu fixed z-50 min-w-48 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800 dark:text-gray-200"
        :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
        role="menu"
        @contextmenu.prevent
      >
        <template v-for="(group, groupIndex) in groups" :key="groupIndex">
          <div
            v-if="groupIndex > 0"
            class="my-1 border-t border-gray-100 dark:border-gray-700"
          />
          <button
            v-for="row in group.rows"
            :key="row.key"
            type="button"
            class="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-700"
            :class="{ 'velo-file-menu-recent-active': row.key === 'recent' && submenu === 'recent' }"
            :disabled="row.disabled"
            :aria-label="row.label"
            :aria-haspopup="row.key === 'recent' ? 'menu' : undefined"
            role="menuitem"
            @click="row.key === 'recent' ? openRecentSubmenu() : emitAction(row)"
          >
            <span class="min-w-0 flex-1 truncate font-medium">{{ row.label }}</span>
            <ChevronRight
              v-if="row.key === 'recent'"
              :size="12"
              class="shrink-0 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
            <Check
              v-else-if="row.checked"
              :size="14"
              class="shrink-0 text-gray-500 dark:text-gray-400"
              aria-hidden="true"
            />
            <span
              v-else-if="row.shortcut"
              class="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-400 dark:bg-gray-700 dark:text-gray-500"
            >{{ row.shortcut }}</span>
          </button>
        </template>
      </div>

      <!-- 子菜单:最近文件 -->
      <div
        v-if="open && submenu === 'recent' && submenuPos"
        data-file-menu-panel="recent"
        class="velo-file-menu-submenu fixed z-50 w-80 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 text-xs text-gray-600 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
        :style="{ left: `${submenuPos.x}px`, top: `${submenuPos.y}px` }"
        role="menu"
        aria-label="最近文件"
        @contextmenu.prevent
      >
        <div class="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
          最近文件
        </div>
        <div v-if="visibleRecent.length" class="max-h-80 overflow-auto pb-1">
          <button
            v-for="entry in visibleRecent"
            :key="entry.path"
            type="button"
            class="mx-1 flex w-[calc(100%-0.5rem)] flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-gray-700"
            :title="normalizeDisplayPath(entry.path)"
            role="menuitem"
            @click="openRecent(entry.path)"
          >
            <span class="truncate font-medium text-gray-700 dark:text-gray-100">{{ basenameOfPath(entry.path) }}</span>
            <span class="truncate text-[11px] text-gray-400 dark:text-gray-500">{{ normalizeDisplayPath(entry.path) }}</span>
          </button>
        </div>
        <div v-else class="px-3 py-3 text-gray-400 dark:text-gray-500">
          暂无最近文件
        </div>
      </div>
    </Teleport>
  </div>
</template>
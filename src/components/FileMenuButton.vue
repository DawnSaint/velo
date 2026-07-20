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

type FileActionEvent = 'new-doc' | 'new-window' | 'open-file' | 'open-folder' | 'save' | 'save-as' | 'export' | 'toggle-always-on-top' | 'toggle-focus-mode' | 'toggle-typewriter-mode'

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
  /** 窗口置顶态(toggle 项勾选指示) */
  alwaysOnTop: boolean
  /** 专注模式态(toggle 项勾选指示) */
  focusMode: boolean
  /** 打字机模式态(toggle 项勾选指示) */
  typewriterMode: boolean
  /** 是否有活动文档(设置页 / 空页面时为 false,隐藏保存 / 另存为 / 导出) */
  hasDocument: boolean
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
  'toggle-always-on-top': []
  'toggle-focus-mode': []
  'toggle-typewriter-mode': []
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
        { key: 'open-folder', label: '打开文件夹', shortcut: '', event: 'open-folder' },
      ],
    },
    {
      rows: [
        // 「最近文件」是子菜单入口(右侧 ChevronRight);不直接 emit,点击/hover 展开
        // 右侧第二面板(见 handleRecentEntry)。shell 与其它 row 共享一组样式。
        { key: 'recent', label: '最近文件', shortcut: '', event: 'export', disabled: false },
      ],
    },
    // 保存 / 另存为 / 导出:仅在有活动文档时显示(设置页 / 空页面隐藏)
    ...(props.hasDocument
      ? [{
          rows: [
            { key: 'save', label: '保存', shortcut: 'Ctrl+S', event: 'save' as FileActionEvent },
            { key: 'save-as', label: '另存为', shortcut: 'Ctrl+Shift+S', event: 'save-as' as FileActionEvent },
            { key: 'export', label: props.exporting ? '导出中…' : '导出', shortcut: 'Ctrl+Shift+E', event: 'export' as FileActionEvent, disabled: props.exporting },
          ],
        }]
      : []),
    // 窗口级 toggle 项:勾选态由 props 驱动,右侧显示 Check 代替 shortcut
    {
      rows: [
        { key: 'focus-mode', label: '专注模式', shortcut: 'F8', event: 'toggle-focus-mode', checked: props.focusMode },
        { key: 'typewriter-mode', label: '打字机模式', shortcut: 'F9', event: 'toggle-typewriter-mode', checked: props.typewriterMode },
        ...(props.isTauri
          ? [{ key: 'always-on-top', label: '保持窗口最前', shortcut: '', event: 'toggle-always-on-top' as FileActionEvent, checked: props.alwaysOnTop }]
          : []),
      ],
    },
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
  // 模板 v-if="open && menuPos" 造成循环依赖:menuPos 为 null 时菜单 DOM 不渲染,
  // menuRef 拿不到。先用 fallback 尺寸设置 menuPos 让菜单挂载,再 nextTick
  // 读真实宽高修正 x/y(贴右/贴下 clamp 依赖真实宽高)。
  menuPos.value = {
    x: Math.min(rect.left, window.innerWidth - 240 - 8),
    y: Math.min(rect.bottom, window.innerHeight - 480 - 8),
    width: 240,
    height: 480,
  }
  await nextTick()
  const menuEl = menuRef.value
  if (!menuEl) return
  const w = menuEl.getBoundingClientRect().width
  const h = menuEl.getBoundingClientRect().height
  // 展开方向:触发器现在是顶栏左上角的向下箭头按钮,主菜单从按钮**正下方**
  // 展开 —— 左边界贴触发器左缘(rect.left),顶边贴触发器底缘(rect.bottom),
  // 语义与"向下箭头"一致。贴右/贴下留 8px 安全距 clamp。
  menuPos.value = {
    x: Math.min(rect.left, window.innerWidth - w - 8),
    y: Math.min(rect.bottom, window.innerHeight - h - 8),
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
  // 直接读主菜单 DOM 实际宽度,而非 menuPos.width —— recomputeMenuPos 虽已两阶段
  // 修正,但它是 async 且 toggleMenu 未 await,极端快速操作下 menuPos.width 可能
  // 仍是 fallback 240(实际 min-w-48=192),导致子菜单与主菜单间出现 ~48px 间距。
  const menuEl = menuRef.value
  const mainW = menuEl ? menuEl.getBoundingClientRect().width : main.width
  // 子菜单水平:贴主菜单右缘 + gap,贴右 clamp;竖直:与主菜单顶对齐,贴下 clamp
  const x = Math.min(main.x + mainW + SUBMENU_GAP, window.innerWidth - SUBMENU_W - 8)
  const y = Math.min(main.y, window.innerHeight - SUBMENU_H_MAX - 8)
  const subEl = document.querySelector('[data-file-menu-panel="recent"]') as HTMLElement | null
  const h = subEl ? subEl.getBoundingClientRect().height : SUBMENU_H_MAX
  submenuPos.value = { x, y, height: h }
}

function emitAction(row: FileActionRow) {
  if (row.disabled) return
  if (row.key === 'recent') return // 子菜单入口,不应走 emitAction
  if (row.event === 'new-doc') emit('new-doc')
  else if (row.event === 'new-window') emit('new-window')
  else if (row.event === 'open-file') emit('open-file')
  else if (row.event === 'open-folder') emit('open-folder')
  else if (row.event === 'save') emit('save')
  else if (row.event === 'save-as') emit('save-as')
  else if (row.event === 'export') emit('export')
  else if (row.event === 'toggle-always-on-top') emit('toggle-always-on-top')
  else if (row.event === 'toggle-focus-mode') emit('toggle-focus-mode')
  else if (row.event === 'toggle-typewriter-mode') emit('toggle-typewriter-mode')
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
      <Transition name="velo-file-menu-slide">
        <div
          v-if="open && menuPos"
          ref="menuRef"
          data-file-menu-panel="main"
          class="velo-file-menu fixed z-50 min-w-48 border border-gray-200 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
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
      </Transition>

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

<style scoped>
.velo-file-menu-slide-enter-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top center;
}
.velo-file-menu-slide-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
  transform-origin: top center;
}
.velo-file-menu-slide-enter-from,
.velo-file-menu-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
<script setup lang="ts">
// 标签条右键菜单(v0.6.x):
//  - 壳走 ContextMenuShell(Teleport + 定位 + 壳样式统一)，菜单项走
//    .ctx-menu-item / .ctx-menu-separator 全局 class(见 _context-menu.scss)。
//  - 「是否显示」分支:未命名标签(sample / 空白)没有 currentFilePath → 文件相关项
//    全部隐藏;"在文件树中显示"额外要求 activeRoot 下,避免指向不可见子树。
//  - 父子责任:菜单内部不挂全局监听器,由父级(TabBar)通过 useContextMenu
//    composable 统一管。rootEl 通过 defineExpose 暴露给 composable 的
//    getMenuEl callback 判定"点内部不关闭"。
//  - 「关闭其他 / 全部关闭 / 关闭右侧」的脏盘确认由 documentStore 复用 closeTab
//    处理,组件内不再二次 confirm。

import { computed, ref } from 'vue'
import ContextMenuShell from './ContextMenuShell.vue'

interface TabMenuPayload {
  /** 触发菜单的 tab id */
  tabId: string
  /** 标签关联的文件全路径(未命名 / sample 标签 = null) */
  filePath: string | null
  /** 是否当前活动标签 */
  active: boolean
  /** 是否脏盘 */
  dirty: boolean
  /** 是否只读(sample / 锁住的) */
  readOnly: boolean
  /** 工作区根路径(用于判定「在文件树中显示」是否可达) */
  activeRoot: string | null
}

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y) */
  x: number
  y: number
  /** 当前打开的 tab 总数(用于决定"关闭"/"关闭其他"等项是否可点) */
  totalTabs: number
  /** 右键命中的 tab 在当前 tabs 列表里的索引(用于「关闭右侧」项的可见性) */
  tabIndex: number
  tab: TabMenuPayload
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'close-others'): void
  (e: 'close-right'): void
  (e: 'close-saved'): void
  (e: 'close-all'): void
  (e: 'save'): void
  (e: 'copy-path'): void
  (e: 'copy-filename'): void
  (e: 'copy-relative-path'): void
  (e: 'reveal-in-tree'): void
  (e: 'reveal-in-explorer'): void
}>()

/** 关闭当前 tab:总数 1 时仍允许(关闭后进入"无 tab"空态)。 */
const showClose = computed(() => true)
/** 关闭其他:总数 ≤ 1 时无意义,灰掉。 */
const showCloseOthers = computed(() => props.totalTabs > 1)
/** 关闭右侧:不是最后一个 tab 才显示。 */
const showCloseRight = computed(() => props.tabIndex < props.totalTabs - 1)
/** 关闭已保存:始终显示(0 个非 dirty 时菜单项仍可点,no-op 由 store 兜底)。 */
const showCloseSaved = computed(() => true)
/** 全部关闭:总数 ≥ 1 时可点。 */
const showCloseAll = computed(() => props.totalTabs > 0)
/** 保存:仅 dirty + 非只读。 */
const showSave = computed(() => props.tab.dirty && !props.tab.readOnly)

/** 文件路径相关:必须有 currentFilePath(未命名 / sample 一律隐藏)。 */
const hasFile = computed(() => !!props.tab.filePath)
/** 文件路径是否落在当前工作区根下(用于"在文件树中显示"可见性)。 */
const isInActiveRoot = computed(() => {
  const p = props.tab.filePath
  const r = props.tab.activeRoot
  if (!p || !r) return false
  return p === r || p.startsWith(r + '/') || p.startsWith(r + '\\')
})

/** 父组件(用 defineExpose)拿这个 ref 给 useContextMenu 的 getMenuEl callback。
 *  ContextMenuShell 是组件,ref 拿到的是组件实例;通过 computed 从实例的 rootEl
 *  取出真正的 DOM 元素。 */
const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })
</script>

<template>
  <ContextMenuShell :x="x" :y="y" ref="shellRef">
    <!-- 关闭组:关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭 / 保存 -->
    <button v-if="showClose" class="ctx-menu-item" data-testid="tab-ctx-close" @click="emit('close')">
      关闭
    </button>
    <button v-if="showCloseOthers" class="ctx-menu-item" data-testid="tab-ctx-close-others" @click="emit('close-others')">
      关闭其他
    </button>
    <button v-if="showCloseRight" class="ctx-menu-item" data-testid="tab-ctx-close-right" @click="emit('close-right')">
      关闭右侧
    </button>
    <button v-if="showCloseSaved" class="ctx-menu-item" data-testid="tab-ctx-close-saved" @click="emit('close-saved')">
      关闭已保存
    </button>
    <button v-if="showCloseAll" class="ctx-menu-item" data-testid="tab-ctx-close-all" @click="emit('close-all')">
      全部关闭
    </button>
    <button v-if="showSave" class="ctx-menu-item" data-testid="tab-ctx-save" @click="emit('save')">
      保存
    </button>

    <template v-if="hasFile">
      <div class="ctx-menu-separator" />

      <!-- 复制组:复制路径 / 复制文件名 / 复制相对路径 -->
      <button class="ctx-menu-item" data-testid="tab-ctx-copy-path" @click="emit('copy-path')">
        复制路径
      </button>
      <button class="ctx-menu-item" data-testid="tab-ctx-copy-filename" @click="emit('copy-filename')">
        复制文件名
      </button>
      <button v-if="isInActiveRoot" class="ctx-menu-item" data-testid="tab-ctx-copy-relative" @click="emit('copy-relative-path')">
        复制相对路径
      </button>

      <div class="ctx-menu-separator" />

      <!-- 树 / 资源管理器组 -->
      <button v-if="isInActiveRoot" class="ctx-menu-item" data-testid="tab-ctx-reveal-in-tree" @click="emit('reveal-in-tree')">
        在文件树中显示
      </button>
      <button class="ctx-menu-item" data-testid="tab-ctx-reveal-in-explorer" @click="emit('reveal-in-explorer')">
        在资源管理器中显示
      </button>
    </template>
  </ContextMenuShell>
</template>

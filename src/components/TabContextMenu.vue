<script setup lang="ts">
// 标签条右键菜单(v0.6.x):
//  - 视觉与 FileTreeContextMenu.vue 完全一致(同 min-w / padding / hover / separator
//    / dark mode),不抽通用组件 —— FileTree 的菜单有按 isDir / MD 扩展名分支的项,
//    强行抽成数据驱动会让"是否显示"的计算散到调用方,得不偿失。
//  - 单实例菜单:父组件(TabBar)记 tabId + 坐标,Teleport 到 body 后位置定位;
//    父级挂全局 pointerdown / Escape handler 关闭,组件本身只 emit。
//  - 「是否显示」分支:未命名标签(sample / 空白)没有 currentFilePath → 文件相关项
//    全部隐藏;"在文件树中显示"额外要求 activeRoot 下,避免指向不可见子树。
//
// 设计要点(踩坑预防,写在这里方便后人):
//  - 父子责任:菜单内部不挂全局监听器,全局 listener 由 TabBar 统一挂 / 卸,
//    与 FileTree 同款范式。这样 keep-alive / 切页签 不会留下幽灵监听。
//  - rootEl 通过 defineExpose 暴露,父级拿它判定"点内部不关闭";菜单元件自管
//    @contextmenu.prevent 拦截右键二次弹菜单。
//  - 「关闭其他 / 全部关闭 / 关闭右侧」的脏盘确认由 documentStore 复用 closeTab
//    处理,组件内不再二次 confirm。

import { computed } from 'vue'
import { ref } from 'vue'

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

/** 父组件(用 defineExpose)拿这个 ref 给全局 pointerdown handler 判定"点外部"。 */
const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="fixed z-50 min-w-48 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <!-- 关闭组:关闭 / 关闭其他 / 关闭右侧 / 关闭已保存 / 全部关闭 / 保存 -->
      <button
        v-if="showClose"
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="tab-ctx-close"
        @click="emit('close')"
      >
        关闭
      </button>
      <button
        v-if="showCloseOthers"
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="tab-ctx-close-others"
        @click="emit('close-others')"
      >
        关闭其他
      </button>
      <button
        v-if="showCloseRight"
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="tab-ctx-close-right"
        @click="emit('close-right')"
      >
        关闭右侧
      </button>
      <button
        v-if="showCloseSaved"
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="tab-ctx-close-saved"
        @click="emit('close-saved')"
      >
        关闭已保存
      </button>
      <button
        v-if="showCloseAll"
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="tab-ctx-close-all"
        @click="emit('close-all')"
      >
        全部关闭
      </button>
      <button
        v-if="showSave"
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="tab-ctx-save"
        @click="emit('save')"
      >
        保存
      </button>

      <template v-if="hasFile">
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />

        <!-- 复制组:复制路径 / 复制文件名 / 复制相对路径 -->
        <button
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="tab-ctx-copy-path"
          @click="emit('copy-path')"
        >
          复制路径
        </button>
        <button
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="tab-ctx-copy-filename"
          @click="emit('copy-filename')"
        >
          复制文件名
        </button>
        <button
          v-if="isInActiveRoot"
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="tab-ctx-copy-relative"
          @click="emit('copy-relative-path')"
        >
          复制相对路径
        </button>

        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />

        <!-- 树 / 资源管理器组 -->
        <button
          v-if="isInActiveRoot"
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="tab-ctx-reveal-in-tree"
          @click="emit('reveal-in-tree')"
        >
          在文件树中显示
        </button>
        <button
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="tab-ctx-reveal-in-explorer"
          @click="emit('reveal-in-explorer')"
        >
          在资源管理器中显示
        </button>
      </template>
    </div>
  </Teleport>
</template>

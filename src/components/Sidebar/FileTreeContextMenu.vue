<script setup lang="ts">
import { computed, ref } from 'vue'
import { MD_EXT_RE } from './treeUtils'

interface ContextMenuNode {
  name: string
  fullPath: string
  isDir: boolean
}

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y) */
  x: number
  y: number
  /** 触发菜单的节点;业务参数(操作函数)由父组件捕获。
   *  工作区根行不会弹菜单(由 FileTree 拦掉),组件内不再处理 isRoot 分支。 */
  node: ContextMenuNode
  /** 「空白处右键 = 根目录上下文」:不显示「在编辑器中打开」「作为工作区打开」「重命名」「删除」「在资源管理器中显示」,
   *  仅保留新建。语义对齐"工作区根行不弹菜单",但保留新建入口让用户不必通过双击。 */
  rootContext?: boolean
}>()

const emit = defineEmits<{
  /** .md 文件:在编辑器中打开(顶部新增项,与 onFileClick 同语义) */
  (e: 'open-in-editor'): void
  /** 目录:把该目录作为工作区根打开(顶部新增项) */
  (e: 'open-as-workspace'): void
  (e: 'new-file'): void
  (e: 'new-dir'): void
  (e: 'rename'): void
  (e: 'delete'): void
  (e: 'reveal'): void
}>()

/** .md 文件才显示"在编辑器中打开" —— 图片 row 不挂(图片打开语义模糊,留给"拖入"路径). */
const showOpenInEditor = computed(() => !props.rootContext && !props.node.isDir && MD_EXT_RE.test(props.node.name))
const showOpenAsWorkspace = computed(() => !props.rootContext && props.node.isDir)
const showRenameAndDelete = computed(() => !props.rootContext)
const showReveal = computed(() => !props.rootContext)

/** 父组件(用 defineExpose)拿这个 ref 给全局 pointerdown handler 判定"点外部"。 */
const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="velo-tree-context-menu fixed z-50 min-w-48 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <!-- 文件:在编辑器中打开 / 目录:作为工作区打开(顶部组,与文件管理器约定一致) -->
      <template v-if="showOpenInEditor || showOpenAsWorkspace">
        <button
          v-if="showOpenInEditor"
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-open-in-editor"
          @click="emit('open-in-editor')"
        >
          在编辑器中打开
        </button>
        <button
          v-if="showOpenAsWorkspace"
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-open-as-workspace"
          @click="emit('open-as-workspace')"
        >
          作为工作区打开
        </button>
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
      </template>

      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="ctx-new-file"
        @click="emit('new-file')"
      >
        新建文件
      </button>
      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="ctx-new-dir"
        @click="emit('new-dir')"
      >
        新建文件夹
      </button>
      <template v-if="showRenameAndDelete">
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-rename"
          @click="emit('rename')"
        >
          重命名
        </button>
        <button
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          data-testid="ctx-delete"
          @click="emit('delete')"
        >
          删除
        </button>
      </template>
      <template v-if="showReveal">
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button
          class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-reveal"
          @click="emit('reveal')"
        >
          在资源管理器中显示
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface ContextMenuNode {
  name: string
  fullPath: string
  isDir: boolean
}

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y) */
  x: number
  y: number
  /** 触发菜单的节点;业务参数(操作函数)由父组件捕获 */
  node: ContextMenuNode
  /** 工作区根行 → 删除按钮 disabled(防误删根) */
  isRoot: boolean
}>()

const emit = defineEmits<{
  (e: 'new-file'): void
  (e: 'new-dir'): void
  (e: 'rename'): void
  (e: 'delete'): void
  (e: 'reveal'): void
}>()

/** 父组件(用 defineExpose)拿这个 ref 给全局 pointerdown handler 判定"点外部"。 */
const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="velo-tree-context-menu fixed z-50 min-w-48 rounded-lg bg-white py-1 text-sm shadow-lg dark:bg-gray-800"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="emit('new-file')"
      >
        新建文件
      </button>
      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="emit('new-dir')"
      >
        新建文件夹
      </button>
      <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="emit('rename')"
      >
        重命名
      </button>
      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40 dark:disabled:text-gray-600"
        :disabled="isRoot"
        :title="isRoot ? '工作区根目录不可删除' : ''"
        @click="emit('delete')"
      >
        删除
      </button>
      <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
      <button
        class="w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        @click="emit('reveal')"
      >
        在资源管理器中显示
      </button>
    </div>
  </Teleport>
</template>

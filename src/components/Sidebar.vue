<script setup lang="ts">
// 侧边栏:统一收纳"大纲 / 文件"两个 tab(v0.5.0)。
//
// tab 状态走 `workspaceStore.sidebarTab`,per-workspace 持久化。无工作区时
// store 会强制回到 'outline',文件树 tab 视觉上 dimmed 且点击触发"选工作区"。
//
// 互斥渲染(v-if 而非 v-show):大纲组件持有 scroll-spy DOM 监听 / 文件树持有
// dirIndex Map,各自的 onMounted/onUnmounted 生命周期同时活着会争 scroll
// container / 多余 readDir。

import { ref } from 'vue'
import EditorOutline from './EditorOutline.vue'
import FileTree from './FileTree.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'

defineProps<{ modelValue: string, filePath: string | null }>()

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null)

defineExpose({
  /** 工作区根目录子树脏 → 重拉。给 App.vue 的 fs.watch 回调用。 */
  refreshDir(dirPath: string) {
    fileTreeRef.value?.refreshDir(dirPath)
  },
})

function pickFiles() {
  if (workspace.sidebarTab !== 'files') workspace.setSidebarTab('files')
  if (!workspace.activeRoot) void workspace.pickWorkspace()
}
</script>

<template>
  <div class="velo-sidebar flex h-full min-w-64 flex-col">
    <!-- tab 切换条 -->
    <div class="flex shrink-0 items-center gap-1 px-3 pt-3">
      <button
        class="rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wider transition-colors"
        :class="workspace.sidebarTab === 'outline'
          ? 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
          : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300'"
        @click="workspace.setSidebarTab('outline')"
      >
        大纲
      </button>
      <button
        class="rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wider transition-colors"
        :class="workspace.sidebarTab === 'files'
          ? 'bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
          : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300'"
        @click="pickFiles"
      >
        文件
      </button>
    </div>

    <!-- 互斥内容:大纲 / 文件树 -->
    <div class="min-h-0 flex-1">
      <EditorOutline
        v-if="workspace.sidebarTab === 'outline'"
        :model-value="modelValue"
        :file-path="filePath"
        hide-header
      />
      <FileTree
        v-else
        ref="fileTreeRef"
      />
    </div>

    <!-- 当前文件(无工作区时仍显示当前在编辑的) -->
    <div
      v-if="!workspace.activeRoot && documentStore.currentFilePath"
      class="shrink-0 truncate border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-800"
      :title="documentStore.currentFilePath ?? ''"
    >
      {{ documentStore.fileName }}
    </div>
  </div>
</template>

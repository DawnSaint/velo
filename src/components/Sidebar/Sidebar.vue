<script setup lang="ts">
// 侧边栏:统一收纳“当前活动视图”的内容。文件 / 大纲选择由 App.vue
// 左侧 ActivityBar 驱动,实际 tab 状态仍走 `workspaceStore.sidebarTab`,保持
// per-workspace 持久化语义不变。无工作区时 store 会强制回到 'outline'。
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
</script>

<template>
  <div class="velo-sidebar flex h-full min-w-64 flex-col">
    <!-- 互斥内容:文件树 / 大纲 -->
    <div class="min-h-0 flex-1">
      <FileTree
        v-if="workspace.sidebarTab === 'files'"
        ref="fileTreeRef"
      />
      <EditorOutline
        v-else
        :model-value="modelValue"
        :file-path="filePath"
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

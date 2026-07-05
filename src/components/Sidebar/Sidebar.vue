<script setup lang="ts">
// 侧边栏:统一收纳“当前活动视图”的内容。文件 / 大纲 / 全局搜索选择由 App.vue
// 左侧 ActivityBar 驱动,实际 tab 状态仍走 `workspaceStore.sidebarTab`,保持
// per-workspace 持久化语义不变。无工作区时 store 会强制回到 'outline'。
//
// 互斥渲染(v-if 而非 v-show):大纲组件持有 scroll-spy DOM 监听 / 文件树持有
// dirIndex Map,各自的 onMounted/onUnmounted 生命周期同时活着会争 scroll
// container / 多余 readDir。WorkspaceSearchPanel 同样按 v-if 切换,关闭时
// onBeforeUnmount 自动 cancel 当前搜索 run,避免悬挂 controller。

import { ref } from 'vue'
import EditorOutline from './EditorOutline.vue'
import FileTree from './FileTree.vue'
import WorkspaceSearchPanel from '@/components/WorkspaceSearchPanel.vue'
import type { WorkspaceSearchHit } from '@/utils/workspaceSearch'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'

defineProps<{
  modelValue: string
  filePath: string | null
  /** 每次切到 search tab 时由 App.vue 提供的初始 query(从选区带入) */
  workspaceSearchInitialQuery?: string
}>()
const emit = defineEmits<{
  'workspace-search-close': []
  'workspace-search-open-result': [WorkspaceSearchHit]
}>()

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null)

defineExpose({
  /** 工作区根目录子树脏 → 重拉。给 App.vue 的 fs.watch 回调用。 */
  refreshDir(dirPath: string) {
    fileTreeRef.value?.refreshDir(dirPath)
  },
  /** 在文件树中高亮定位到指定文件。给 TabBar「在文件树中显示」用。 */
  async revealFile(filePath: string) {
    await fileTreeRef.value?.revealFile(filePath)
  },
})

function onSearchClose() {
  // X 按钮 / Esc → 通知 App.vue 收起侧栏(对应 showSidebarTab/toggleSidebarTab
  // 的折叠语义:再次点击活动 tab 收起)。侧栏折叠比"切回 outline"更符合
  // 用户"我已经搜完想关掉面板"的意图。
  emit('workspace-search-close')
}

function onSearchOpenResult(hit: WorkspaceSearchHit) {
  emit('workspace-search-open-result', hit)
}
</script>

<template>
  <!-- min-w-0(v0.5.5):替换原 min-w-64(256px),让外层 splitter 拉到 200px 时不被截断。
       子组件 FileTree / EditorOutline 自己用 truncate 处理长文本,不需要硬最小宽度。
       overflow-hidden 防止拖到接近 200px 时内部滚动容器溢出。 -->
  <div class="velo-sidebar flex h-full min-w-0 flex-col overflow-hidden">
    <!-- 互斥内容:文件树 / 大纲 / 全局搜索(v0.6.x) -->
    <div class="min-h-0 flex-1">
      <FileTree
        v-if="workspace.sidebarTab === 'files'"
        ref="fileTreeRef"
      />
      <EditorOutline
        v-else-if="workspace.sidebarTab === 'outline'"
        :model-value="modelValue"
        :file-path="filePath"
      />
      <WorkspaceSearchPanel
        v-else
        :root="workspace.activeRoot"
        :initial-query="workspaceSearchInitialQuery"
        @update:open="onSearchClose"
        @open-result="onSearchOpenResult"
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

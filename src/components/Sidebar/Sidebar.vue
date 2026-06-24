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
</script>

<template>
  <div class="velo-sidebar flex h-full min-w-64 flex-col">
    <!-- tab 切换条:文件 / 大纲 各占 50%。容器底部一条灰色 underline 作 track,
         上面叠一根半宽主色 indicator 用 translateX 在两 tab 间滑动(transition).
         首次点击"文件"不自动弹选择文件夹,空态由 FileTree 内部按钮承担。 -->
    <div class="relative flex shrink-0 items-stretch border-b border-gray-200 px-3 pt-3 dark:border-gray-800">
      <button
        class="velo-sidebar-tab flex-1 px-2 py-1.5 text-sm font-semibold uppercase tracking-wider transition-colors"
        :class="workspace.sidebarTab === 'files'
          ? 'velo-sidebar-tab--active'
          : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
        @click="workspace.setSidebarTab('files')"
      >
        文件
      </button>
      <button
        class="velo-sidebar-tab flex-1 px-2 py-1.5 text-sm font-semibold uppercase tracking-wider transition-colors"
        :class="workspace.sidebarTab === 'outline'
          ? 'velo-sidebar-tab--active'
          : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'"
        @click="workspace.setSidebarTab('outline')"
      >
        大纲
      </button>
      <!-- 滑动 indicator:占容器宽度 50%(扣掉两边 px-3 是用 calc),沿 X 轴在两 tab 间滑动 -->
      <span
        class="velo-sidebar-indicator"
        :class="{ 'velo-sidebar-indicator--right': workspace.sidebarTab === 'outline' }"
        aria-hidden="true"
      />
    </div>

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

<style scoped>
.velo-sidebar-tab--active {
  color: var(--md-primary-color, #1F71D9);
}
.velo-sidebar-indicator {
  position: absolute;
  /* 容器有 px-3(12px),所以 indicator 起点是 12px、宽度是 calc((100% - 24px) / 2) */
  bottom: -1px;
  left: 12px;
  width: calc((100% - 24px) / 2);
  height: 2px;
  background: var(--md-primary-color, #1F71D9);
  transition: transform 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}
.velo-sidebar-indicator--right {
  transform: translateX(100%);
}
</style>

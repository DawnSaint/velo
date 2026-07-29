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
import { Image as ImageIcon } from '@lucide/vue'
import EditorOutline from './EditorOutline.vue'
import FileTree from './FileTree.vue'
import AssetPanel from './AssetPanel.vue'
import WorkspaceSearchPanel from '@/components/WorkspaceSearchPanel.vue'
import type { WorkspaceSearchHit } from '@/utils/workspaceSearch'
import { useWorkspaceStore } from '@/stores/workspace'
import { useDocumentStore } from '@/stores/document'

defineProps<{
  modelValue: string
  filePath: string | null
  /** 设置 tab 是否激活。激活时大纲 / 资产面板显示空态(无文档上下文),
   *  files / search 正常渲染(设置保持激活,用户可浏览文件树 / 搜索)。 */
  settingsActive?: boolean
  /** 每次切到 search tab 时由 App.vue 提供的初始 query(从选区带入) */
  workspaceSearchInitialQuery?: string
  /** 工作区搜索 scope(子目录);null 表示工作区根 */
  workspaceSearchScopeDir?: string | null
  /** 替换完成后的一次性状态文案(App.vue 写入,显示后由 panel 自己的 status 接管) */
  workspaceSearchReplaceStatus?: string
  /** 替换 / scope 变化等"需要重跑搜索"信号 —— 每次自增触发 panel scheduleSearch */
  workspaceSearchRerunToken?: number
}>()
const emit = defineEmits<{
  'workspace-search-close': []
  'workspace-search-open-result': [WorkspaceSearchHit]
  'workspace-search-clear-scope': []
  'workspace-search-apply-replace': [{ hits: WorkspaceSearchHit[], replacement: string, scope: 'one' | 'all' }]
  /** 文件树右键菜单「在此文件夹中搜索」透传给 App.vue */
  'search-in-folder': [string]
  /** 资产面板:点击图片条目 → 定位到编辑器中对应 image 节点 */
  'locate-image': [src: string, occurrence: number]
  /** 资产面板:复制/移动图片到工作区 assets/<docName>/ → 重写编辑器内引用路径 */
  'reorganize-asset': [payload: { oldAbsPath: string; newSrc: string; mode: 'copy' | 'move' }]
}>()

const workspace = useWorkspaceStore()
const documentStore = useDocumentStore()

const fileTreeRef = ref<InstanceType<typeof FileTree> | null>(null)

defineExpose({
  /** 工作区根目录子树脏 → 重拉。给 App.vue 的 fs.watch 回调用。 */
  refreshDir(dirPath: string) {
    fileTreeRef.value?.refreshDir(dirPath)
  },
  /** 在文件树中高亮定位到指定文件。给 TabBar「在文件树中显示」/ 点 tab 定位用。 */
  async revealFile(filePath: string, options?: { flash?: boolean }) {
    await fileTreeRef.value?.revealFile(filePath, options)
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

function onSearchClearScope() {
  emit('workspace-search-clear-scope')
}

function onSearchApplyReplace(payload: { hits: WorkspaceSearchHit[], replacement: string, scope: 'one' | 'all' }) {
  emit('workspace-search-apply-replace', payload)
}

function onFileTreeSearchInFolder(dirPath: string) {
  emit('search-in-folder', dirPath)
}

function onLocateImage(src: string, occurrence: number) {
  emit('locate-image', src, occurrence)
}

function onReorganizeAsset(payload: { oldAbsPath: string; newSrc: string; mode: 'copy' | 'move' }) {
  emit('reorganize-asset', payload)
}

</script>

<template>
  <!-- min-w-0(v0.5.5):替换原 min-w-64(256px),让外层 splitter 拉到 200px 时不被截断。
       子组件 FileTree / EditorOutline 自己用 truncate 处理长文本,不需要硬最小宽度。
       overflow-hidden 防止拖到接近 200px 时内部滚动容器溢出。 -->
  <div class="flex h-full min-w-0 flex-col overflow-hidden">
    <!-- 互斥内容:设置激活时资产面板显示空态(无文档上下文,不挂载
         AssetPanel 孤儿扫描);outline 空态由 EditorOutline 自身 props.settingsActive
         接管。files / search 正常渲染(设置保持激活,用户可浏览文件树 / 搜索)。 -->
    <div class="min-h-0 flex-1">
      <!-- 设置激活时 assets 显示空态 -->
      <div
        v-if="settingsActive && workspace.sidebarTab === 'assets'"
        class="flex h-full flex-col items-center justify-center gap-2 px-4 text-gray-400 dark:text-gray-600"
      >
        <ImageIcon :size="32" :stroke-width="1.2" />
        <span class="text-xs">当前文档没有图片</span>
      </div>
      <FileTree
        v-else-if="workspace.sidebarTab === 'files'"
        ref="fileTreeRef"
        @search-in-folder="onFileTreeSearchInFolder"
      />
      <EditorOutline
        v-else-if="workspace.sidebarTab === 'outline'"
        :model-value="modelValue"
        :file-path="filePath"
        :settings-active="settingsActive"
      />
      <AssetPanel
        v-else-if="workspace.sidebarTab === 'assets'"
        :model-value="modelValue"
        :file-path="filePath"
        @locate-image="onLocateImage"
        @reorganize-asset="onReorganizeAsset"
      />
      <WorkspaceSearchPanel
        v-else
        :root="workspace.activeRoot"
        :initial-query="workspaceSearchInitialQuery"
        :scope-dir="workspaceSearchScopeDir"
        :replace-status="workspaceSearchReplaceStatus"
        :rerun-token="workspaceSearchRerunToken"
        @update:open="onSearchClose"
        @open-result="onSearchOpenResult"
        @clear-scope="onSearchClearScope"
        @apply-replace="onSearchApplyReplace"
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

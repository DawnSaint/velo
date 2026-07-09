<script setup lang="ts">
// 资产面板右键菜单 —— 与 FileTreeContextMenu 同款 Teleport + rootEl expose 范式。
// 纯展示 + 事件转发，不持有业务状态；菜单的显示 / 隐藏 / 全局 pointerdown 关闭由 AssetPanel 管理。

import { ref } from 'vue'

defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y) */
  x: number
  y: number
  /** 是否允许"复制/移动到工作区"：需有工作区 + 有 filePath + Tauri 环境 + 文档在工作区内 */
  canReorganize: boolean
  /** 目标子目录名（assets/<docName>/），用于菜单文案显示 */
  docName: string
  /** 是否在 Tauri 环境（控制 Tauri-only 菜单项显隐） */
  isTauri: boolean
  /** 是否有当前文档路径（控制"复制相对路径"显隐：有文档才有相对路径） */
  hasSrc: boolean
}>()

const emit = defineEmits<{
  (e: 'copy-image'): void
  (e: 'copy-path'): void
  (e: 'copy-relative-path'): void
  /** 复制到工作区 assets/<docName>/ */
  (e: 'copy-to-workspace'): void
  /** 移动到工作区 assets/<docName>/ */
  (e: 'move-to-workspace'): void
  /** 另存为... */
  (e: 'save-as'): void
  /** 删除 */
  (e: 'delete'): void
  /** 在资源管理器中显示 */
  (e: 'reveal'): void
}>()

/** 父组件拿这个 ref 给全局 pointerdown handler 判定"点外部"。 */
const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="fixed z-50 w-max text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <!-- 剪贴板操作组 -->
      <template v-if="isTauri">
        <button
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-copy-image"
          @click="emit('copy-image')"
        >
          复制图片
        </button>
        <button
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-copy-path"
          @click="emit('copy-path')"
        >
          复制路径
        </button>
      </template>
      <button
        v-if="hasSrc"
        class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        data-testid="ctx-copy-relative-path"
        @click="emit('copy-relative-path')"
      >
        复制相对路径
      </button>

      <!-- 文件操作组 -->
      <template v-if="canReorganize || isTauri">
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button
          v-if="canReorganize"
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-copy-to-workspace"
          @click="emit('copy-to-workspace')"
        >
          复制到工作区/assets/{{ docName }}/
        </button>
        <button
          v-if="canReorganize"
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-move-to-workspace"
          @click="emit('move-to-workspace')"
        >
          移动到工作区/assets/{{ docName }}/
        </button>
        <button
          v-if="isTauri"
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-save-as"
          @click="emit('save-as')"
        >
          另存为...
        </button>
      </template>

      <!-- 删除 -->
      <template v-if="isTauri">
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          data-testid="ctx-delete"
          @click="emit('delete')"
        >
          删除
        </button>
      </template>

      <!-- 在资源管理器中显示 -->
      <template v-if="isTauri">
        <div class="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button
          class="block w-[calc(100%-0.5rem)] mx-1 px-2 py-2 rounded-md text-left whitespace-nowrap transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="ctx-reveal"
          @click="emit('reveal')"
        >
          在资源管理器中显示
        </button>
      </template>
    </div>
  </Teleport>
</template>

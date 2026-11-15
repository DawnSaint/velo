<script setup lang="ts">
// Mermaid 预览节点右键菜单 —— 样式与 TableContextMenu 完全同一套
// (ContextMenuShell + .ctx-menu-item / .ctx-menu-separator / --danger)。
//
// 触发流:plugins/mermaidContextMenu.ts 拦截 contextmenu → EditorInner 缓存
// 上下文并置 showMermaidMenu → 本组件 emit(action) → runMermaidMenuAction。
//
// 只读模式隐藏写操作(展开 / 剪切 / 删除节点),复制与导出保留 —— 只读也能带走图。

import { computed, ref } from 'vue'
import ContextMenuShell from '../ContextMenuShell.vue'
import type { MermaidMenuAction } from './nodes/mermaidContextActions'

defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y,ContextMenuShell 内部再翻转 / clamp) */
  x: number
  y: number
  /** 当前是否展开源码态 → 「展开」/「收起」文案切换 */
  isEditing: boolean
  /** 编辑器是否可写 → 只读模式隐藏写操作 */
  editable: boolean
}>()

const emit = defineEmits<{
  (e: 'action', action: MermaidMenuAction): void
  (e: 'close'): void
}>()

const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })

function fire(action: MermaidMenuAction) {
  emit('action', action)
  emit('close')
}
</script>

<template>
  <ContextMenuShell ref="shellRef" :x="x" :y="y" data-mermaid-context-menu>
    <!-- 编辑组 -->
    <button
      v-if="editable"
      class="ctx-menu-item"
      data-testid="mermaid-toggle-source"
      @click="fire('toggle-source')"
    >
      {{ isEditing ? '收起源代码' : '展开源代码' }}
    </button>
    <button
      class="ctx-menu-item"
      data-testid="mermaid-copy"
      title="复制整个图表节点(含 ```mermaid 围栏),可直接粘贴回文档"
      @click="fire('copy')"
    >
      复制
    </button>
    <button
      v-if="editable"
      class="ctx-menu-item"
      data-testid="mermaid-cut"
      title="复制整个图表节点并删除"
      @click="fire('cut')"
    >
      剪切
    </button>
    <button class="ctx-menu-item" data-testid="mermaid-copy-source" @click="fire('copy-source')">
      复制 Mermaid 代码
    </button>

    <div class="ctx-menu-separator" />

    <!-- 图片 / 导出组 -->
    <button class="ctx-menu-item" data-testid="mermaid-copy-image" @click="fire('copy-image')">
      复制为图片
    </button>
    <button class="ctx-menu-item" data-testid="mermaid-copy-svg" @click="fire('copy-svg')">
      复制 SVG 代码
    </button>
    <button class="ctx-menu-item" data-testid="mermaid-save-png" @click="fire('save-png')">
      另存为图片…
    </button>
    <button class="ctx-menu-item" data-testid="mermaid-save-svg" @click="fire('save-svg')">
      另存为 SVG…
    </button>
    <button class="ctx-menu-item" data-testid="mermaid-save-source" @click="fire('save-source')">
      另存为 Mermaid 源码…
    </button>

    <template v-if="editable">
      <div class="ctx-menu-separator" />
      <button
        class="ctx-menu-item ctx-menu-item--danger"
        data-testid="mermaid-delete"
        @click="fire('delete')"
      >
        删除节点
      </button>
    </template>
  </ContextMenuShell>
</template>

<script setup lang="ts">
// 图片节点右键菜单 —— 样式与 Mermaid / TableContextMenu 完全同一套
// (ContextMenuShell + .ctx-menu-item / .ctx-menu-separator / --danger)。
//
// 触发流:plugins/imageContextMenu.ts 拦截 contextmenu → EditorInner 缓存上下文并置
// showImageMenu → 本组件 emit(action) → runImageMenuAction。
//
// 只读模式隐藏写操作(剪切 / 编辑源码 / 删除节点 / 删除文件),复制与导出保留。
// 「删除文件」是磁盘破坏性操作,仅本地图片(有 absPath)+ Tauri 环境才出现,
// 命令侧仍会二次确认(useConfirmStore)。

import { computed, ref } from 'vue'
import ContextMenuShell from '../ContextMenuShell.vue'
import type { ImageMenuAction } from './nodes/imageContextActions'

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y,ContextMenuShell 内部再翻转 / clamp) */
  x: number
  y: number
  /** 编辑器是否可写 → 只读模式隐藏写操作 */
  editable: boolean
  /** 是否有磁盘路径 → 控制 复制图片 / 复制路径 / 复制相对路径 / 另存为 / 删除文件 */
  hasAbsPath: boolean
  /** 是否在 Tauri 环境(删除文件 / 复制图片等 fs 能力的前置) */
  isTauri: boolean
}>()

const emit = defineEmits<{
  (e: 'action', action: ImageMenuAction): void
  (e: 'close'): void
}>()

const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })

function fire(action: ImageMenuAction) {
  emit('action', action)
  emit('close')
}

/** 删除文件 = Tauri + 本地图片 + 可写,三者齐备才展示。 */
const canDeleteFile = computed(() => props.editable && props.isTauri && props.hasAbsPath)
</script>

<template>
  <ContextMenuShell ref="shellRef" :x="x" :y="y" data-image-context-menu>
    <!-- 剪贴板组 -->
    <button
      v-if="isTauri && hasAbsPath"
      class="ctx-menu-item"
      data-testid="image-copy-image"
      title="把图片二进制写入系统剪贴板(可直接粘贴到聊天 / 画图工具)"
      @click="fire('copy-image')"
    >
      复制图片
    </button>
    <button class="ctx-menu-item" data-testid="image-copy-markdown" @click="fire('copy-markdown')">
      复制 Markdown
    </button>
    <button
      v-if="hasAbsPath"
      class="ctx-menu-item"
      data-testid="image-copy-path"
      @click="fire('copy-path')"
    >
      复制路径
    </button>
    <button
      v-if="hasAbsPath"
      class="ctx-menu-item"
      data-testid="image-copy-relative-path"
      @click="fire('copy-relative-path')"
    >
      复制相对路径
    </button>

    <!-- 编辑组 -->
    <template v-if="editable">
      <div class="ctx-menu-separator" />
      <button
        class="ctx-menu-item"
        data-testid="image-cut"
        title="复制整个图片标记并删除节点"
        @click="fire('cut')"
      >
        剪切
      </button>
      <button
        class="ctx-menu-item"
        data-testid="image-edit-source"
        title="就地展开成 markdown / html 源码编辑"
        @click="fire('edit-source')"
      >
        编辑图片源码
      </button>
      <button class="ctx-menu-item" data-testid="image-save-as" @click="fire('save-as')">
        另存为…
      </button>

      <div class="ctx-menu-separator" />
      <button
        class="ctx-menu-item ctx-menu-item--danger"
        data-testid="image-delete-node"
        title="仅移除文档中的图片节点,不动磁盘文件;可 Ctrl+Z 撤销"
        @click="fire('delete-node')"
      >
        删除图片
      </button>
    </template>

    <!-- 磁盘破坏性操作:仅本地图片 -->
    <template v-if="canDeleteFile">
      <div class="ctx-menu-separator" />
      <button
        class="ctx-menu-item ctx-menu-item--danger"
        data-testid="image-delete-file"
        title="删除磁盘上的图片文件,并移除文档中所有引用它的位置"
        @click="fire('delete-file')"
      >
        删除图片文件…
      </button>
    </template>
  </ContextMenuShell>
</template>

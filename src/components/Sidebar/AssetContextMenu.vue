<script setup lang="ts">
// 资产面板右键菜单 —— 壳走 ContextMenuShell,菜单项走 .ctx-menu-item 全局 class。
// 纯展示 + 事件转发,不持有业务状态;菜单的显示 / 隐藏 / 全局 listener
// 由 AssetPanel 通过 useContextMenu composable 管理。
//
// 两套形态:
//  - 正常条目:预览 / 剪贴板 / 重组 / 另存为 / 删除 / reveal
//  - 失效引用(broken):重新链接 / 移除引用 / 复制路径(文件已缺失,其余无意义)

import { computed, ref } from 'vue'
import ContextMenuShell from '../ContextMenuShell.vue'

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
  /** 失效引用条目:菜单换成 重新链接 / 移除引用 */
  broken: boolean
  /** 是否可预览(lightbox);失效条目不可预览 */
  canPreview: boolean
}>()

const emit = defineEmits<{
  (e: 'preview'): void
  (e: 'copy-image'): void
  (e: 'copy-path'): void
  (e: 'copy-relative-path'): void
  /** 失效引用:选择新图片文件,改写文档中的 src */
  (e: 'relink'): void
  /** 失效引用:仅移除文档中的 image 节点,不动磁盘 */
  (e: 'remove-reference'): void
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

/** 父组件拿这个 ref 给 useContextMenu 的 getMenuEl callback。 */
const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })
</script>

<template>
  <ContextMenuShell ref="shellRef" :x="x" :y="y" min-width-class="w-max">
    <!-- ========== 失效引用 ========== -->
    <template v-if="broken">
      <button v-if="isTauri" class="ctx-menu-item" data-testid="ctx-relink" @click="emit('relink')">
        重新链接...
      </button>
      <button class="ctx-menu-item" data-testid="ctx-remove-reference" @click="emit('remove-reference')">
        移除引用
      </button>
      <template v-if="isTauri || hasSrc">
        <div class="ctx-menu-separator" />
        <button v-if="isTauri" class="ctx-menu-item" data-testid="ctx-copy-path" @click="emit('copy-path')">
          复制路径
        </button>
        <button v-if="hasSrc" class="ctx-menu-item" data-testid="ctx-copy-relative-path" @click="emit('copy-relative-path')">
          复制相对路径
        </button>
      </template>
    </template>

    <!-- ========== 正常条目 ========== -->
    <template v-else>
      <button v-if="canPreview" class="ctx-menu-item" data-testid="ctx-preview" @click="emit('preview')">
        预览
      </button>

      <!-- 剪贴板操作组 -->
      <template v-if="isTauri">
        <div v-if="canPreview" class="ctx-menu-separator" />
        <button class="ctx-menu-item" data-testid="ctx-copy-image" @click="emit('copy-image')">
          复制图片
        </button>
        <button class="ctx-menu-item" data-testid="ctx-copy-path" @click="emit('copy-path')">
          复制路径
        </button>
      </template>
      <button v-if="hasSrc" class="ctx-menu-item" data-testid="ctx-copy-relative-path" @click="emit('copy-relative-path')">
        复制相对路径
      </button>

      <!-- 文件操作组 -->
      <template v-if="canReorganize || isTauri">
        <div class="ctx-menu-separator" />
        <button v-if="canReorganize" class="ctx-menu-item" data-testid="ctx-copy-to-workspace" @click="emit('copy-to-workspace')">
          复制到工作区/assets/{{ docName }}/
        </button>
        <button v-if="canReorganize" class="ctx-menu-item" data-testid="ctx-move-to-workspace" @click="emit('move-to-workspace')">
          移动到工作区/assets/{{ docName }}/
        </button>
        <button v-if="isTauri" class="ctx-menu-item" data-testid="ctx-save-as" @click="emit('save-as')">
          另存为...
        </button>
      </template>

      <!-- 删除 -->
      <template v-if="isTauri">
        <div class="ctx-menu-separator" />
        <button class="ctx-menu-item ctx-menu-item--danger" @click="emit('delete')">
          删除
        </button>
      </template>

      <!-- 在资源管理器中显示 -->
      <template v-if="isTauri">
        <div class="ctx-menu-separator" />
        <button class="ctx-menu-item" @click="emit('reveal')">
          在资源管理器中显示
        </button>
      </template>
    </template>
  </ContextMenuShell>
</template>
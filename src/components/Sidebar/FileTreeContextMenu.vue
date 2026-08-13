<script setup lang="ts">
import { computed, ref } from 'vue'
import ContextMenuShell from '../ContextMenuShell.vue'
import { MD_EXT_RE } from './treeUtils'

interface ContextMenuNode {
  name: string
  fullPath: string
  isDir: boolean
}

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y) */
  x: number
  y: number
  /** 触发菜单的节点;业务参数(操作函数)由父组件捕获。
   *  工作区根行不会弹菜单(由 FileTree 拦掉),组件内不再处理 isRoot 分支。 */
  node: ContextMenuNode
  /** 「空白处右键 = 根目录上下文」:不显示「在编辑器中打开」「在新窗口中打开」「重命名」「删除」「在资源管理器中显示」,
   *  仅保留新建。语义对齐"工作区根行不弹菜单",但保留新建入口让用户不必通过双击。 */
  rootContext?: boolean
  /** 节点右键时「粘贴」是否可用(clipboard 非空);rootContext 下恒显示。 */
  canPaste?: boolean
}>()

const emit = defineEmits<{
  /** .md 文件:在编辑器中打开(顶部新增项,与 onFileClick 同语义) */
  (e: 'open-in-editor'): void
  /** 目录:在新窗口中把该目录作为工作区根打开(顶部新增项) */
  (e: 'open-as-workspace'): void
  /** 目录:在该目录子树里打开工作区搜索(把该目录设为 scope)。仅非根目录显示 */
  (e: 'search-in-folder'): void
  (e: 'new-file'): void
  (e: 'new-dir'): void
  /** 复制当前节点(文件 / 目录都可) —— 仅非根节点显示 */
  (e: 'copy'): void
  /** 把已复制的节点粘贴到当前目标目录 —— rootContext(根目录空白处右键)恒显示;
   *  节点右键仅在 clipboard 非空时显示(由 canPaste prop 控制)。 */
  (e: 'paste'): void
  (e: 'rename'): void
  (e: 'delete'): void
  (e: 'reveal'): void
}>()

/** 是否允许粘贴:需 clipboard 非空(rootContext 与 节点右键一致,都要求 canPaste)。 */
const canPaste = computed(() => !!props.canPaste)

/** .md 文件才显示"在编辑器中打开" —— 图片 row 不挂(图片打开语义模糊,留给"拖入"路径). */
const showOpenInEditor = computed(() => !props.rootContext && !props.node.isDir && MD_EXT_RE.test(props.node.name))
const showOpenAsWorkspace = computed(() => !props.rootContext && props.node.isDir)
const showSearchInFolder = computed(() => !props.rootContext && props.node.isDir)
const showRenameAndDelete = computed(() => !props.rootContext)
const showReveal = computed(() => !props.rootContext)

/** 父组件(用 defineExpose)拿这个 ref 给 useContextMenu 的 getMenuEl callback。 */
const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })
</script>

<template>
  <ContextMenuShell ref="shellRef" :x="x" :y="y" data-tree-context-menu>
    <!-- 文件:在编辑器中打开 / 目录:在新窗口中打开(顶部组) -->
    <template v-if="showOpenInEditor || showOpenAsWorkspace">
      <button v-if="showOpenInEditor" class="ctx-menu-item" data-testid="ctx-open-in-editor" @click="emit('open-in-editor')">
        在编辑器中打开
      </button>
      <button v-if="showOpenAsWorkspace" class="ctx-menu-item" data-testid="ctx-open-as-workspace" @click="emit('open-as-workspace')">
        在新窗口中打开
      </button>
      <button v-if="showSearchInFolder" class="ctx-menu-item" data-testid="ctx-search-in-folder" @click="emit('search-in-folder')">
        在此文件夹中搜索
      </button>
      <div class="ctx-menu-separator" />
    </template>

    <button class="ctx-menu-item" data-testid="ctx-new-file" @click="emit('new-file')">
      新建文件
    </button>
    <button class="ctx-menu-item" data-testid="ctx-new-dir" @click="emit('new-dir')">
      新建文件夹
    </button>
    <button v-if="canPaste" class="ctx-menu-item" data-testid="ctx-paste" @click="emit('paste')">
      粘贴
    </button>
    <!-- 复制 / 重命名 / 删除 同组(仅非根节点显示) -->
    <template v-if="showRenameAndDelete">
      <div class="ctx-menu-separator" />
      <button class="ctx-menu-item" data-testid="ctx-copy" @click="emit('copy')">
        复制
      </button>
      <div class="ctx-menu-separator" />
      <button class="ctx-menu-item" data-testid="ctx-rename" @click="emit('rename')">
        重命名
      </button>
      <button class="ctx-menu-item ctx-menu-item--danger" data-testid="ctx-delete" @click="emit('delete')">
        删除
      </button>
    </template>
    <template v-if="showReveal">
      <div class="ctx-menu-separator" />
      <button class="ctx-menu-item" data-testid="ctx-reveal" @click="emit('reveal')">
        在资源管理器中显示
      </button>
    </template>
  </ContextMenuShell>
</template>

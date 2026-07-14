<script setup lang="ts">
// 表格单元格右键菜单 —— 行列增删 + 单元格对齐 + 删除表格。
//
// 菜单项走 .ctx-menu-item / .ctx-menu-separator 全局 class(见 _context-menu.scss),
// 壳走 ContextMenuShell(Teleport + 定位 + @contextmenu.prevent)。
//
// 触发流:EditorInner.vue 在 contentDOM 上监听 contextmenu → 命中 table cell 时
// setMenu(x, y) → 组件内 buttons emit(action) → EditorInner 监听
// @table-action → 调 tableEditor.runTableCommand / runSetCellAlignment。

import { ref, computed } from "vue"
import ContextMenuShell from "../ContextMenuShell.vue"

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y，已由父级 clamp) */
  x: number
  y: number
  /** 右键点中 header(th)且非多格拖蓝 → 隐藏"删除行"(header 行不可删) */
  hideDeleteRow: boolean
}>()

const emit = defineEmits<{
  (e: "action", action: TableAction): void
  (e: "close"): void
}>()

/** 支持的菜单动作枚举(EditorInner.vue 监听后分发到 tableEditor) */
export type TableAction =
  | "add-row-before"
  | "add-row-after"
  | "delete-row"
  | "add-column-left"
  | "add-column-right"
  | "delete-column"
  | "align-left"
  | "align-center"
  | "align-right"
  | "delete-table"

const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })

function fire(action: TableAction) {
  emit("action", action)
  emit("close")
}
</script>

<template>
  <ContextMenuShell :x="x" :y="y" ref="shellRef">
    <!-- 行操作组 -->
    <button class="ctx-menu-item" data-testid="table-add-row-before" @click="fire('add-row-before')">
      上方插入行
    </button>
    <button class="ctx-menu-item" data-testid="table-add-row-after" @click="fire('add-row-after')">
      下方插入行
    </button>
    <button v-if="!hideDeleteRow" class="ctx-menu-item" data-testid="table-delete-row" @click="fire('delete-row')">
      删除行
    </button>

    <div class="ctx-menu-separator" />

    <!-- 列操作组 -->
    <button class="ctx-menu-item" data-testid="table-add-column-left" @click="fire('add-column-left')">
      左侧插入列
    </button>
    <button class="ctx-menu-item" data-testid="table-add-column-right" @click="fire('add-column-right')">
      右侧插入列
    </button>
    <button class="ctx-menu-item" data-testid="table-delete-column" @click="fire('delete-column')">
      删除列
    </button>

    <div class="ctx-menu-separator" />

    <!-- 对齐组 -->
    <button class="ctx-menu-item" data-testid="table-align-left" @click="fire('align-left')">
      左对齐
    </button>
    <button class="ctx-menu-item" data-testid="table-align-center" @click="fire('align-center')">
      居中对齐
    </button>
    <button class="ctx-menu-item" data-testid="table-align-right" @click="fire('align-right')">
      右对齐
    </button>

    <div class="ctx-menu-separator" />

    <!-- 删除表格 -->
    <button class="ctx-menu-item ctx-menu-item--danger" data-testid="table-delete" @click="fire('delete-table')">
      删除表格
    </button>
  </ContextMenuShell>
</template>
﻿<script setup lang="ts">
// 表格单元格右键菜单 —— 行列增删 + 行列移动 + 单元格对齐 + 删除表格。
//
// 菜单项走 .ctx-menu-item / .ctx-menu-separator 全局 class(见 _context-menu.scss),
// 壳走 ContextMenuShell(Teleport + 定位 + @contextmenu.prevent)。
//
// 触发流:EditorInner.vue 在 contentDOM 上监听 contextmenu → 命中 table cell 时
// setMenu(x, y) → 组件内 buttons emit(action) → EditorInner 监听
// @table-action → 调 tableEditor.runTableCommand / runSetCellAlignment。

import { ref, computed } from "vue"
import ContextMenuShell from "../ContextMenuShell.vue"
import { getTableActionShortcutMap, formatShortcutKey } from "./editor/shortcuts/registry"

const props = defineProps<{
  /** 视口坐标(mouseEvent.clientX/Y，已由父级 clamp) */
  x: number
  y: number
  /** 右键点中 header(th)且非多格拖蓝 → 隐藏"删除行"(header 行不可删) */
  hideDeleteRow: boolean
  /** 隐藏"上/下移该行":header 行不可移动 */
  hideMoveRow: boolean
  /** 隐藏"左/右移该列":单列表格无列移动意义 */
  hideMoveColumn: boolean
}>()

const emit = defineEmits<{
  (e: "action", action: TableAction): void
  (e: "close"): void
}>()

/** 支持的菜单动作枚举(EditorInner.vue 监听后分发到 tableEditor) */
type TableAction =
  | "add-row-before"
  | "add-row-after"
  | "move-row-up"
  | "move-row-down"
  | "delete-row"
  | "add-column-left"
  | "add-column-right"
  | "move-column-left"
  | "move-column-right"
  | "delete-column"
  | "align-left"
  | "align-center"
  | "align-right"
  | "delete-table"

const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })

// 当前注册表里 tableAction → 格式化后的展示串(如 "Ctrl+Enter" / "⌘+Enter")。
// 没注册的项返回 undefined → 模板不渲染快捷键,实现"如果有的话"。
const shortcutMap = computed<Partial<Record<TableAction, string>>>(() => {
  const out: Partial<Record<TableAction, string>> = {}
  for (const [action, key] of Object.entries(getTableActionShortcutMap())) {
    out[action as TableAction] = formatShortcutKey(key)
  }
  return out
})
const shortcutFor = (action: TableAction): string | undefined => shortcutMap.value[action]

function fire(action: TableAction) {
  emit("action", action)
  emit("close")
}
</script>

<template>
  <ContextMenuShell ref="shellRef" :x="x" :y="y">
    <!-- 行操作组 -->
    <button class="ctx-menu-item" data-testid="table-add-row-before" @click="fire('add-row-before')">
      <span class="ctx-menu-item__label">上方插入行</span>
      <span v-if="shortcutFor('add-row-before')" class="velo-kbd">{{ shortcutFor('add-row-before') }}</span>
    </button>
    <button class="ctx-menu-item" data-testid="table-add-row-after" @click="fire('add-row-after')">
      <span class="ctx-menu-item__label">下方插入行</span>
      <span v-if="shortcutFor('add-row-after')" class="velo-kbd">{{ shortcutFor('add-row-after') }}</span>
    </button>
    <!-- 行移动:仅 body 行时显示(header row 不可移动) -->
    <button
      v-if="!hideMoveRow"
      class="ctx-menu-item"
      data-testid="table-move-row-up"
      @click="fire('move-row-up')"
    >
      <span class="ctx-menu-item__label">上移该行</span>
      <span v-if="shortcutFor('move-row-up')" class="velo-kbd">{{ shortcutFor('move-row-up') }}</span>
    </button>
    <button
      v-if="!hideMoveRow"
      class="ctx-menu-item"
      data-testid="table-move-row-down"
      @click="fire('move-row-down')"
    >
      <span class="ctx-menu-item__label">下移该行</span>
      <span v-if="shortcutFor('move-row-down')" class="velo-kbd">{{ shortcutFor('move-row-down') }}</span>
    </button>
    <button v-if="!hideDeleteRow" class="ctx-menu-item" data-testid="table-delete-row" @click="fire('delete-row')">
      <span class="ctx-menu-item__label">删除行</span>
      <span v-if="shortcutFor('delete-row')" class="velo-kbd">{{ shortcutFor('delete-row') }}</span>
    </button>

    <div class="ctx-menu-separator" />

    <!-- 列操作组 -->
    <button class="ctx-menu-item" data-testid="table-add-column-left" @click="fire('add-column-left')">
      左侧插入列
    </button>
    <button class="ctx-menu-item" data-testid="table-add-column-right" @click="fire('add-column-right')">
      右侧插入列
    </button>
    <button v-if="!hideMoveColumn" class="ctx-menu-item" data-testid="table-move-column-left" @click="fire('move-column-left')">
      <span class="ctx-menu-item__label">左移该列</span>
      <span v-if="shortcutFor('move-column-left')" class="velo-kbd">{{ shortcutFor('move-column-left') }}</span>
    </button>
    <button v-if="!hideMoveColumn" class="ctx-menu-item" data-testid="table-move-column-right" @click="fire('move-column-right')">
      <span class="ctx-menu-item__label">右移该列</span>
      <span v-if="shortcutFor('move-column-right')" class="velo-kbd">{{ shortcutFor('move-column-right') }}</span>
    </button>
    <button class="ctx-menu-item" data-testid="table-delete-column" @click="fire('delete-column')">
      <span class="ctx-menu-item__label">删除列</span>
      <span v-if="shortcutFor('delete-column')" class="velo-kbd">{{ shortcutFor('delete-column') }}</span>
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

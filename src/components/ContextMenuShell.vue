<script setup lang="ts">
// 右键菜单通用壳组件 —— 消除 4 份 *ContextMenu.vue 各写一遍的
// Teleport + fixed 定位 + 壳样式 + @contextmenu.prevent + rootEl expose。
//
// 调用方在自己的模板里 <ContextMenuShell :x="x" :y="y"> 包裹菜单项即可；
// 需要自定义 data 属性（如 data-tree-context-menu）走 $attrs 自动透传到
// 内层 div（inheritAttrs: false + v-bind="$attrs" 显式绑定）。
//
// **不抽"数据驱动的通用菜单"**：各菜单的"是否显示某项"逻辑差异太大
// （按 isDir / filePath / dirty / isTauri 等），强行 items 数组化会把
// 判断散到调用方。Shell 只管壳，菜单项由各 *ContextMenu 组件用 slot 写。

import { ref } from 'vue'

defineOptions({ inheritAttrs: false })

defineProps<{
  /** 视口坐标（mouseEvent.clientX/Y，父级已 clamp） */
  x: number
  y: number
  /** Tailwind 最小宽度 class，默认 min-w-48（192px） */
  minWidthClass?: string
}>()

const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      v-bind="$attrs"
      class="fixed z-50 min-w-48 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800 dark:text-gray-200"
      :class="minWidthClass"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

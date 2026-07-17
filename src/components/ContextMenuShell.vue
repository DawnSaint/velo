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
//
// 自适应定位：挂载后读取实际高度，如果超出视口底部则向上翻转（top = y - height），
// 同时 clamp left 防止水平溢出。调用方传入的 x/y 是鼠标点击位置（可能已 clamp）。

import { ref, onMounted, nextTick } from 'vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** 视口坐标（mouseEvent.clientX/Y，父级已 clamp） */
  x: number
  y: number
  /** Tailwind 最小宽度 class，默认 min-w-48（192px） */
  minWidthClass?: string
}>()

const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })

// 实际渲染后的定位坐标（可能从 x/y 翻转/clamp）
const posLeft = ref(props.x)
const posTop = ref(props.y)

onMounted(async () => {
  await nextTick()
  const el = rootEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const margin = 8
  // 垂直：如果向下展开超出视口底部，且向上翻转后有足够空间，则向上翻转
  if (posTop.value + rect.height > window.innerHeight - margin) {
    const flippedTop = posTop.value - rect.height
    // 翻转后不低于视口顶部（否则保持原位，让浏览器自然裁切）
    if (flippedTop >= margin) {
      posTop.value = flippedTop
    } else {
      // 向上也不够 → 尽量贴顶
      posTop.value = margin
    }
  }
  // 水平：clamp 防止右溢出
  if (posLeft.value + rect.width > window.innerWidth - margin) {
    posLeft.value = Math.max(margin, window.innerWidth - rect.width - margin)
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      v-bind="$attrs"
      class="fixed z-[1100] min-w-48 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800 dark:text-gray-200"
      :class="minWidthClass"
      :style="{ left: `${posLeft}px`, top: `${posTop}px` }"
      role="menu"
      @contextmenu.prevent
    >
      <slot />
    </div>
  </Teleport>
</template>

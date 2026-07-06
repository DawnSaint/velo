<script setup lang="ts">
// ActivityBar 右键菜单(v0.6.1):
//  - 列出全部 4 个入口(files / outline / search / settings),每项带勾选态,
//    点击 toggle 显隐 —— 允许连续切换多项不关菜单(用户通常一次调多项)。
//  - 末尾「重置默认」:恢复默认顺序 + 全部显示,点击后关菜单(由父级关)。
//  - 沿用 TabContextMenu / FileTreeContextMenu 同款范式:Teleport 到 body +
//    defineExpose({ rootEl }) + 父级(ActivityBar)统一挂全局 pointerdown /
//    Escape。组件本身不挂监听,keep-alive / 切菜单 不会留幽灵。
//  - 第三份上下文菜单组件:仍不抽通用 ContextMenu —— 这里是「勾选 toggle +
//    重置」的纯展示,与右键动作菜单的「条件可见项」逻辑不重合,合并会把判断
//    散到调用方(见 file-tree.md 维护者注意点)。

import { ref } from 'vue'
import { Check } from '@lucide/vue'
import type { ActivityBarItem } from '@/stores/editor'

defineProps<{
  /** 视口坐标(contextmenu event clientX/Y,父级已 clamp) */
  x: number
  y: number
  /** 菜单条目(父级按固定展示序传入,不随用户自定义顺序变) */
  items: Array<{ key: ActivityBarItem, label: string, visible: boolean }>
}>()

const emit = defineEmits<{
  (e: 'toggle', key: ActivityBarItem): void
  (e: 'reset'): void
}>()

/** 父级拿这个 ref 给全局 pointerdown handler 判定"点内部不关闭"。 */
const rootEl = ref<HTMLDivElement | null>(null)
defineExpose({ rootEl })
</script>

<template>
  <Teleport to="body">
    <div
      ref="rootEl"
      class="velo-activity-context-menu fixed z-50 min-w-44 text-gray-600 rounded-lg bg-white py-1 text-xs shadow-lg dark:bg-gray-800"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.prevent
      @click.stop
    >
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="flex w-[calc(100%-0.5rem)] mx-1 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
        :data-testid="`activity-ctx-toggle-${item.key}`"
        :aria-pressed="item.visible"
        role="menuitemcheckbox"
        @click="emit('toggle', item.key)"
      >
        <span class="flex h-3 w-3 items-center justify-center">
          <Check v-if="item.visible" :size="12" aria-hidden="true" />
        </span>
        <span class="flex-1">{{ item.label }}</span>
      </button>

      <div class="my-1 border-t border-gray-100 dark:border-gray-700" />

      <button
        type="button"
        class="w-[calc(100%-0.5rem)] mx-1 rounded-md px-2 py-2 text-left text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        data-testid="activity-ctx-reset"
        @click="emit('reset')"
      >
        重置为默认
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// ActivityBar 右键菜单(v0.6.1):
//  - 列出全部 4 个入口(files / outline / search / settings),每项带勾选态,
//    点击 toggle 显隐 —— 允许连续切换多项不关菜单(用户通常一次调多项)。
//  - 末尾「重置默认」:恢复默认顺序 + 全部显示,点击后关菜单(由父级关)。
//  - 壳走 ContextMenuShell,菜单项走 .ctx-menu-item 全局 class。
//  - rootEl 通过 defineExpose 暴露给 useContextMenu 的 getMenuEl callback。

import { computed, ref } from 'vue'
import { Check } from '@lucide/vue'
import ContextMenuShell from './ContextMenuShell.vue'
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

/** 父级拿这个 ref 给 useContextMenu 的 getMenuEl callback。 */
const shellRef = ref<InstanceType<typeof ContextMenuShell> | null>(null)
const rootEl = computed(() => shellRef.value?.rootEl ?? null)
defineExpose({ rootEl })
</script>

<template>
  <ContextMenuShell ref="shellRef" :x="x" :y="y" min-width-class="min-w-44" @click.stop>
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      class="ctx-menu-item flex items-center gap-2"
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

    <div class="ctx-menu-separator" />

    <button
      type="button"
      class="ctx-menu-item text-gray-500 dark:text-gray-400"
      data-testid="activity-ctx-reset"
      @click="emit('reset')"
    >
      重置为默认
    </button>
  </ContextMenuShell>
</template>

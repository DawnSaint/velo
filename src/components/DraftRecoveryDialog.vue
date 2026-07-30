<script setup lang="ts">
// 启动时弹出,展示上一次会话留下的"未保存草稿"。
// 用户可以一条条恢复 / 丢弃,也可以一键全丢 / 暂不处理(下次启动还会再问)。

import { computed } from 'vue'
import type { Draft } from '@/stores/persistence'

const props = defineProps<{
  drafts: Draft[]
  visible: boolean
}>()

const emit = defineEmits<{
  recover: [id: string]
  discard: [id: string]
  dismiss: []
}>()

function fileName(path: string | null): string {
  if (!path) return '未命名文档'
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function preview(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

const hasDrafts = computed(() => props.drafts.length > 0)

function onRecover(id: string) {
  emit('recover', id)
}
function onDiscard(id: string) {
  emit('discard', id)
}
function onDismiss() {
  emit('dismiss')
}
function onBackdropClick(e: MouseEvent) {
  // 只有点背景层才关闭,避免点到卡片内部误关
  if (e.target === e.currentTarget) onDismiss()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="draft-fade">
      <div
        v-if="visible && hasDrafts"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
        @click="onBackdropClick"
      >
        <div
          class="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl dark:bg-[#1e1e1e] dark:shadow-black/60"
        >
          <!-- 头部 -->
          <div class="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              恢复未保存的草稿
            </h2>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              上次会话意外中断,以下 {{ drafts.length }} 个文档有未保存的修改。
            </p>
          </div>

          <!-- 列表 -->
          <div class="flex-1 overflow-y-auto px-6 py-3">
            <ul class="space-y-2">
              <li
                v-for="draft in drafts"
                :key="draft.id"
                class="group flex items-start gap-3 rounded-lg border border-gray-200 p-3 transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-[#262626]"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline gap-2">
                    <span class="truncate font-medium text-gray-900 dark:text-gray-100">
                      {{ fileName(draft.originalPath) }}
                    </span>
                    <span class="shrink-0 text-xs text-gray-400">
                      {{ relativeTime(draft.savedAt) }}
                    </span>
                  </div>
                  <div
                    v-if="draft.originalPath"
                    class="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500"
                    :title="draft.originalPath"
                  >
                    {{ draft.originalPath }}
                  </div>
                  <div class="mt-2 line-clamp-2 text-xs text-gray-600 dark:text-gray-300">
                    {{ preview(draft.content) || '（空内容）' }}
                  </div>
                </div>
                <div class="flex shrink-0 flex-col gap-1.5">
                  <button
                    class="rounded-md bg-[#0F4C81] px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-[#0d3f6b]"
                    @click="onRecover(draft.id)"
                  >
                    恢复
                  </button>
                  <button
                    class="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    @click="onDiscard(draft.id)"
                  >
                    丢弃
                  </button>
                </div>
              </li>
            </ul>
          </div>

          <!-- 底部 -->
          <div class="flex items-center justify-between gap-3 border-t border-gray-200 px-6 py-3 dark:border-gray-700">
            <button
              class="text-sm text-gray-500 transition-colors hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
              @click="drafts.forEach(d => onDiscard(d.id))"
            >
              全部丢弃
            </button>
            <button
              class="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              @click="onDismiss"
            >
              暂不处理
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 进入 / 退出动画 */
.draft-fade-enter-active,
.draft-fade-leave-active {
  transition: opacity 0.18s ease;
}
.draft-fade-enter-from,
.draft-fade-leave-to {
  opacity: 0;
}
</style>

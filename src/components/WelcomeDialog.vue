<script setup lang="ts">
// 首次启动欢迎对话框。三个入口：新建空白文档、打开已有文件、浏览示例文档。
//
// 注意：本组件只 emit 示例的 key('syntax' / 'code'),不读盘 —— 读盘 / 路径
// 拼接由 App.vue 在 `loadSample(key)` 单点处理,避免多处分散 `join` 逻辑。

import { SAMPLE } from '@/utils/samples'
import { FilePlus, FolderOpen, BookOpen } from '@lucide/vue'

const props = defineProps<{
  visible: boolean
  /** samples 是否成功抽取到磁盘。为 false 时只展示"新建/打开"。 */
  samplesAvailable: boolean
}>()

const emit = defineEmits<{
  'create-blank': []
  'open-file': []
  /** 传 SAMPLE_ENTRIES.key */
  'open-sample': [key: string]
}>()
</script>

<template>
  <Teleport to="body">
    <Transition name="welcome-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      >
        <div
          class="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl dark:bg-[#1e1e1e] dark:shadow-black/60"
        >
          <!-- 头部 -->
          <div class="border-b border-gray-200 px-6 py-5 dark:border-gray-700">
            <h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Welcome to Velo
            </h2>
            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
              选择你希望如何开始
            </p>
          </div>

          <!-- 选项列表 -->
          <div class="px-6 py-4">
            <button
              class="flex w-full items-center gap-3 rounded-2xl border border-gray-200 p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-[#262626]"
              @click="$emit('create-blank')"
            >
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#0F4C81]/10 text-[#0F4C81] dark:bg-[#0F4C81]/20">
                <FilePlus class="h-5 w-5" />
              </div>
              <div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-100">新建空白文档</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">从零开始写作</div>
              </div>
            </button>

            <button
              class="flex w-full items-center gap-3 rounded-2xl border border-gray-200 mt-3 p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-[#262626]"
              @click="$emit('open-file')"
            >
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#0F4C81]/10 text-[#0F4C81] dark:bg-[#0F4C81]/20">
                <FolderOpen class="h-5 w-5" />
              </div>
              <div>
                <div class="text-sm font-medium text-gray-900 dark:text-gray-100">打开已有文件</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">打开工作区或 .md 文件</div>
              </div>
            </button>

            <!-- 示例文档组 -->
            <div class="mt-3">
              <div class="mb-1.5 px-1 text-xs font-medium text-gray-400 dark:text-gray-500">
                示例文档
              </div>
              <template v-if="props.samplesAvailable">
                <button
                  class="flex w-full items-center gap-3 rounded-2xl border border-gray-200 p-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-[#262626]"
                  @click="$emit('open-sample', SAMPLE.key)"
                >
                  <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                    <BookOpen class="h-5 w-5" />
                  </div>
                  <div class="min-w-0">
                    <div class="text-sm font-medium text-gray-900 dark:text-gray-100">{{ SAMPLE.label }}</div>
                    <div class="text-xs text-gray-500 dark:text-gray-400">{{ SAMPLE.description }}</div>
                  </div>
                </button>
              </template>
              <div
                v-else
                class="rounded-lg border border-dashed border-gray-300 p-4 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
              >
                示例文档暂不可用
              </div>
            </div>
          </div>

        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.welcome-fade-enter-active,
.welcome-fade-leave-active {
  transition: opacity 0.2s ease;
}
.welcome-fade-enter-from,
.welcome-fade-leave-to {
  opacity: 0;
}
</style>
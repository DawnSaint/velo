<script setup lang="ts">

import { computed, ref, watch } from 'vue'
import EditorInner from './EditorInner.vue'
import FindReplace from './findreplace/FindReplace.vue'
import { createPmBackend } from './findreplace/backend'
import type { CursorPosition } from '@/utils/editorCursor'
import type { HeadingBreadcrumb } from '@/utils/breadcrumbs'

const props = withDefaults(defineProps<{
  modelValue: string
  fontFamily?: string
  fontSize?: string
  darkMode?: boolean
  /** 查找面板开关。v-model:find-open 双绑,App.vue 持有。 */
  findOpen?: boolean
  /** 只读模式：禁用编辑器输入。 */
  readOnly?: boolean
  /** 专注模式：当前段落外内容降透明度。 */
  focusMode?: boolean
  /** 打字机模式：光标锁定在视口中线（文档在光标下滚动）。 */
  typewriterMode?: boolean
}>(), {
  fontFamily: '-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif',
  fontSize: '16px',
  darkMode: false,
  findOpen: false,
  readOnly: false,
  focusMode: false,
  typewriterMode: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** v-model:find-open 的 update 端。FindReplace 关闭(X / Esc)时触发,
   *  把父级的 findOpen 翻成 false —— 唯一的回流路径。 */
  'update:findOpen': [open: boolean]
  'cursor-position-change': [position: CursorPosition]
  'heading-context-change': [chain: HeadingBreadcrumb[]]
  /** FindReplace 内按 Ctrl+Shift:F → 切全局搜索,App.vue 关本面板 + 开侧栏 search tab */
  'open-global-search': []
}>()

// CSS 自定义属性,响应式注入到容器上(--md-primary-color 由 App.vue 统一设在 <html>)
const editorStyle = computed(() => ({
  '--md-font-family': props.fontFamily,
  '--md-font-size': props.fontSize,
}))

// ========== 点卡片空白处 → 焦点拉回编辑器 ==========
// click 事件向上冒泡,点 .velo-editor 的 padding 时 target 是 .velo-editor 自己,
// 不会冒泡到作为子级的 <EditorInner>。所以这里把 @click 挂在最外层 card div 上,
// 走 defineExpose 拿到的 focusEditor() 调到 inner 里的 editor。
const innerRef = ref<InstanceType<typeof EditorInner> | null>(null)
function onCardClick() {
  innerRef.value?.focusEditor()
}

// ========== 查找替换面板 ==========
// 状态全在 App.vue(v-model:find-open 透传),本组件只做透传 + 把 FindReplace
// 关闭事件回写给父级。父级改 findOpen / findInitialQuery / findInitialShowReplace
// → prop 流下来 → FindReplace watch 触发。这里没有任何镜像的本地 ref。
/** 拿当前 inner 的 EditorView。modelValue 切换走 view.updateState,view 实例不变,
 *  这里返回的引用一直有效。 */
function getEditorView() {
  return innerRef.value?.getEditorView() ?? null
}

/** FindReplace 关闭时(点 X / 按 Esc)唯一回流路径 → 父级 v-model 翻成 false */
function onFindClose() {
  emit('update:findOpen', false)
}

// 保留 watch 占位(原本监听 props 变化)
watch(() => props.modelValue, () => {
  // 实际更新由 EditorInner 内部 watch props.modelValue 完成,这里 no-op
})

defineExpose({ getEditorView })
</script>

<template>
  <div
    :style="editorStyle"
    class="relative flex-1 min-w-0 bg-white dark:bg-[#1e1e1e]"
    @click="onCardClick"
  >
    <div v-velo-scroll class="flex justify-center h-full w-full overflow-auto px-8 py-6 relative">
      <div
        :class="{
          'dark': props.darkMode,
          'focus-mode': props.focusMode,
        }"
        class="velo-editor h-full w-full min-w-0 max-w-[64vw]"
      >
        <!--
          modelValue 外部变化(切文件 / CLI 打开 / fs:watch 同步)→ EditorInner
          内部 watch 直接 view.updateState,无需 :key 重挂,view 实例稳定。
          ref 用于外层点击拉焦点。
        -->
        <EditorInner
          ref="innerRef"
          :model-value="modelValue"
          :read-only="readOnly"
          :focus-mode="focusMode"
          :typewriter-mode="typewriterMode"
          @update:model-value="emit('update:modelValue', $event)"
          @cursor-position-change="emit('cursor-position-change', $event)"
          @heading-context-change="emit('heading-context-change', $event)"
        />
      </div>
    </div>
    <FindReplace
      :open="props.findOpen"
      :backend-getter="() => { const v = getEditorView(); return v ? createPmBackend(v) : null }"
      @close="onFindClose"
      @open-global-search="emit('open-global-search')"
    />
  </div>

</template>

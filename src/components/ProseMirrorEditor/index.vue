<script setup lang="ts">

import { computed, ref, watch } from 'vue'
import EditorInner from './EditorInner.vue'
import FindReplace from './findreplace/FindReplace.vue'

const props = withDefaults(defineProps<{
  modelValue: string
  fontFamily?: string
  fontSize?: string
  primaryColor?: string
  codeBlockTheme?: string
  isMacCodeBlock?: boolean
  darkMode?: boolean
  /** 查找面板开关。v-model:find-open 双绑,App.vue 持有。 */
  findOpen?: boolean
  /** Ctrl+F/Ctrl+H 触发时由父级写入,FindReplace watch open 时读一次后清空用。 */
  findInitialQuery?: string
  /** Ctrl+H 触发时为 true,FindReplace 初始化时展开 replace 行。 */
  findInitialShowReplace?: boolean
}>(), {
  fontFamily: '-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif',
  fontSize: '14px',
  primaryColor: '#0F4C81',
  codeBlockTheme: 'https://cdn-doocs.oss-cn-shenzhen.aliyuncs.com/npm/highlightjs/11.11.1/styles/github.min.css',
  isMacCodeBlock: true,
  darkMode: false,
  findOpen: false,
  findInitialQuery: '',
  findInitialShowReplace: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  /** v-model:find-open 的 update 端。FindReplace 关闭(X / Esc)时触发,
   *  把父级的 findOpen 翻成 false —— 唯一的回流路径。 */
  'update:findOpen': [open: boolean]
}>()

// CSS 自定义属性,响应式注入到容器上
const editorStyle = computed(() => ({
  '--md-primary-color': props.primaryColor,
  '--md-font-family': props.fontFamily,
  '--md-font-size': props.fontSize,
}))

// ========== 代码块主题:加载 highlight.js CSS ==========
function loadCodeTheme() {
  const cssUrl = props.codeBlockTheme
  const el = document.querySelector(`#hljs`)
  if (el) {
    el.setAttribute(`href`, cssUrl)
  }
  else {
    const link = document.createElement(`link`)
    link.setAttribute(`type`, `text/css`)
    link.setAttribute(`rel`, `stylesheet`)
    link.setAttribute(`href`, cssUrl)
    link.setAttribute(`id`, `hljs`)
    document.head.appendChild(link)
  }
}
loadCodeTheme()
watch(() => props.codeBlockTheme, () => {
  loadCodeTheme()
  // CSS 换了 → 新代码块要重新染 hljs class;EditorInner 内部已在
  // markdown 解析后 stamp 一次,这里不需额外动作
})

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

defineExpose({ getEditorView })
</script>

<template>
  <div
    :style="editorStyle"
    class="velo-editor-card relative flex-1 rounded-2xl mx-6 mb-6 shadow-xl bg-white dark:bg-[#1e1e1e]"
    @click="onCardClick"
  >
    <div class="flex justify-center h-full w-full overflow-auto px-8 py-6">
      <div
        :class="{
          'mac-code-block': props.isMacCodeBlock,
          'dark': props.darkMode,
        }"
        class="velo-editor h-full w-full max-w-[64vw]"
      >
        <!--
          modelValue 外部变化(切文件 / CLI 打开 / fs:watch 同步)→ EditorInner
          内部 watch 直接 view.updateState,无需 :key 重挂,view 实例稳定。
          ref 用于外层点击拉焦点。
        -->
        <EditorInner
          ref="innerRef"
          :model-value="modelValue"
          @update:model-value="emit('update:modelValue', $event)"
        />
      </div>
    </div>
    <FindReplace
      :open="props.findOpen"
      :editor-view-getter="getEditorView"
      :initial-query="props.findInitialQuery"
      :initial-show-replace="props.findInitialShowReplace"
      @close="onFindClose"
    />
  </div>

</template>


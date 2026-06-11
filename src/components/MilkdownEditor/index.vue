<script setup lang="ts">

import { computed, nextTick, ref, watch } from 'vue'
import { MilkdownProvider } from '@milkdown/vue'
import EditorInner from './EditorInner.vue'
import FindReplace from './FindReplace.vue'

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
  // CSS 换了 → 新代码块要重新染 hljs class
  // inner 内的 hljs 注入在 markdownUpdated 时会跑,新代码块进入视区时也会跑;
  // 这里再 nextTick 一次兜底
  nextTick(() => { /* inner 自己会处理 */ })
})

// ========== EditorInner 重挂控制 ==========
// EditorInner 检测到 modelValue 是外部变化时 emit('rebuildRequest'),本组件 bump innerKey。
// EditorInner 用了 <Milkdown />,key 变化时 Vue 会 destroy 旧的 → useGetEditor 调 editor.destroy();
// 新的 mount → 跑新 factory → 新 editor 灌入新 defaultValueCtx。
const innerKey = ref(0)
function onRebuildRequest() {
  innerKey.value++
}

// ========== 点卡片空白处 → 焦点拉回编辑器 ==========
// click 事件向上冒泡,点 .milkdown-editor 的 padding 时 target 是 .milkdown-editor 自己,
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
/** 拿当前 inner 的 EditorView;切文件 inner 重建后,这个调用会拿到新的 view */
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
        class="milkdown-editor h-full w-full max-w-[64vw]"
      >
        <MilkdownProvider>
          <!--
            innerKey 由 EditorInner 探测到外部 modelValue 变化时 bump,
            触发 EditorInner 整体重挂,等价于原来 createEditor() 的重建语义。
            ref 用于外层点击拉焦点。
            focus-on-create:innerKey > 0 → 当前这次挂载是一次 rebuild
            (切文件 / CLI 打开 / 外部同步),让 EditorInner 把光标落进编辑区;
            首次挂载(innerKey === 0)不抢焦点,避免把 DraftRecoveryDialog 等
            启动期弹窗的焦点踢走。
          -->
          <EditorInner
            ref="innerRef"
            :key="innerKey"
            :model-value="modelValue"
            :focus-on-create="innerKey > 0"
            @update:model-value="emit('update:modelValue', $event)"
            @rebuild-request="onRebuildRequest"
          />
        </MilkdownProvider>
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

<style>
/* ProseMirror 编辑区基础样式 */
.milkdown-editor .ProseMirror {
  outline: none;
  min-height: 100%;
  padding-bottom: 64px;
  word-wrap: break-word;
  white-space: pre-wrap;
  white-space: break-spaces;
  -webkit-font-variant-ligatures: none;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0;
  tab-size: 8;
  -moz-tab-size: 8;
}

/*
  ProseMirror 末尾自动追加的内置元素(支持光标停在最后一个非文本节点后):
    - .ProseMirror-trailingBreak:文档最末尾的 <br>,让光标可以停在非文本节点之后
    - .ProseMirror-separator:紧邻 trailingBreak 前的 <img>,widget decoration 的视觉分隔
  这俩元素没有默认样式,在我们这里会显示成"凭空冒出来的 br/img",尤其在
  插入 math_block 这种 block-level atomic 节点后特别明显(节点末尾追加一对)。
  不能禁掉 —— ProseMirror 用它们管末尾指针。这里把宽度归零,inline 排版,
  既不占视觉空间,又保留 ProseMirror 的内部行为。
*/
.milkdown-editor .ProseMirror-separator {
  display: inline !important;
  width: 0;
  user-select: none;
  pointer-events: none;
}
.milkdown-editor .ProseMirror-trailingBreak {
  display: inline;
  width: 0;
  user-select: none;
  pointer-events: none;
}

/* 占位提示 */
.milkdown-editor .ProseMirror p.is-editor-empty:first-child::before {
  color: #adb5bd;
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}

/* 选区样式 */
.milkdown-editor .ProseMirror ::selection {
  background: #b4d5ff;
}

/* 查找替换高亮(findHighlightPlugin 加的 Decoration)。
   velo-find-match: 所有命中
   velo-find-current: 当前 match(findNext / findPrev 选中那个)
   ::selection 只在选区处于焦点元素时绘制 —— 焦点在 find 输入里时 ::selection
   不会画,所以必须用 Decoration 才能在用户 navigate 时持续看到高亮。 */
.velo-find-match {
  background-color: rgba(255, 215, 0, 0.35);
  border-radius: 2px;
}
.velo-find-current {
  background-color: rgba(255, 165, 0, 0.6);
  border-radius: 2px;
  box-shadow: 0 0 0 1px rgba(255, 140, 0, 0.7);
}

/* 公式编辑时隐藏 ProseMirror 光标 */
.prosemirror-caret-hidden .ProseMirror {
  caret-color: transparent !important;
}

/* ========== 基础排版(使用 CSS 变量,支持 props 响应) ========== */
.milkdown-editor {
  font-family: var(--md-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--md-font-size, 16px);
  line-height: 1.75;
  color: #333;
}

/* ========== 通用元素样式 ========== */

/* 标题基础尺寸 */
.milkdown-editor h1 {
  font-size: 1.6em;
  font-weight: bold;
  margin: 1.5em 0 0.5em;
}

.milkdown-editor h2 {
  font-size: 1.4em;
  font-weight: bold;
  margin: 1.4em 0 0.5em;
}

.milkdown-editor h3 {
  font-size: 1.2em;
  font-weight: bold;
  margin: 1.3em 0 0.5em;
}

.milkdown-editor h4,
.milkdown-editor h5,
.milkdown-editor h6 {
  font-size: 1.1em;
  font-weight: bold;
  margin: 1.2em 0 0.5em;
}

.milkdown-editor p {
  margin: 0.5em 0;
}

.milkdown-editor blockquote {
  padding: 0.25em 1em;
  font-style: italic;
  border-left: 4px solid #ddd;
  color: #666;
}

.milkdown-editor ul,
.milkdown-editor ol {
  padding-left: 2em;
  margin: 0.5em 0;
}

.milkdown-editor ul {
  list-style-type: disc;
}

.milkdown-editor ul li::marker,
.milkdown-editor ol li::marker {
  color: var(--md-primary-color, #1F71D9);
}

.milkdown-editor ul ul {
  list-style-type: circle;
}

.milkdown-editor ul ul ul {
  list-style-type: square;
}

.milkdown-editor ol {
  list-style-type: decimal;
}

.milkdown-editor ol ol {
  list-style-type: lower-alpha;
}

.milkdown-editor ol ol ol {
  list-style-type: lower-roman;
}

.milkdown-editor li {
  margin: 0.25em 0;
}

/* ========== 任务列表 ========== */

.milkdown-editor li[data-item-type="task"] {
  list-style: none;
  position: relative;
  padding-left: 1.8em;
}

.milkdown-editor li[data-item-type="task"] > .task-checkbox {
  position: absolute;
  left: 0;
  top: 0.5em;
  width: 1em;
  height: 1em;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s, border-color 0.15s;
}

.milkdown-editor li[data-item-type="task"] > .task-checkbox:hover {
  border-color: var(--md-primary-color, #1F71D9);
}

.milkdown-editor li[data-item-type="task"][data-checked="true"] > .task-checkbox {
  background: var(--md-primary-color, #1F71D9);
  border-color: var(--md-primary-color, #1F71D9);
}

.milkdown-editor li[data-item-type="task"][data-checked="true"] > .task-checkbox::after {
  content: '';
  position: absolute;
  left: 0.3em;
  top: 0.1em;
  width: 0.25em;
  height: 0.6em;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

.milkdown-editor li[data-item-type="task"][data-checked="true"] > .task-content {
  color: #999;
  text-decoration: line-through;
}

/* 行内代码 */
.milkdown-editor code {
  font-family: Menlo, Operator Mono, Consolas, Monaco, monospace;
  background: rgba(0, 0, 0, 0.05);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  color: #d14;
}

/* 代码块 */
.milkdown-editor pre {
  margin: 1em 0;
  padding: 1em;
  background: #f5f5f5;
  border-radius: 8px;
  overflow-x: auto;
}

.milkdown-editor pre code {
  background: none;
  padding: 0;
  border-radius: 0;
  font-size: 0.9em;
  color: inherit;
}

.milkdown-editor img {
  max-width: 100%;
  max-height: 400px;
  height: auto;
  display: block;
  margin: 0 auto;
  border-radius: 4px;
}

/* ProseMirror drop-cursor:拖动时在落点画一条光标线(类似 Typora)
   dropCursor({ color: false, class: 'velo-drop-cursor' }) 用 class hook */
.velo-drop-cursor {
  background: var(--md-primary-color, #1F71D9);
  width: 2px;
  margin-left: -1px;
  pointer-events: none;
}

/* ========== @milkdown/kit/component/image-inline 样式 ==========
   image-inline 的 NodeView DOM:
     <span class="milkdown-image-inline">     ← wrapper(空态 + 有图态共用)
       空态: <div class="image-edit">...<input class="link-input-area">...<img class="image-preview">
       有图态: <img class="image-inline">
   选中时 wrapper 加 .selected(由 NodeView.selectNode 加)。*/

/* 包装 span 转 block 撑满行宽,里面内容(text-align: center)居中 */
.milkdown-image-inline {
  display: block;
  text-align: center;
}

/* 有图态:img 居中,outline 透明(默认) */
.milkdown-image-inline > img.image-inline {
  display: inline-block;
  vertical-align: middle;
  max-width: 100%;
  max-height: 400px;
  height: auto;
  border-radius: 4px;
  outline: 1px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.12s;
}

/* hover:低调灰边 */
.milkdown-image-inline:hover > img.image-inline {
  outline-color: rgba(0, 0, 0, 0.2);
}

.dark .milkdown-image-inline:hover > img.image-inline {
  outline-color: rgba(255, 255, 255, 0.25);
}

/* 选中:ProseMirror NodeSelection 触发,NodeView.selectNode() 加 .selected */
.milkdown-image-inline.selected > img.image-inline {
  outline-color: var(--md-primary-color, #1F71D9);
  outline-width: 2px;
}

/* 空态 input 框/上传按钮/预览图 —— 跟 image-inline 提供的默认 UI 配套 */
.milkdown-image-inline .image-edit {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px dashed rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.02);
  color: #666;
  font-size: 13px;
}

.dark .milkdown-image-inline .image-edit {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.04);
  color: #aaa;
}

.milkdown-image-inline .link-importer {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.milkdown-image-inline .link-input-area {
  padding: 4px 8px;
  font-size: 13px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 4px;
  background: inherit;
  color: inherit;
  min-width: 200px;
}

.dark .milkdown-image-inline .link-input-area {
  border-color: rgba(255, 255, 255, 0.2);
}

.milkdown-image-inline .image-preview img {
  max-width: 200px;
  max-height: 100px;
  border-radius: 4px;
}

.milkdown-image-inline .placeholder {
  cursor: text;
  color: rgba(0, 0, 0, 0.5);
}

.dark .milkdown-image-inline .placeholder {
  color: rgba(255, 255, 255, 0.5);
}

.milkdown-image-inline .milkdown-icon {
  font-size: 18px;
  line-height: 1;
  user-select: none;
}

.milkdown-image-inline .uploader {
  cursor: pointer;
  padding: 0 4px;
  border-radius: 4px;
}

.milkdown-image-inline .confirm {
  cursor: pointer;
  padding: 0 4px;
  color: var(--md-primary-color, #1F71D9);
}

.milkdown-editor table {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
}

.milkdown-editor th,
.milkdown-editor td {
  border: 1px solid #ddd;
  padding: 0.5em 1em;
  text-align: left;
}

.milkdown-editor th {
  background: #f5f5f5;
  font-weight: bold;
}

.milkdown-editor hr {
  border: none;
  border-top: 2px solid #eee;
  margin: 2em 0;
}

.milkdown-editor a {
  color: #576b95;
  text-decoration: none;
}

.milkdown-editor strong {
  font-weight: bold;
  color: var(--md-primary-color, inherit);
}

.milkdown-editor em {
  font-style: italic;
}

/* ========== 标题装饰样式 ========== */

.milkdown-editor h1 {
  padding-bottom: 0.3em;
  color: var(--md-primary-color, #333);
  text-align: center;
}

.milkdown-editor h2 {
  padding: 0.3em 0;
  color: var(--md-primary-color, #333);
}

.milkdown-editor h3 {
  padding: 0.4em 0.5em;
  border-left: 4px solid var(--md-primary-color, #333);
  border-right: 1px solid color-mix(in srgb, var(--md-primary-color, #333) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--md-primary-color, #333) 10%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--md-primary-color, #333) 10%, transparent);
  background: color-mix(in srgb, var(--md-primary-color, #333) 6%, transparent);
}

.milkdown-editor h4,
.milkdown-editor h5,
.milkdown-editor h6 {
  color: var(--md-primary-color, #333);
}

/* ========== 暗色模式适配 ========== */

.dark .milkdown-editor,
.milkdown-editor.dark {
  color: #d4d4d4;
  background: #1e1e1e;
}

.dark .milkdown-editor .ProseMirror ::selection,
.milkdown-editor.dark .ProseMirror ::selection {
  background: #264f78;
}

.dark .milkdown-editor blockquote,
.milkdown-editor.dark blockquote {
  color: #999;
}

.dark .milkdown-editor code,
.milkdown-editor.dark code {
  background: rgba(255, 255, 255, 0.1);
  color: #f77878;
}

.dark .milkdown-editor pre,
.milkdown-editor.dark pre {
  background: #2d2d2d;
}

.dark .milkdown-editor th,
.milkdown-editor.dark th {
  background: #2d2d2d;
}

.dark .milkdown-editor th,
.dark .milkdown-editor td,
.milkdown-editor.dark th,
.milkdown-editor.dark td {
  border-color: #555;
}

.dark .milkdown-editor hr,
.milkdown-editor.dark hr {
  border-top-color: #444;
}

/* 暗色模式下 h4-h6 稍微提亮,确保可读性 */
.dark .milkdown-editor h4,
.dark .milkdown-editor h5,
.dark .milkdown-editor h6,
.milkdown-editor.dark h4,
.milkdown-editor.dark h5,
.milkdown-editor.dark h6 {
  filter: brightness(1.3);
}

/* 暗色模式下的任务列表 checkbox */
.dark .milkdown-editor li[data-item-type="task"] > .task-checkbox,
.milkdown-editor.dark li[data-item-type="task"] > .task-checkbox {
  background: #2d2d2d;
  border-color: #555;
}

.dark .milkdown-editor li[data-item-type="task"][data-checked="true"] > .task-content,
.milkdown-editor.dark li[data-item-type="task"][data-checked="true"] > .task-content {
  color: #6a6a6a;
}

/* ========== Mac 代码块:红黄绿圆点装饰 ========== */
.mac-code-block.milkdown-editor pre {
  position: relative;
  padding-top: 2.4em;
}

.mac-code-block.milkdown-editor pre::before {
  content: '';
  position: absolute;
  top: 0.9em;
  left: 1em;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ed6c60;
  box-shadow:
    20px 0 0 #f7c151,
    40px 0 0 #64c856;
}

</style>

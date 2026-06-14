<script setup lang="ts">

import { computed, nextTick, ref, watch } from 'vue'
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
/* ========== ProseMirror 编辑区基础 ========== */
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
  separator 的 display 用 !important 覆盖 ProseMirror 默认的 inline-block。
*/
.milkdown-editor .ProseMirror-separator,
.milkdown-editor .ProseMirror-trailingBreak {
  width: 0;
  user-select: none;
  pointer-events: none;
}
.milkdown-editor .ProseMirror-separator { display: inline !important; }
.milkdown-editor .ProseMirror-trailingBreak { display: inline; }

/* 占位提示 */
.milkdown-editor .ProseMirror p.is-editor-empty:first-child::before {
  color: #adb5bd;
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}

/* 选区 */
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

/* ProseMirror drop-cursor:拖动时在落点画一条光标线(类似 Typora)
   dropCursor({ color: false, class: 'velo-drop-cursor' }) 用 class hook */
.velo-drop-cursor {
  background: var(--md-primary-color, #1F71D9);
  width: 2px;
  margin-left: -1px;
  pointer-events: none;
}

/* ========== 基础排版(CSS 变量响应 props) ========== */
.milkdown-editor {
  font-family: var(--md-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--md-font-size, 16px);
  line-height: 1.75;
  color: #333;
}

/* ========== 标题(尺寸 + 装饰合并在一处) ========== */
.milkdown-editor h1 {
  font-size: 2em;
  font-weight: bold;
  margin: 2em 0 1em;
  color: var(--md-primary-color, #333);
  text-align: center;
}

.milkdown-editor h2 {
  font-size: 1.6em;
  font-weight: bold;
  margin: 1.5em 0 .5em;
  color: var(--md-primary-color, #333);
  border-bottom: 1px solid var(--md-primary-color, #eee);
}

.milkdown-editor h3 {
  font-size: 1.4em;
  font-weight: bold;
  margin-top: 1em;
  color: var(--md-primary-color, #333);
}

.milkdown-editor h4 {
  font-size: 1.2em;
  font-weight: bold;
  margin-top: .5em;
  color: var(--md-primary-color, #333);
}

.milkdown-editor h5 {
  color: var(--md-primary-color, #333);
}

.milkdown-editor h5,
.milkdown-editor h6 {
  font-size: 1em;
  font-weight: bold;
  margin-top: 1.2em;
}


/* ========== 段落 / 引用 / 强调 / 链接 / 分割线 ========== */
.milkdown-editor p {
  margin: 0.5em 0;
}

.milkdown-editor blockquote {
  padding: 0.25em 1em;
  font-style: italic;
  border-left: 4px solid #ddd;
  color: #666;
}

/* ========== GitHub 风格警告框(alert / callout) ==========
   5 种 variant:note / tip / important / warning / caution
   左侧 4px 主题色竖条 + 顶部 type 标签 + GitHub octicon SVG 图标。结构 toDOM:
     <div class="velo-alert velo-alert-{variant}" data-variant="...">
       <p>正文...</p>
     </div>
   ::before 伪元素生成顶部 type 标签(图标用 background-image 内联 SVG,标签文字
   用 content) */
.milkdown-editor .velo-alert {
  margin: 1em 0;
  padding: 0.15em 1em;
  border-left: 4px solid;
  font-style: normal;  /* 覆盖 blockquote 的 italic 防泄漏 */
}
.milkdown-editor .velo-alert::before {
  display: block;
  font-weight: 600;
  font-size: 1em;
  margin-bottom: 0.25em;
  letter-spacing: 0.02em;
  padding-left: 1.4em;
  background-repeat: no-repeat;
  background-position: center left;
  background-size: 1em 1em;
}
.milkdown-editor .velo-alert > :first-child {
  margin-top: 0;
}
.milkdown-editor .velo-alert > :last-child {
  margin-bottom: 0;
}

.milkdown-editor .velo-alert-note { border-left-color: #0969da; }
.milkdown-editor .velo-alert-note::before {
  content: 'Note';
  color: #0969da;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%230969da'><path fill-rule='evenodd' d='M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z'/></svg>");
}
.milkdown-editor .velo-alert-tip { border-left-color: #1a7f37; }
.milkdown-editor .velo-alert-tip::before {
  content: 'Tip';
  color: #1a7f37;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%231a7f37'><path d='M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z' /></svg>");
}
.milkdown-editor .velo-alert-important { border-left-color: #8250df; }
.milkdown-editor .velo-alert-important::before {
  content: 'Important';
  color: #8250df;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%238250df'><path d='M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'/></svg>");
}
.milkdown-editor .velo-alert-warning { border-left-color: #bf8700; }
.milkdown-editor .velo-alert-warning::before {
  content: 'Warning';
  color: #bf8700;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23bf8700'><path fill-rule='evenodd' d='M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.996a.75.75 0 0 1-1.5 0V5.75a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z'/></svg>");
}
.milkdown-editor .velo-alert-caution { border-left-color: #cf222e; }
.milkdown-editor .velo-alert-caution::before {
  content: 'Caution';
  color: #cf222e;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='%23cf222e'><path d='M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z'/></svg>");
}

/* ========== HTML 透传容器 ==========
   nodes/HtmlNodeView.ts 创建的 div / span,DOMPurify sanitize 后的 HTML 写在 innerHTML。
   这里只给容器加微弱视觉边界,让用户区分"这是 HTML 块"。 */
.milkdown-editor .velo-html-block {
  border-radius: 4px;
}
.milkdown-editor .velo-html-inline {
  /* 行内容器本身不加视觉装饰,样式靠下面的具体标签规则 */
}

/* ========== 常见 HTML 透传标签样式 ==========
   sample.md 用到 <kbd>/<sub>/<sup>/<mark>/<abbr>/<details>/<summary>。
   浏览器默认样式很弱(尤其 kbd / mark 在不同 UA 表现不同),这里统一给一套
   GitHub 风格的视觉,亮/暗模式各一组。
   选择器写在 .milkdown-editor 内部,只影响编辑器渲染区域,不污染全局。 */
.milkdown-editor kbd {
  display: inline-block;
  padding: 0.15em 0.5em;
  font-family: Menlo, Operator Mono, Consolas, Monaco, monospace;
  font-size: 0.85em;
  line-height: 1;
  color: #24292f;
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-bottom-width: 2px;
  border-radius: 4px;
  vertical-align: middle;
}
.milkdown-editor mark {
  background: #fff3a3;
  color: inherit;
  padding: 0 0.2em;
  border-radius: 2px;
}
.milkdown-editor sub,
.milkdown-editor sup {
  font-size: 0.75em;
  line-height: 0;
  position: relative;
  vertical-align: baseline;
}
.milkdown-editor sub { bottom: -0.25em; }
.milkdown-editor sup { top: -0.5em; }
.milkdown-editor abbr[title] {
  text-decoration: underline dotted;
  cursor: help;
}
.milkdown-editor details {
  margin: 0.5em 0;
  padding: 0.25em 0.75em;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.02);
}
.milkdown-editor summary {
  cursor: pointer;
  font-weight: 600;
  outline: none;
  padding: 0.25em 0;
}

.milkdown-editor strong {
  font-weight: bold;
  color: var(--md-primary-color, inherit);
}

.milkdown-editor em {
  font-style: italic;
}

.milkdown-editor a {
  color: #576b95;
  text-decoration: none;
  cursor: pointer;
}
.milkdown-editor a:hover {
  text-decoration: underline;
}

.milkdown-editor hr {
  border: none;
  border-top: 2px solid #eee;
  margin: 2em 0;
}

/* ========== 列表 ========== */
.milkdown-editor ul,
.milkdown-editor ol {
  padding-left: 2em;
  margin: 0.5em 0;
}

.milkdown-editor ul { list-style-type: disc; }
.milkdown-editor ul ul { list-style-type: circle; }
.milkdown-editor ul ul ul { list-style-type: square; }

.milkdown-editor ol { list-style-type: decimal; }
.milkdown-editor ol ol { list-style-type: lower-alpha; }
.milkdown-editor ol ol ol { list-style-type: lower-roman; }

.milkdown-editor ul li::marker,
.milkdown-editor ol li::marker {
  color: var(--md-primary-color, #1F71D9);
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

/* ========== 代码 ========== */
.milkdown-editor code {
  font-family: Menlo, Operator Mono, Consolas, Monaco, monospace;
  background: rgba(0, 0, 0, 0.05);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  color: #d14;
}

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

/* Mac 代码块:红黄绿圆点装饰 */
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

/* ========== 表格 ========== */
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

/* ========== 图片(通用) ========== */
.milkdown-editor img {
  max-width: 100%;
  max-height: 400px;
  height: auto;
  display: block;
  margin: 0 auto;
  border-radius: 4px;
}

/* ========== @milkdown/kit/component/image-inline ==========
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

.milkdown-image-inline .image-preview img {
  max-width: 200px;
  max-height: 100px;
  border-radius: 4px;
}

.milkdown-image-inline .placeholder {
  cursor: text;
  color: rgba(0, 0, 0, 0.5);
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

/* ========== 暗色模式 ==========
   两种触发源:外层 <html.dark>(全局 dark) / 编辑器自带 .dark(props.darkMode)。
   用 :is() 把两个父选择器折叠成一个 prefix,避免每条规则都写两遍选择器。 */
:is(.dark .milkdown-editor, .milkdown-editor.dark) {
  color: #d4d4d4;
  background: #1e1e1e;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) .ProseMirror ::selection {
  background: #264f78;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) blockquote {
  color: #999;
}

/* 暗色模式警告框:背景换深色,主题色提亮,SVG 图标也用提亮色 */
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert {
  background: rgba(255, 255, 255, 0.04);
}
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-note { border-left-color: #58a6ff; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-note::before { color: #58a6ff; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-tip { border-left-color: #3fb950; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-tip::before { color: #3fb950; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-important { border-left-color: #a371f7; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-important::before { color: #a371f7; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-warning { border-left-color: #d29922; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-warning::before { color: #d29922; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-caution { border-left-color: #f85149; }
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-alert-caution::before { color: #f85149; }

/* 暗色 HTML 块容器 */
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-html-block {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
}

/* 暗色 kbd / mark / details */
:is(.dark .milkdown-editor, .milkdown-editor.dark) kbd {
  color: #c9d1d9;
  background: #21262d;
  border-color: #444c56;
}
:is(.dark .milkdown-editor, .milkdown-editor.dark) mark {
  background: #5d4d00;
  color: #f0d96f;
}
:is(.dark .milkdown-editor, .milkdown-editor.dark) details {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.03);
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) code {
  background: rgba(255, 255, 255, 0.1);
  color: #f77878;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) pre {
  background: #2d2d2d;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) th {
  background: #2d2d2d;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) :is(th, td) {
  border-color: #555;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) hr {
  border-top-color: #444;
}

/* h4-h6 稍微提亮,确保可读性 */
:is(.dark .milkdown-editor, .milkdown-editor.dark) :is(h4, h5, h6) {
  filter: brightness(1.3);
}

/* 暗色模式链接颜色:亮模式的 #576b95 在 #1e1e1e 上对比度低,改用淡蓝 */
:is(.dark .milkdown-editor, .milkdown-editor.dark) a {
  color: #7aa6d8;
}
:is(.dark .milkdown-editor, .milkdown-editor.dark) a:hover {
  color: #93b9e0;
}

/* ========== inline source edit 视觉指示 ==========
   linkClickPlugin 等编辑态的源码文本加上 .velo-link-source-edit,提示用户
   "这是在编辑 markdown 源码" —— 等宽字体 + 浅灰底,与正文区分开 */
.velo-link-source-edit {
  font-family: Menlo, Operator Mono, Consolas, Monaco, monospace;
  background-color: rgba(0, 0, 0, 0.05);
  border-radius: 3px;
  padding: 0 3px;
  color: #555;
}
:is(.dark .milkdown-editor, .milkdown-editor.dark) .velo-link-source-edit {
  background-color: rgba(255, 255, 255, 0.06);
  color: #aaa;
}

/* 任务列表 checkbox / 完成态文本 */
:is(.dark .milkdown-editor, .milkdown-editor.dark) li[data-item-type="task"] > .task-checkbox {
  background: #2d2d2d;
  border-color: #555;
}

:is(.dark .milkdown-editor, .milkdown-editor.dark) li[data-item-type="task"][data-checked="true"] > .task-content {
  color: #6a6a6a;
}

/* image-inline 暗色态。注意:原代码这里只用 .dark 祖先(没配对 .milkdown-editor.dark),
   保持原行为不动。 */
.dark .milkdown-image-inline:hover > img.image-inline {
  outline-color: rgba(255, 255, 255, 0.25);
}

.dark .milkdown-image-inline .image-edit {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.04);
  color: #aaa;
}

.dark .milkdown-image-inline .link-input-area {
  border-color: rgba(255, 255, 255, 0.2);
}

.dark .milkdown-image-inline .placeholder {
  color: rgba(255, 255, 255, 0.5);
}
</style>

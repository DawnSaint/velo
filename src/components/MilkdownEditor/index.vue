<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { math } from '@milkdown/plugin-math'
import { keymap } from '@milkdown/prose/keymap'
import { $prose } from '@milkdown/utils'
import { mathEditPlugin } from './MathNodeViews'
import { mermaidSyntax } from './MermaidSyntax'
import { mermaidEditPlugin } from './MermaidNodeView'
import 'katex/dist/katex.min.css'

// 覆盖 Milkdown 内置行为：在标题前按退格 → 直接转为正文，而非降级（h2→h1）
const headingBackspaceToParagraph = $prose(() =>
  keymap({
    Backspace: (state, dispatch) => {
      const { $from } = state.selection
      const node = $from.node()
      if (
        node.type.name === 'heading'
        && state.selection.empty
        && $from.parentOffset === 0
      ) {
        if (dispatch) {
          const paragraphType = state.schema.nodes.paragraph
          dispatch(
            state.tr.setBlockType(
              $from.before(),
              $from.after(),
              paragraphType,
            ),
          )
        }
        return true
      }
      return false
    },
    Delete: (state, dispatch) => {
      const { $from } = state.selection
      const node = $from.node()
      if (
        node.type.name === 'heading'
        && state.selection.empty
        && $from.parentOffset === 0
      ) {
        if (dispatch) {
          const paragraphType = state.schema.nodes.paragraph
          dispatch(
            state.tr.setBlockType(
              $from.before(),
              $from.after(),
              paragraphType,
            ),
          )
        }
        return true
      }
      return false
    },
  }),
)

const props = withDefaults(defineProps<{
  modelValue: string
  fontFamily?: string
  fontSize?: string
  primaryColor?: string
  codeBlockTheme?: string
  isMacCodeBlock?: boolean
  darkMode?: boolean
}>(), {
  fontFamily: '-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif',
  fontSize: '14px',
  primaryColor: '#0F4C81',
  codeBlockTheme: 'https://cdn-doocs.oss-cn-shenzhen.aliyuncs.com/npm/highlightjs/11.11.1/styles/github.min.css',
  isMacCodeBlock: true,
  darkMode: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const containerRef = ref<HTMLDivElement>()
let editorInstance: Awaited<ReturnType<typeof Editor.make>> | null = null
const isInternalChange = ref(false)

// CSS 自定义属性，响应式注入到容器上
const editorStyle = computed(() => ({
  '--md-primary-color': props.primaryColor,
  '--md-font-family': props.fontFamily,
  '--md-font-size': props.fontSize,
}))

// ========== 代码块主题：加载 highlight.js CSS ==========
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
  nextTick(() => stampHljsClass())
})

// ========== hljs class 注入 ==========
function stampHljsClass() {
  if (!containerRef.value) return
  const blocks = containerRef.value.querySelectorAll('.ProseMirror pre')
  blocks.forEach(pre => pre.classList.add('hljs'))
}
function scheduleHljsStamp() {
  nextTick(() => stampHljsClass())
}

async function createEditor() {
  if (!containerRef.value) return

  // 销毁已有实例
  if (editorInstance) {
    try {
      await editorInstance.destroy()
    }
    catch (e) {
      console.error('Failed to destroy Milkdown editor:', e)
    }
    editorInstance = null
  }

  editorInstance = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, containerRef.value!)
      ctx.set(defaultValueCtx, props.modelValue)
      // 监听 Markdown 内容变化 → emit 给父组件
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        isInternalChange.value = true
        emit('update:modelValue', markdown)
        scheduleHljsStamp()
        nextTick(() => {
          isInternalChange.value = false
        })
      })
    })
    .use(headingBackspaceToParagraph)
    .use(commonmark)
    .use(gfm)
    .use(history)
    .use(math)
    .use(mathEditPlugin)
    .use(mermaidSyntax)
    .use(mermaidEditPlugin)
    .use(listener)
    .create()

  // 编辑器创建完成后立即注入 hljs class
  scheduleHljsStamp()
}

onMounted(() => {
  createEditor()
})

onUnmounted(() => {
  if (editorInstance) {
    editorInstance.destroy().catch(console.error)
    editorInstance = null
  }
})

// 外部 modelValue 变化时（切文章 / 从源码模式切换过来），重建编辑器
watch(() => props.modelValue, () => {
  if (isInternalChange.value) return
  createEditor()
})
</script>

<template>
  <div class="flex-1 rounded-2xl mx-8 mb-8 mt-4 shadow-xl bg-white dark:bg-[#1e1e1e]">
    <div class="flex justify-center h-full w-full overflow-auto px-8 py-6">
      <div
        ref="containerRef"
        :class="{
          'mac-code-block': props.isMacCodeBlock,
          'dark': props.darkMode,
        }"
        :style="editorStyle"
        class="milkdown-editor h-full max-w-[64vw]"
      />
    </div>
  </div>

</template>

<style>
/* ========== Milkdown / ProseMirror 基础样式 ========== */

/* ProseMirror 编辑区基础样式 */
.milkdown-editor .ProseMirror {
  outline: none;
  min-height: 100%;
  word-wrap: break-word;
  white-space: pre-wrap;
  white-space: break-spaces;
  -webkit-font-variant-ligatures: none;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0;
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

/* 公式编辑时隐藏 ProseMirror 光标 */
.prosemirror-caret-hidden .ProseMirror {
  caret-color: transparent !important;
}

/* ========== 基础排版（使用 CSS 变量，支持 props 响应） ========== */
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

/* 暗色模式下 h4-h6 稍微提亮，确保可读性 */
.dark .milkdown-editor h4,
.dark .milkdown-editor h5,
.dark .milkdown-editor h6,
.milkdown-editor.dark h4,
.milkdown-editor.dark h5,
.milkdown-editor.dark h6 {
  filter: brightness(1.3);
}

/* ========== Mac 代码块：红黄绿圆点装饰 ========== */
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

/* 暗色模式下 Mac 代码块圆点保持不变（macOS 控件颜色不分暗亮模式） */
</style>

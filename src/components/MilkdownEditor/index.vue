<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/kit/core'
import {
  commonmark,
  emphasisSchema,
  emphasisUnderscoreInputRule,
} from '@milkdown/kit/preset/commonmark'
import {
  gfm,
  strikethroughSchema,
  strikethroughInputRule,
} from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { math } from '@milkdown/plugin-math'
import { keymap } from '@milkdown/prose/keymap'
import { sinkListItem, liftListItem } from '@milkdown/prose/schema-list'
import { markRule } from '@milkdown/prose'
import { $inputRule, $prose } from '@milkdown/utils'
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

// 修 @milkdown/preset-commonmark / -gfm 里两条 markRule 的 bug：
//
//   commonmark/mark/emphasis.ts ：  /\b_(?![_\s])(.*?[^_\s])_\b/
//   gfm/mark/strike-through.ts ：   /(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/
//
// 这两条**正则结尾都没有 `$` 锚点**，会扫到段落里任意位置的 `_x_` / `~~x~~`，
// 包括 inline code 内部的（因为 textBetween 不带 mark 信息，code 里的字面字符
// 同样会被 regex 看到）。而 prosemirror-inputrules 调 handler 时按"匹配紧贴
// 光标"算 start：handler(state, m, from - (m[0].length - text.length), to) ——
// 一旦匹配命中段落中间的某段 inline code，算出来的 start 落在光标附近，
// tr.delete / tr.addMark 跑到完全不相关的位置上，把 inline code 里的字吞掉，
// 还顺带把光标附近的字符乱加 emphasis。同时 handler 不插入用户当次键入，所以
// 这次输入也会丢。
//
// 别的几条 markRule（emphasisStarInputRule、strongInputRule、inlineCodeInputRule）
// 末尾都已经有 `$`，是安全的。所以我们只需要：
//   1) 从 commonmark / gfm 的 bundle 里过滤掉这两条
//   2) 注册一对带 `$` 锚点的修复版顶上
const fixedEmphasisUnderscoreInputRule = $inputRule(ctx =>
  markRule(/\b_(?![_\s])(.*?[^_\s])_\b$/, emphasisSchema.type(ctx), {
    getAttr: () => ({ marker: '_' }),
    updateCaptured: ({ fullMatch, start }) =>
      !fullMatch.startsWith('_')
        ? { fullMatch: fullMatch.slice(1), start: start + 1 }
        : {},
  }),
)

const fixedStrikethroughInputRule = $inputRule(ctx =>
  markRule(/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)$/, strikethroughSchema.type(ctx)),
)

const safeCommonmark = commonmark.filter(p => p !== emphasisUnderscoreInputRule)
const safeGfm = gfm.filter(p => p !== strikethroughInputRule)

// // 列表项里的 Tab/Shift-Tab 完全交给 Milkdown 自带的 listItemKeymap（来自 commonmark preset）。
// 本 keymap 只管列表以外的"代码类 / 段落 / 标题"：在光标处插 4 空格。
const CODE_LIKE = new Set(['code_block', 'math_inline', 'math_block', 'mermaid'])

const tabIndent = $prose(() => {
  const itemType = (state: any) => state.schema.nodes.list_item

  function isInListItem($from: any): boolean {
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'list_item') return true
    }
    return false
  }

  return keymap({
    Tab: (state, dispatch) => {
      const { $from } = state.selection

      if (isInListItem($from)) {
        // 列表项：先尝试 sink；sink 失败（最内层嵌套）→ 退化为段落 Tab
        if (sinkListItem(itemType(state))(state, dispatch)) return true
        if (dispatch) dispatch(state.tr.insertText('    '))
        return true
      }

      // 代码块 / 公式 / mermaid 等代码类上下文
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name
        if (CODE_LIKE.has(name)) {
          if (dispatch) dispatch(state.tr.insertText('    '))
          return true
        }
      }

      // 段落 / 标题
      const node = $from.node()
      if (node.type.name === 'paragraph' || node.type.name === 'heading') {
        if (dispatch) dispatch(state.tr.insertText('    '))
        return true
      }

      return false
    },

    'Shift-Tab': (state, dispatch) => {
      const { $from } = state.selection
      if (isInListItem($from)) {
        return liftListItem(itemType(state))(state, dispatch)
      }
      return false
    },
  })
})

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

// 点卡片（非 ProseMirror 子元素）时把焦点拉回编辑器
function onCardClick() {
  if (!editorInstance) return
  editorInstance.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    if (!view.hasFocus()) {
      view.focus()
    }
  })
}

async function createEditor(opts: { focus?: boolean } = {}) {
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
    .use(tabIndent)
    .use(safeCommonmark)
    .use(fixedEmphasisUnderscoreInputRule)
    .use(safeGfm)
    .use(fixedStrikethroughInputRule)
    .use(history)
    .use(math)
    .use(mathEditPlugin)
    .use(mermaidSyntax)
    .use(mermaidEditPlugin)
    .use(listener)
    .create()

  // 切文档时（新建 / 打开 / 双击文件）把光标自动落到编辑器里
  if (opts.focus && editorInstance) {
    editorInstance.action((ctx) => {
      ctx.get(editorViewCtx).focus()
    })
  }

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
  createEditor({ focus: true })
})
</script>

<template>
  <div
    class="flex-1 rounded-2xl mx-8 mb-8 mt-4 shadow-xl bg-white dark:bg-[#1e1e1e]"
    @click="onCardClick"
  >
    <div class="flex justify-center h-full w-full overflow-auto px-8 py-6">
      <div
        ref="containerRef"
        :class="{
          'mac-code-block': props.isMacCodeBlock,
          'dark': props.darkMode,
        }"
        :style="editorStyle"
        class="milkdown-editor h-full w-full max-w-[64vw]"
      />
    </div>
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

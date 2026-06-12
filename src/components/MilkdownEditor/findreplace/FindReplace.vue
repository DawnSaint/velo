<script setup lang="ts">
// 浮动在编辑器卡片右上角的查找替换面板。
//
// 设计要点:
//   - 父级传 editorViewGetter:每次操作都重新拿 view —— 切文件时 inner 重建,
//     view 会换,getter 永远拿当前最新的。
//   - v-if 卸载:每次重开都是干净状态,不保留上次的 query。
//   - query / options 变化时自动 recompute matches,跳到第一个;空 query 清空。
//   - Enter / Shift+Enter 在 find 输入里走 next / prev;Enter 在 replace 里走 replace。
//   - 替换后从光标处继续找下一个 match;全部替换走 per-text-node String.replace 支持 $1 $2。
//   - 关闭时把焦点还给编辑器,回到编辑态。

import { computed, nextTick, ref, watch } from 'vue'
import type { EditorView } from '@milkdown/prose/view'
import { TextSelection } from '@milkdown/prose/state'
import { findMatchesInDoc, replaceInText, type FindOptions, type Match } from './findMatches'
import { findHighlightKey } from './findHighlight'

const props = defineProps<{
  open: boolean
  /** 切文件时 inner 重建,view 会换,getter 永远拿当前最新的 */
  editorViewGetter: () => EditorView | null
  /** Ctrl+F 时父级把当前选中的文本塞过来作为初始 query */
  initialQuery?: string
  /** Ctrl+H vs Ctrl+F 决定是否展开 replace 行 */
  initialShowReplace?: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const query = ref('')
const replacement = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const regex = ref(false)
const matches = ref<Match[]>([])
const currentIndex = ref(0)
const showReplace = ref(false)

const findInputRef = ref<HTMLInputElement | null>(null)
const replaceInputRef = ref<HTMLInputElement | null>(null)

const options = computed<FindOptions>(() => ({
  caseSensitive: caseSensitive.value,
  wholeWord: wholeWord.value,
  regex: regex.value,
}))

const hasError = computed(() => {
  if (!query.value || !regex.value) return false
  try { new RegExp(query.value) }
  catch { return true }
  return false
})

const matchCountText = computed(() => {
  if (!query.value) return ''
  if (hasError.value) return '正则错误'
  if (matches.value.length === 0) return '无结果'
  return `${currentIndex.value + 1} / ${matches.value.length}`
})

// 打开时:初始化 query / showReplace,然后 focus 到输入框
watch(() => props.open, async (isOpen) => {
  if (!isOpen) {
    // 关闭 → 清空 query + 清掉高亮。
    // 为什么也要清 query:之前 find/replace 在编辑器里设过 selection,这个 selection
    // 在 panel 关闭后还留在 ProseMirror state 里。下次按 Ctrl+F / 点工具栏打开时,
    // App.vue 的 currentSelectionText() 会读到那个旧 selection(可能是上次 match
    // 的第一个字符),然后通过 initialQuery 灌回 input —— 用户看到的就是
    // "关掉再打开,留有上次第一个字符"。直接在这里 query='' 把残留路径切断,
    // 重新打开时 watch initialQuery 会用新 selection / 空串覆盖。
    query.value = ''
    clearHighlight()
    return
  }
  query.value = props.initialQuery ?? ''
  replacement.value = ''
  showReplace.value = props.initialShowReplace ?? false
  caseSensitive.value = false
  wholeWord.value = false
  regex.value = false
  currentIndex.value = 0
  recomputeMatches()
  pushHighlightToEditor()
  if (matches.value.length > 0) selectMatch(0)
  await nextTick()
  if (showReplace.value) {
    replaceInputRef.value?.focus()
  }
  else {
    findInputRef.value?.focus()
    findInputRef.value?.select()
  }
}, { immediate: true })

// query / options 变化 → 重算 + 跳到第一个 + 推高亮
watch([query, caseSensitive, wholeWord, regex], () => {
  if (!props.open) return
  recomputeMatches()
  currentIndex.value = 0
  pushHighlightToEditor()
  if (matches.value.length > 0) selectMatch(0)
})

// 父级重新塞 initialQuery(用户在编辑器里换了一段选区再按 Ctrl+F)→
// 面板已开的话上面那个 open watch 不会触发,要靠这个 watch 把查找框更新掉。
// 故意不复位三档选项:用户辛苦切到 caseSensitive / regex 时,不应该被
// 重新按 Ctrl+F 时清掉;只更新 query 和重算。
watch(() => props.initialQuery, (newQuery) => {
  if (!props.open) return
  query.value = newQuery ?? ''
  recomputeMatches()
  currentIndex.value = 0
  pushHighlightToEditor()
  if (matches.value.length > 0) selectMatch(0)
  // 重新聚焦 find 输入,选中文本 → 用户按 Enter 立刻找下一个
  findInputRef.value?.focus()
  findInputRef.value?.select()
})

function recomputeMatches() {
  const view = props.editorViewGetter()
  if (!view) {
    matches.value = []
    return
  }
  matches.value = findMatchesInDoc(view.state.doc, query.value, options.value)
}

/**
 * 把当前 matches / currentIndex 推到编辑器的高亮插件。
 * 必须在 matches 或 currentIndex 变化后调一次,否则装饰不会刷新。
 * 没有 setMeta 的话插件会保留旧数据(空或上次 dispatch 的)。
 */
function pushHighlightToEditor() {
  const view = props.editorViewGetter()
  if (!view) return
  const tr = view.state.tr.setMeta(findHighlightKey, {
    matches: matches.value,
    currentIndex: currentIndex.value,
  })
  view.dispatch(tr)
}

function clearHighlight() {
  const view = props.editorViewGetter()
  if (!view) return
  const tr = view.state.tr.setMeta(findHighlightKey, {
    matches: [],
    currentIndex: 0,
  })
  view.dispatch(tr)
}

/**
 * 把 match 滚动到容器中央。
 *
 * 为什么不用 tr.scrollIntoView():
 *   tr.scrollIntoView() 内部走 view.scrollIntoView(),该方法在 view 没焦点
 *   时会早退(只滚动当前 selection,而我们要滚动指定位置)。find 面板打开
 *   时焦点一直在 find 输入里,view.scrollIntoView 永远命中早退分支,
 *   用户按 Enter 跳转 match 时编辑器完全不动。
 *
 * 改成手动:用 coordsAtPos 拿 match 的屏幕坐标,沿 DOM 向上找第一个
 * overflow-y: auto/scroll 的祖先,scrollBy 把 match 居中。
 */
function scrollMatchIntoView(view: EditorView, from: number) {
  const coords = view.coordsAtPos(from)
  if (!coords) return
  let el: HTMLElement | null = view.dom as HTMLElement
  while (el && el !== document.body) {
    const style = getComputedStyle(el)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      const containerRect = el.getBoundingClientRect()
      const matchCenter = (coords.top + coords.bottom) / 2
      const containerCenter = containerRect.top + el.clientHeight / 2
      const delta = matchCenter - containerCenter
      // 差 < 4px 时不滚,避免用户连续 Enter 时每一下都来个微小 smooth 抖动
      if (Math.abs(delta) > 4) {
        el.scrollBy({ top: delta, behavior: 'smooth' })
      }
      return
    }
    el = el.parentElement
  }
}

function selectMatch(index: number) {
  const view = props.editorViewGetter()
  if (!view) return
  const m = matches.value[index]
  if (!m) return
  const tr = view.state.tr
  tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to))
  view.dispatch(tr)
  // 不用 tr.scrollIntoView() —— 焦点在 find 输入里,view.scrollIntoView
  // 命中"没焦点"早退分支不会滚。手动滚,见 scrollMatchIntoView 注释。
  scrollMatchIntoView(view, m.from)
  // 不 view.focus() —— Enter 在 find 输入里连按会一直切 match,
  // 把焦点交出去会让用户没法连续 navigate。
}

function findNext() {
  if (matches.value.length === 0) return
  currentIndex.value = (currentIndex.value + 1) % matches.value.length
  pushHighlightToEditor()
  selectMatch(currentIndex.value)
}

function findPrev() {
  if (matches.value.length === 0) return
  currentIndex.value = (currentIndex.value - 1 + matches.value.length) % matches.value.length
  pushHighlightToEditor()
  selectMatch(currentIndex.value)
}

/**
 * 替换当前 match。和 replaceAll 走同一条路径:用 doc.textBetween 拿到 match
 * 实际文本,过 replaceInText(支持 regex $1/$2 反向引用),结果 dispatch 进 doc。
 * 保持单条替换 / 全部替换的语义一致 —— 用户切到 regex 后两边行为可预期。
 */
function replaceCurrent() {
  const view = props.editorViewGetter()
  if (!view || matches.value.length === 0) return
  const m = matches.value[currentIndex.value]
  if (!m) return
  // 拿到 match 实际文本,跑一遍 replaceInText → 支持 $1/$2
  const matchedText = view.state.doc.textBetween(m.from, m.to, '\n', '\n')
  const replacedText = replaceInText(matchedText, query.value, options.value, replacement.value)
  const cursorPos = m.from + replacedText.length
  const tr = view.state.tr
  tr.replaceWith(m.from, m.to, view.state.schema.text(replacedText))
  tr.setSelection(TextSelection.create(tr.doc, cursorPos))
  tr.scrollIntoView()
  view.dispatch(tr)
  // 重新算所有 match,从新光标处找下一个
  recomputeMatches()
  pushHighlightToEditor()
  const nextIdx = matches.value.findIndex(x => x.from >= cursorPos)
  if (nextIdx >= 0) {
    currentIndex.value = nextIdx
    selectMatch(nextIdx)
  }
  else if (matches.value.length > 0) {
    currentIndex.value = 0
    selectMatch(0)
  }
}

/**
 * 全部替换:per-text-node 用 String.prototype.replace 算新 text,支持 regex 的 $1, $2。
 * 先把所有 text node 的 (from, to, newText) 算好(doc 不变,可以安全遍历),
 * 再倒序 dispatch 避免位置错位。
 */
function replaceAll() {
  const view = props.editorViewGetter()
  if (!view) return
  const replacements: { from: number, to: number, newText: string }[] = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const newText = replaceInText(node.text, query.value, options.value, replacement.value)
    if (newText !== node.text) {
      replacements.push({ from: pos, to: pos + node.nodeSize, newText })
    }
  })
  if (replacements.length === 0) return
  const tr = view.state.tr
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i]
    tr.replaceWith(r.from, r.to, view.state.schema.text(r.newText))
  }
  view.dispatch(tr)
  // 全部替换后没有"当前 match"了,清空状态
  matches.value = []
  currentIndex.value = 0
  pushHighlightToEditor()
  view.focus()
}

function close() {
  const view = props.editorViewGetter()
  if (view) view.focus()
  emit('close')
}

function toggleReplace() {
  showReplace.value = !showReplace.value
  if (showReplace.value) {
    nextTick(() => replaceInputRef.value?.focus())
  }
}

function clearQuery() {
  // 写空 → [query, ...] watch 自动 recomputeMatches + pushHighlight(空) + 清掉装饰
  query.value = ''
  // 焦点留回 find 输入,用户可以继续输新词再 Enter
  findInputRef.value?.focus()
}

function onFindKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    // panel 已经开着 → 重新聚焦 find 输入,而不是创建新实例
    e.preventDefault()
    findInputRef.value?.focus()
    findInputRef.value?.select()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    if (e.shiftKey) findPrev()
    else findNext()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

function onReplaceKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    replaceCurrent()
  }
  else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
</script>

<template>
  <!--
    @keydown.stop 防止面板内的按键冒泡到 App.vue 的全局 Ctrl+S / Ctrl+F / Ctrl+H 处理器。
    @click.stop   防止点击面板时冒泡到 editor card 的 onCardClick → focusEditor():
                  不加的话用户在面板外失焦后再点回面板,焦点会被抢回编辑器,
                  表现为"输入框一聚焦就立刻失焦,光标跳到编辑器内部"。
    data-fr-panel 让父级也能识别"焦点在面板内"这个事实。
  -->
  <div
    v-if="open"
    data-fr-panel
    class="velo-find-replace absolute right-4 top-4 z-10 w-[min(30rem,calc(100%-2rem))] select-none rounded-2xl border border-gray-200 bg-white/80 shadow-2xl backdrop-blur dark:border-gray-700 dark:bg-[#252525]/85"
    @keydown.stop
    @click.stop
  >
    <!-- Find row -->
    <div class="flex items-center gap-1 px-3 py-2">
      <div class="relative min-w-0 flex-1">
        <input
          ref="findInputRef"
          v-model="query"
          type="text"
          data-fr-input="find"
          placeholder="查找"
          class="w-full rounded-lg border border-gray-200 bg-white py-1 pl-2 pr-7 text-xs text-gray-900/80 outline-none transition-colors focus:border-[var(--md-primary-color)] dark:border-gray-700 dark:bg-[#1e1e1e] dark:text-gray-100/80"
          :class="{ 'border-red-400 focus:border-red-400 focus:ring-red-400/25 dark:border-red-500': hasError }"
          @keydown="onFindKeydown"
        >
        <!--
          清空按钮:有内容时才显示,absolute 浮在 input 右内侧。
          pr-7 始终给按钮留位,避免出现 / 消失时输入框宽度跳一下。
        -->
        <button
          v-if="query"
          type="button"
          data-fr-input="find-clear"
          class="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="清空"
          @click="clearQuery"
        >
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <span
        class="min-w-14 px-1 text-center text-xs tabular-nums"
        :class="(matches.length === 0 && query && !hasError) || hasError ? 'text-red-400' : 'text-gray-400'"
      >
        {{ matchCountText }}
      </span>
      <button
        type="button"
        :disabled="matches.length === 0"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-800"
        title="上一个 (Shift+Enter)"
        @click="findPrev"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="18 15 12 9 6 15" />
        </svg>
      </button>
      <button
        type="button"
        :disabled="matches.length === 0"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-gray-800"
        title="下一个 (Enter)"
        @click="findNext"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        :class="{ 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100': caseSensitive }"
        title="区分大小写"
        @click="caseSensitive = !caseSensitive"
      >
        <span class="text-xs font-semibold">Aa</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        :class="{ 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100': wholeWord }"
        title="全词匹配"
        @click="wholeWord = !wholeWord"
      >
        <span class="text-xs font-semibold italic">W</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        :class="{ 'bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100': regex }"
        title="正则表达式"
        @click="regex = !regex"
      >
        <span class="text-[10px] font-semibold">.*</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        :title="showReplace ? '隐藏替换' : '显示替换'"
        @click="toggleReplace"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path :d="showReplace ? 'M6 9l6 6 6-6' : 'M9 18l6-6-6-6'" />
        </svg>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        title="关闭 (Esc)"
        @click="close"
      >
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <!-- Replace row -->
    <div
      v-if="showReplace"
      class="flex items-center gap-1 border-t border-gray-100 px-3 py-2 dark:border-gray-800"
    >
      <input
        ref="replaceInputRef"
        v-model="replacement"
        type="text"
        data-fr-input="replace"
        placeholder="替换为"
        class="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900/80 outline-none transition-colors focus:outline-none focus:border-[var(--md-primary-color)] dark:border-gray-700 dark:bg-[#1e1e1e] dark:text-gray-100/80"
        @keydown="onReplaceKeydown"
      >
      <button
        type="button"
        :disabled="matches.length === 0"
        class="shrink-0 rounded px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-gray-800"
        title="替换当前 (Enter)"
        @click="replaceCurrent"
      >
        替换
      </button>
      <button
        type="button"
        :disabled="matches.length === 0"
        class="shrink-0 rounded px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-gray-800"
        title="全部替换"
        @click="replaceAll"
      >
        全部
      </button>
    </div>
  </div>
</template>

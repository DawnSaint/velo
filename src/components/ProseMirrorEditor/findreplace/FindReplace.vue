<script setup lang="ts">
// 浮动在编辑器卡片右上角的查找替换面板。
//
// 设计要点:
//   - 父级传 backendGetter:每次操作都重新拿后端 —— 切文件 / 切模式时编辑器重建,
//     后端跟着换(PM / CM6 各一份实现,见 backend.ts)。
//   - 用户意图(query / 选项 / 替换文 / showReplace)由 App.vue provide,本组件 inject
//     共享 —— 切模式时 PM 份卸载、CM6 份新挂,意图在 App.vue 存活,query 不丢。
//     matches / currentIndex 是模式相关的,不上提,新挂载时用当前后端重算。
//   - query / options 变化时自动 recompute matches,跳到第一个;空 query 清空。
//   - Enter / Shift+Enter 在 find 输入里走 next / prev;Enter 在 replace 里走 replace。
//   - 替换后从光标处继续找下一个 match;全部替换走倒序循环 String.replace 支持 $1 $2。
//   - 关闭时把焦点还给编辑器,回到编辑态。

import { computed, inject, nextTick, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, ChevronUp, X } from '@lucide/vue'
import { replaceInText, type FindOptions, type Match } from './findMatches'
import type { FindReplaceBackend } from './backend'
import { findIntentKey } from './findIntent'

const props = defineProps<{
  open: boolean
  /** 每次操作重新取后端 —— 切文件 / 切模式时编辑器重建,后端跟着换。
   *  后端把 PM / CM6 差异收敛,本组件不直接依赖任一编辑器 API。 */
  backendGetter: () => FindReplaceBackend | null
}>()

const emit = defineEmits<{
  close: []
  /** 焦点在面板内按 Ctrl+Shift+F → 切到全局搜索。App.vue 关闭本面板 +
   *  打开 WorkspaceSearchPanel,FindReplace 自己不直接碰全局状态 */
  'open-global-search': []
}>()

// 用户意图来自 App.vue(跨模式保留)。App 始终 provide;独立挂载(如测试)无 provide
// 时回退本地 ref,组件自洽不崩(此时无跨实例共享,但生产路径不受影响)。
const intent = inject(findIntentKey) ?? {
  query: ref(''),
  replacement: ref(''),
  caseSensitive: ref(false),
  wholeWord: ref(false),
  regex: ref(false),
  showReplace: ref(false),
}
const { query, replacement, caseSensitive, wholeWord, regex, showReplace } = intent

// 模式相关的本地状态:切模式重挂时重算。
const matches = ref<Match[]>([])
const currentIndex = ref(0)

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

// 打开 → 用 App.vue 已下发的意图(query / 选项)重算 + 跳第一个 + 推高亮 + 聚焦。
// query / 选项由 App.vue 的 openFind / openReplace 在置 findOpen=true 前写好,这里只读。
// 关闭 → 清本地 match 状态 + 清高亮(意图归 App.vue,不动 —— 下次打开由 openFind 重置)。
watch(() => props.open, async (isOpen) => {
  if (!isOpen) {
    matches.value = []
    currentIndex.value = 0
    clearHighlight()
    return
  }
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

// 切模式时 findOpen 保持 true,新挂载的 FindReplace 其 open watcher(immediate)在
// setup 阶段就跑 recomputeMatches —— 但此时入方向编辑器 view 还没建好(backendGetter
// 返回 null)→ matches=[]。之后 view 就绪,但 query/选项是 inject 的同一 ref、值没变,
// 上面的 watch 不触发;open 也没变。结果 matches 停在空,要手动改 query 才重算。
// 这里在 onMounted + nextTick 补一次:nextTick 时父组件 onMounted 已同步建好 view
// (PM: EditorInner 子组件先 mount;CM6: SourceModeEditor onMounted 同步 createView),
// backendGetter 拿得到真后端。切模式是新挂载,onMounted 每次都跑,覆盖两路径。
onMounted(() => {
  if (!props.open) return
  void nextTick().then(() => {
    if (!props.open) return
    recomputeMatches()
    pushHighlightToEditor()
    if (matches.value.length > 0) selectMatch(0)
  })
})

function recomputeMatches() {
  const be = props.backendGetter()
  if (!be) {
    matches.value = []
    return
  }
  matches.value = be.findMatches(query.value, options.value)
}

/**
 * 把当前 matches / currentIndex 推到编辑器的高亮(PM 走 setMeta,CM6 走 effect,
 * 由后端屏蔽)。必须在 matches / currentIndex 变化后调一次,否则装饰不刷新。
 */
function pushHighlightToEditor() {
  const be = props.backendGetter()
  if (!be) return
  be.setHighlight(matches.value, currentIndex.value)
}

function clearHighlight() {
  const be = props.backendGetter()
  if (!be) return
  be.clearHighlight()
}

function selectMatch(index: number) {
  const be = props.backendGetter()
  if (!be) return
  const m = matches.value[index]
  if (!m) return
  be.setSelection(m.from, m.to)
  // 滚动逻辑在后端:PM 焦点在 find 输入里时 tr.scrollIntoView 早退 → 手动居中;
  // CM6 的 scrollIntoView effect 不依赖焦点,直接居中。都不 view.focus() ——
  // Enter 在 find 输入里连按要能连续 navigate,焦点不能交出去。
  be.scrollMatchIntoView(m.from)
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
 * 替换当前 match。从后端拿 match 实文本,过 replaceInText(支持 regex $1/$2),
 * 结果经后端 replaceRange 落回文档(PM tr.replaceWith / CM6 dispatch changes)。
 * 单条替换与全部替换语义一致 —— 用户切到 regex 后两边行为可预期。
 */
function replaceCurrent() {
  const be = props.backendGetter()
  if (!be || matches.value.length === 0) return
  const m = matches.value[currentIndex.value]
  if (!m) return
  // 拿到 match 实际文本,跑一遍 replaceInText → 支持 $1/$2
  const matchedText = be.getRangeText(m.from, m.to)
  const replacedText = replaceInText(matchedText, query.value, options.value, replacement.value)
  const cursorPos = be.replaceRange(m.from, m.to, replacedText)
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
 * 全部替换:编辑器无关的倒序循环。逆序替换避免位置错位(改后面的不影响前面 match 的坐标)。
 * 每个 match 取实文本 → replaceInText(全局正则在 match 子串上重跑,等价于旧 PM per-text-node)
 * → 后端 replaceRange 落回。PM match 不跨文本节点、CM6 match 可跨行,两边统一成立。
 */
function replaceAll() {
  const be = props.backendGetter()
  if (!be) return
  for (let i = matches.value.length - 1; i >= 0; i--) {
    const m = matches.value[i]
    const matched = be.getRangeText(m.from, m.to)
    const replaced = replaceInText(matched, query.value, options.value, replacement.value)
    if (replaced !== matched) be.replaceRange(m.from, m.to, replaced)
  }
  // 全部替换后没有"当前 match"了,清空状态
  matches.value = []
  currentIndex.value = 0
  pushHighlightToEditor()
  be.focus()
}

function close() {
  const be = props.backendGetter()
  if (be) be.focus()
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
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (mod && e.shiftKey && k === 'f') {
    // 切到全局搜索:App.vue 的 onKeydown 在 capture 阶段看到 closest
    // data-fr-panel 就 return(把控制权让给本面板),本面板自己不处理就
    // 静默吞掉。emit 给父级,父级关本面板 + 打开 WorkspaceSearchPanel。
    e.preventDefault()
    e.stopPropagation()
    emit('open-global-search')
    return
  }
  if (mod && !e.shiftKey && k === 'h') {
    // 展开替换行(类似编辑器内 Ctrl+H 语义),已展开则重新聚焦 replace 输入
    e.preventDefault()
    e.stopPropagation()
    showReplace.value = true
    nextTick(() => replaceInputRef.value?.focus())
    return
  }
  if (mod && k === 'f') {
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
  const mod = e.ctrlKey || e.metaKey
  const k = e.key.toLowerCase()
  if (mod && e.shiftKey && k === 'f') {
    e.preventDefault()
    e.stopPropagation()
    emit('open-global-search')
    return
  }
  if (mod && !e.shiftKey && k === 'h') {
    // 替换行已展开 → 重新聚焦 replace 输入
    e.preventDefault()
    e.stopPropagation()
    showReplace.value = true
    nextTick(() => replaceInputRef.value?.focus())
    return
  }
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
    class="absolute right-4 top-4 z-10 w-[min(30rem,calc(100%-2rem))] select-none rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-3)] shadow-[var(--shadow-popover)] backdrop-blur"
    @keydown.stop
    @click.stop
  >
    <!-- Find row -->
    <div class="flex items-center px-2.5 py-1 gap-0.5">
      <div class="relative min-w-0 flex-1">
        <button
          type="button"
          class="absolute left-0.5 top-1/2 -translate-y-1/2 flex w-6 h-6 shrink-0 items-center justify-center rounded text-gray-500 transition-colors dark:text-gray-400"
          :title="showReplace ? '隐藏替换' : '显示替换'"
          @click="toggleReplace"
        >
          <ChevronDown v-if="showReplace" :size="12" />
          <ChevronRight v-else :size="12" />
        </button>
        <input
          ref="findInputRef"
          v-model="query"
          type="text"
          data-fr-input="find"
          placeholder="查找"
          class="w-full rounded-xl border border-[var(--surface-border)] bg-[var(--surface-3)] py-1 pl-6 pr-7 text-xs text-gray-900/80 outline-none transition-colors focus:border-[var(--md-primary-color)] dark:text-gray-100/80"
          :class="{ 'border-red-400 focus:border-red-400 focus:ring-red-400/25 dark:border-red-500': hasError }"
          @keydown="onFindKeydown"
        />
        <button
          v-if="query"
          type="button"
          data-fr-input="find-clear"
          class="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
          title="清空"
          @click="clearQuery"
        >
          <X class="size-3" :stroke-width="2.5" />
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
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-30 dark:text-gray-400"
        title="上一个 (Shift+Enter)"
        @click="findPrev"
      >
        <ChevronUp :size="12" />
      </button>
      <button
        type="button"
        :disabled="matches.length === 0"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
        title="下一个 (Enter)"
        @click="findNext"
      >
        <ChevronDown :size="12" />
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
        :class="{ 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100': caseSensitive }"
        title="区分大小写"
        @click="caseSensitive = !caseSensitive"
      >
        <span class="text-xs font-semibold">Aa</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
        :class="{ 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100': wholeWord }"
        title="全词匹配"
        @click="wholeWord = !wholeWord"
      >
        <span class="text-xs font-semibold italic">W</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
        :class="{ 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100': regex }"
        title="正则表达式"
        @click="regex = !regex"
      >
        <span class="text-[10px] font-semibold">.*</span>
      </button>
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
        title="关闭 (Esc)"
        @click="close"
      >
        <X :size="12" />
      </button>
    </div>
    <!-- Replace row -->
    <div
      v-if="showReplace"
      class="flex items-center gap-1 px-2.5 pb-1"
    >
      <input
        ref="replaceInputRef"
        v-model="replacement"
        type="text"
        data-fr-input="replace"
        placeholder="替换为"
        class="min-w-0 flex-1 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-3)] px-2 py-1 text-xs text-gray-900/80 outline-none transition-colors focus:outline-none focus:border-[var(--md-primary-color)] dark:text-gray-100/80"
        @keydown="onReplaceKeydown"
      >
      <button
        type="button"
        :disabled="matches.length === 0"
        class="shrink-0 rounded px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-30 dark:text-gray-300"
        title="替换当前 (Enter)"
        @click="replaceCurrent"
      >
        替换
      </button>
      <button
        type="button"
        :disabled="matches.length === 0"
        class="shrink-0 rounded px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-30 dark:text-gray-300"
        title="全部替换"
        @click="replaceAll"
      >
        全部
      </button>
    </div>
  </div>
</template>

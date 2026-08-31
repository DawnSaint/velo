<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, onUnmounted, onDeactivated, ref, watch, type CSSProperties } from 'vue'
import { ChevronRight, ChevronsDownUp, List } from '@lucide/vue'
import { useOutlineStore } from '@/stores/outline'
import { parseHeadings, type HeadingItem } from '@/utils/outline'
import { revealHeadingInDom } from '@/utils/revealHeading'

const props = defineProps<{
  modelValue: string
  filePath: string | null
  /** 设置页激活时由 Sidebar 传入:显示空态 + 跳过 scroll-spy(无编辑器可监听) */
  settingsActive?: boolean
}>()

const outlineStore = useOutlineStore()

// ========== 类型 ==========
interface FlatItem {
  level: number
  text: string
  displayText: string
  key: string
  indent: number
  hasChildren: boolean
  expanded: boolean
}

const tree = ref<HeadingItem[]>(parseHeadings(props.modelValue))

// ========== 折叠状态：使用 Set 追踪被折叠的 key ==========
const collapsedKeys = ref<Set<string>>(new Set())

// 文件路径变化:从 store 读该文件的折叠状态,避免切换文件时折叠状态串台
// (原来的实现下,两份文档里恰好同名/同级的标题会共用同一 key,折叠会"穿越")
// immediate: true 覆盖初始空 Set;对未保存(path 为 null)的新文档保持空
watch(() => props.filePath, (path) => {
  collapsedKeys.value = path
    ? new Set(outlineStore.getKeysFor(path))
    : new Set()
}, { immediate: true })

function toggleExpand(key: string) {
  const next = new Set(collapsedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
  // 同步到 store → 触发 App.vue 的 debounce 落盘
  outlineStore.setKeysFor(props.filePath, next)
}

/** 全部折叠:把所有有子项的标题 key 都加入折叠集合 */
function collapseAll() {
  const all = new Set<string>()
  function walk(items: HeadingItem[]) {
    for (const it of items) {
      if (it.children.length > 0) all.add(it.key)
      walk(it.children)
    }
  }
  walk(tree.value)
  collapsedKeys.value = all
  outlineStore.setKeysFor(props.filePath, all)
}

watch(() => props.modelValue, (v) => {
  tree.value = parseHeadings(v)
  // 删除掉再也不存在的折叠键 —— 保留仍然在树里的，跨编辑保持折叠状态
  const live = new Set<string>()
  function walk(items: HeadingItem[]) {
    for (const it of items) { live.add(it.key); walk(it.children) }
  }
  walk(tree.value)
  if (collapsedKeys.value.size) {
    const cleaned = new Set<string>()
    for (const k of collapsedKeys.value) if (live.has(k)) cleaned.add(k)
    if (cleaned.size !== collapsedKeys.value.size) {
      collapsedKeys.value = cleaned
      // 编辑后失效的 key 也要从 store 里清掉,否则下次打开会复活
      outlineStore.setKeysFor(props.filePath, cleaned)
    }
  }
  // 高亮键也可能因为标题文本被改而失效 —— 默认回退到第一个标题,
  // 避免出现"加载完文档,大纲什么都不高亮"的情况。scroll-spy 接下来
  // 会基于实际滚动位置覆盖,这里只是兜底。
  if (currentKey.value && !live.has(currentKey.value)) {
    currentKey.value = tree.value[0]?.key ?? null
  }
  // 首次进入/刚加载文档:tree 重建后,如果还没高亮,就高亮第一个。
  if (!currentKey.value && tree.value[0]) {
    currentKey.value = tree.value[0].key
  }
})

// ========== 将树展平为可视列表 ==========
const flatList = computed<FlatItem[]>(() => {
  const result: FlatItem[] = []
  const collapsed = collapsedKeys.value

  function walk(items: HeadingItem[], depth: number) {
    for (const item of items) {
      const expanded = !collapsed.has(item.key)
      result.push({
        level: item.level,
        text: item.text,
        displayText: item.displayText,
        key: item.key,
        indent: depth,
        hasChildren: item.children.length > 0,
        expanded,
      })
      if (expanded && item.children.length) walk(item.children, depth + 1)
    }
  }
  walk(tree.value, 0)
  return result
})

// 区分两种"空":文档真的没标题 vs 过滤后无匹配
const isDocEmpty = computed(() => tree.value.length === 0)

// 全树索引：(level, displayText) → (自身 key, 祖先 key 链)。
// scroll-spy 据此能在祖先被折叠、自身不在 flatList 时，回退到最近一个仍可见的祖先去高亮。
interface HeadingIndexEntry {
  key: string
  ancestors: string[]
}
const headingIndex = computed<Map<string, HeadingIndexEntry>>(() => {
  const map = new Map<string, HeadingIndexEntry>()
  function walk(items: HeadingItem[], ancestors: string[]) {
    for (const item of items) {
      const k = `${item.level} ${item.displayText}`
      // 同 (level, text) 的重复保留第一个 —— DOM 那边也只能用 textContent 匹配，没办法
      if (!map.has(k)) map.set(k, { key: item.key, ancestors: [...ancestors] })
      walk(item.children, [...ancestors, item.key])
    }
  }
  walk(tree.value, [])
  return map
})

// ========== 滚动到标题 ==========
// 走共享 util(与统一命令面板 @ 符号模式同款 DOM 跳转 + outline-highlight 闪烁)。
function onItemClick(item: FlatItem) {
  revealHeadingInDom(item.level, item.displayText)
}

// ========== 缩进（与文件树一致：base 12px + 每级 12px） ==========
const indentStyleCache = new Map<number, CSSProperties>()
function indentStyle(depth: number): CSSProperties {
  const cached = indentStyleCache.get(depth)
  if (cached) return cached
  const result: CSSProperties = { paddingLeft: `${12 + depth * 12}px` }
  indentStyleCache.set(depth, result)
  return result
}

// ========== Scroll-spy：跟踪编辑器当前滚动到的标题，在大纲中加粗高亮 ==========
const currentKey = ref<string | null>(null)

let scrollContainer: HTMLElement | null = null
let rafId: number | null = null
let attachTimer: ReturnType<typeof setTimeout> | null = null
let scrollSpyActive = false

function getScrollContainer(): HTMLElement | null {
  // 编辑器的可滚动容器是 .velo-editor 的父元素（带 overflow-auto 的那层）
  const editor = document.querySelector('.velo-editor')
  return (editor?.parentElement as HTMLElement | null) ?? null
}

function findCurrentHeading() {
  if (!scrollContainer) return
  const rect = scrollContainer.getBoundingClientRect()
  // "视口顶线"往下 20px 算作当前标题分界线
  const threshold = rect.top + 20

  const headings = scrollContainer.querySelectorAll<HTMLElement>('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6')
  if (headings.length === 0) {
    currentKey.value = null
    return
  }

  let lastAbove: { level: number, text: string } | null = null
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= threshold) {
      lastAbove = {
        level: Number(h.tagName.substring(1)),
        text: h.textContent?.trim() ?? '',
      }
    }
    else {
      break
    }
  }

  if (!lastAbove) {
    // 没有任何 heading 在视口顶线之上 —— 通常发生在:
    //   1) 滚到文档最顶端(第一个 heading 还在 padding 之下,没越过 20px 阈值)
    //   2) 文档还没滚到第一个 heading
    // 这两种情况都应该高亮第一个 heading,而不是空着。
    const first = headings[0]
    const firstKey = `${first.tagName.substring(1)} ${first.textContent?.trim() ?? ''}`
    const entry = headingIndex.value.get(firstKey)
    currentKey.value = entry?.key ?? null
    return
  }

  // 在全树里查匹配项 —— 即使自身因祖先折叠不在 flatList 里也能查到
  const entry = headingIndex.value.get(`${lastAbove.level} ${lastAbove.text}`)
  if (!entry) { currentKey.value = null; return }

  const visible = new Set(flatList.value.map(i => i.key))
  if (visible.has(entry.key)) {
    currentKey.value = entry.key
    return
  }
  // 自身被折叠藏起来了：往上找最近一个仍可见的祖先来高亮
  for (let i = entry.ancestors.length - 1; i >= 0; i--) {
    if (visible.has(entry.ancestors[i])) {
      currentKey.value = entry.ancestors[i]
      return
    }
  }
  currentKey.value = null
}

function onScroll() {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    findCurrentHeading()
  })
}

function attachScrollListener() {
  scrollContainer?.removeEventListener('scroll', onScroll)
  scrollContainer = getScrollContainer()
  if (scrollContainer) {
    scrollContainer.addEventListener('scroll', onScroll, { passive: true })
    findCurrentHeading()
  }
}

function scheduleAttachScrollListener() {
  if (attachTimer) clearTimeout(attachTimer)
  attachTimer = setTimeout(() => {
    attachTimer = null
    if (scrollSpyActive) attachScrollListener()
  }, 200)
}

function detachScrollListener() {
  scrollSpyActive = false
  if (attachTimer) {
    clearTimeout(attachTimer)
    attachTimer = null
  }
  scrollContainer?.removeEventListener('scroll', onScroll)
  scrollContainer = null
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function activateScrollSpy() {
  scrollSpyActive = true
  attachScrollListener()
  if (!scrollContainer) nextTick(() => {
    if (scrollSpyActive) attachScrollListener()
  })
  scheduleAttachScrollListener()
}

// settingsActive 时跳过 scroll-spy:设置页无编辑器,监听无意义
watch(() => props.settingsActive, (active) => {
  if (active) detachScrollListener()
  else activateScrollSpy()
})

onMounted(() => { if (!props.settingsActive) activateScrollSpy() })
onActivated(() => { if (!props.settingsActive) activateScrollSpy() })
onDeactivated(detachScrollListener)
onUnmounted(detachScrollListener)
</script>

<template>
  <!--
    h-full + flex flex-col:撑满外层 aside 的高度,让子项可以 flex-1 分配空间
    列表 min-h-0 flex-1 overflow-y-auto:拿走剩余空间,内容超出时出滚动条
      (min-h-0 关键 —— flex 子项默认 min-height: auto,会撑到内容高度,
       不加 min-h-0 的话 overflow-y-auto 永远没机会触发,这是经典 flex 坑)
    min-w-0(v0.5.5):替换原 min-w-64,允许 splitter 拉到 200px;overflow-hidden
       防止窄态时子元素溢出。
  -->
  <div class="flex h-full min-w-0 flex-col overflow-hidden">
    <!-- 空态:文档无标题 或 设置页激活(无文档上下文) -->
    <div
      v-if="isDocEmpty || settingsActive"
      class="flex h-full flex-col items-center justify-center gap-2 px-4 text-gray-400 dark:text-gray-600"
    >
      <List :size="32" :stroke-width="1.2" />
      <span class="text-xs">暂无标题</span>
    </div>

    <template v-else>
      <!-- 头部 -->
      <div class="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4 py-2.5">
        <div class="flex items-center gap-1.5">
          <List class="h-4 w-4 text-[var(--text-secondary)]" />
          <span class="text-sm font-medium text-gray-700 dark:text-gray-200">大纲</span>
        </div>
        <button
          class="flex size-5.5 items-center justify-center rounded text-gray-500 hover:bg-[var(--surface-pressed)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          title="全部折叠"
          @click.stop="collapseAll"
        >
          <ChevronsDownUp class="size-3.5 pointer-events-none" :stroke-width="2" />
        </button>
      </div>

      <div v-velo-scroll class="min-h-0 flex-1 overflow-y-auto">
      <div
        v-for="item in flatList"
        :key="item.key"
        :style="indentStyle(item.indent)"
        :class="[
          'group flex items-center gap-1 h-7.5 pr-2 text-sm transition-colors cursor-pointer hover:bg-[var(--surface-hover)]',
          { 'outline-current-row': item.key === currentKey },
        ]"
        :title="item.displayText"
        @click="onItemClick(item)"
      >
        <!-- 展开/折叠箭头（与文件树一致：size-4 容器 + size-3 箭头） -->
        <span
          class="flex size-4 shrink-0 items-center justify-center"
          :class="{ 'cursor-pointer': item.hasChildren }"
          @click.stop="item.hasChildren && toggleExpand(item.key)"
        >
          <ChevronRight
            v-if="item.hasChildren"
            class="size-3 text-gray-400 transition-transform"
            :class="{ 'rotate-90': item.expanded }"
            :stroke-width="2.5"
          />
        </span>

        <!-- 标题文本 -->
        <span
          class="truncate"
          :class="item.key === currentKey
            ? 'font-bold'
            : 'text-gray-700 dark:text-gray-300'"
          :style="item.key === currentKey
            ? { color: 'var(--md-primary-color, #1F71D9)' }
            : undefined"
        >
          {{ item.displayText }}
        </span>
      </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
:global(.outline-highlight) {
  animation: outline-flash 1.5s ease-out;
}
@keyframes outline-flash {
  0%  { background-color: var(--md-primary-color, #1F71D9); color: #fff; border-radius: 4px; }
  100% { background-color: transparent; color: inherit; }
}
/* 当前标题行高亮背景 —— 用 global class 而非 inline style，
   使 hover:bg-[var(--surface-hover)] 的 :hover 伪类能覆盖（specificity 0,2,0 > 0,1,0） */
:global(.outline-current-row) {
  background-color: color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent);
}
</style>

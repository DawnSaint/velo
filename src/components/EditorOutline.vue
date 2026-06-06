<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
}>()

// ========== 类型 ==========
interface HeadingItem {
  level: number
  text: string
  displayText: string
  children: HeadingItem[]
  key: string // 基于内容派生的稳定标识符；跨编辑保持不变，折叠状态因此能延续
}

interface FlatItem {
  level: number
  text: string
  displayText: string
  key: string
  indent: number
  hasChildren: boolean
  expanded: boolean
}

// ========== 解析 markdown 标题 ==========
function stripFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/!\[.*?\]\(.+?\)/g, '')
    .replace(/~~(.+?)~~/g, '$1')
    .trim()
}

/** 移除围栏代码块（``` 和 ~~~），避免内部 # 被误判为标题 */
function stripFencedCodeBlocks(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (match) => '\n'.repeat((match.match(/\n/g) || []).length))
    .replace(/~~~[\s\S]*?~~~/g, (match) => '\n'.repeat((match.match(/\n/g) || []).length))
}

function parseHeadings(markdown: string): HeadingItem[] {
  const cleaned = stripFencedCodeBlocks(markdown)
  const regex = /^(#{1,6})\s+(.+)$/gm
  const flat: { level: number; text: string; displayText: string }[] = []
  let m: RegExpExecArray | null
  while ((m = regex.exec(cleaned)) !== null) {
    const raw = m[2].trim()
    flat.push({ level: m[1].length, text: raw, displayText: stripFormatting(raw) })
  }

  // 内容派生的稳定 key：相同位置的标题在编辑前后保持同一 key，折叠状态因此能延续。
  // 同 (level, displayText) 的重复用 #1/#2/... 区分，仍然稳定。
  const seenCounts = new Map<string, number>()
  const root: HeadingItem[] = []
  const stack: HeadingItem[] = []

  for (const h of flat) {
    const baseKey = `${h.level}::${h.displayText}`
    const idx = seenCounts.get(baseKey) ?? 0
    seenCounts.set(baseKey, idx + 1)
    const key = idx === 0 ? baseKey : `${baseKey}#${idx}`

    const item: HeadingItem = { ...h, children: [], key }
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    if (stack.length === 0) root.push(item)
    else stack[stack.length - 1].children.push(item)
    stack.push(item)
  }
  return root
}

const tree = ref<HeadingItem[]>(parseHeadings(props.modelValue))

// ========== 折叠状态：使用 Set 追踪被折叠的 key ==========
const collapsedKeys = ref<Set<string>>(new Set())

function toggleExpand(key: string) {
  const next = new Set(collapsedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
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
    if (cleaned.size !== collapsedKeys.value.size) collapsedKeys.value = cleaned
  }
  // 高亮键也可能因为标题文本被改而失效，让 scroll-spy 在下一次滚动时重新算
  if (currentKey.value && !live.has(currentKey.value)) currentKey.value = null
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
      if (expanded && item.children.length) {
        walk(item.children, depth + 1)
      }
    }
  }
  walk(tree.value, 0)
  return result
})

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

const isEmpty = computed(() => flatList.value.length === 0)

// ========== 滚动到标题 ==========
function scrollToHeading(item: FlatItem) {
  const editor = document.querySelector('.ProseMirror') as HTMLElement | null
  if (!editor) return
  const tag = `h${item.level}`
  const els = editor.querySelectorAll(tag)
  for (const el of els) {
    if (el.textContent?.trim() === item.displayText) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      el.classList.add('outline-highlight')
      setTimeout(() => el.classList.remove('outline-highlight'), 1500)
      return
    }
  }
}

// ========== 缩进 ==========
function indentClass(depth: number): string {
  const map: Record<number, string> = {
    0: 'pl-0', 1: 'pl-4', 2: 'pl-8', 3: 'pl-12', 4: 'pl-14', 5: 'pl-16',
  }
  return map[depth] || 'pl-16'
}

// ========== Scroll-spy：跟踪编辑器当前滚动到的标题，在大纲中加粗高亮 ==========
const currentKey = ref<string | null>(null)
let scrollContainer: HTMLElement | null = null
let rafId: number | null = null

function getScrollContainer(): HTMLElement | null {
  // 编辑器的可滚动容器是 .milkdown-editor 的父元素（带 overflow-auto 的那层）
  const editor = document.querySelector('.milkdown-editor')
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
    currentKey.value = null
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

onMounted(() => {
  // MilkdownEditor 异步挂载，先尝试一次，找不到就等下一帧
  attachScrollListener()
  if (!scrollContainer) {
    nextTick(attachScrollListener)
  }
  // 编辑器可能在内容变化时重渲染 DOM，再兜底一次
  setTimeout(attachScrollListener, 200)
})

onUnmounted(() => {
  scrollContainer?.removeEventListener('scroll', onScroll)
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
})
</script>

<template>
  <div class="min-w-64 p-4 pr-0">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-400">
      大纲
    </h2>

    <div v-if="isEmpty" class="py-8 text-center text-xs text-gray-400">
      暂无标题
    </div>

    <div v-else class="space-y-0.5">
      <div
        v-for="item in flatList"
        :key="item.key"
        :class="indentClass(item.indent)"
        class="group flex items-center gap-1 py-0.5"
      >
        <!-- 展开/折叠箭头 -->
        <button
          class="flex size-4 shrink-0 items-center justify-center rounded text-gray-400 transition-colors"
          :class="item.hasChildren
            ? 'hover:text-gray-600 dark:hover:text-gray-300 cursor-pointer'
            : 'cursor-default invisible'"
          @click="item.hasChildren && toggleExpand(item.key)"
        >
          <svg
            class="size-2.5 transition-transform"
            :class="{ 'rotate-90': item.expanded && item.hasChildren }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        <!-- 标题文本 -->
        <button
          :class="[
            'truncate text-left text-xs transition-colors rounded px-1 py-0.5',
            'hover:bg-gray-200 dark:hover:bg-gray-800',
            item.key === currentKey
              ? 'font-bold text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800'
              : 'text-gray-700 dark:text-gray-300',
          ]"
          :title="item.displayText"
          @click="scrollToHeading(item)"
        >
          {{ item.displayText }}
        </button>
      </div>
    </div>
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
</style>

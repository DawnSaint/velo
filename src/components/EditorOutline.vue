<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string
}>()

// ========== 类型 ==========
interface HeadingItem {
  level: number
  text: string
  displayText: string
  children: HeadingItem[]
  key: string // 唯一标识符，用于折叠状态追踪
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

let headingIdCounter = 0

/** 移除围栏代码块（``` 和 ~~~），避免内部 # 被误判为标题 */
function stripFencedCodeBlocks(md: string): string {
  // 匹配 ```...``` 或 ~~~...~~~，替换时保留换行数以保持行号
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

  const root: HeadingItem[] = []
  const stack: HeadingItem[] = []

  for (const h of flat) {
    const item: HeadingItem = { ...h, children: [], key: `h-${headingIdCounter++}` }
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    if (stack.length === 0) root.push(item)
    else stack[stack.length - 1].children.push(item)
    stack.push(item)
  }
  return root
}

const tree = ref<HeadingItem[]>(parseHeadings(props.modelValue))

watch(() => props.modelValue, (v) => {
  headingIdCounter = 0
  collapsedKeys.value.clear()
  tree.value = parseHeadings(v)
})

// ========== 折叠状态：使用 Set 追踪被折叠的 key ==========
const collapsedKeys = ref<Set<string>>(new Set())

function toggleExpand(key: string) {
  const next = new Set(collapsedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
}

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

// ========== 主色用于 hover 等场景（从 CSS 变量读取） ==========
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
          class="truncate text-left text-xs transition-colors rounded px-1 py-0.5 hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
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

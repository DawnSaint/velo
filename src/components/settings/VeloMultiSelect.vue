<script setup lang="ts">
// 设置页多选下拉组件，基于 VeloSelect 模式扩展。
//
// 与 VeloSelect 的区别：
// - modelValue 为 string[]（多选）
// - 面板内每项带 checkbox，点击切换选中状态（不关闭面板）
// - 触发器显示摘要文本（全部 / 无 / 选中项列表）

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface VeloMultiSelectOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string[]
  options: VeloMultiSelectOption[]
  /** Tailwind 宽度 class，如 'w-48' / 'w-40' */
  widthClass?: string
  /** ARIA label */
  ariaLabel?: string
  /** 触发器摘要文本：全部选中时的文本 */
  allLabel?: string
  /** 触发器摘要文本：未选中任何项时的文本 */
  noneLabel?: string
}>(), {
  widthClass: 'w-48',
  allLabel: '全部',
  noneLabel: '无',
})

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const open = ref(false)
const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const highlightIndex = ref(-1)

const selectedSet = computed(() => new Set(props.modelValue))

const summary = computed(() => {
  const selected = props.options.filter(o => selectedSet.value.has(o.value))
  if (selected.length === 0) return props.noneLabel
  if (selected.length === props.options.length) return props.allLabel
  return selected.map(o => o.label).join('、')
})

// 面板 fixed 定位坐标 + 最小宽度（跟随触发器）
const panelTop = ref(0)
const panelLeft = ref(0)
const panelMinWidth = ref(0)

function updatePosition() {
  const el = triggerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  panelMinWidth.value = rect.width
  panelLeft.value = rect.left
  const panelHeight = panelRef.value?.offsetHeight ?? 300
  const spaceBelow = window.innerHeight - rect.bottom
  if (spaceBelow < panelHeight + 8 && rect.top > spaceBelow) {
    panelTop.value = Math.max(8, rect.top - panelHeight - 4)
  } else {
    panelTop.value = rect.bottom + 4
  }
}

function openDropdown() {
  if (open.value) return
  open.value = true
  highlightIndex.value = 0
  nextTick(() => {
    updatePosition()
    scrollHighlightIntoView()
  })
}

function closeDropdown() {
  open.value = false
}

function toggleDropdown() {
  if (open.value) closeDropdown()
  else openDropdown()
}

function toggleOption(option: VeloMultiSelectOption) {
  const set = new Set(props.modelValue)
  if (set.has(option.value)) set.delete(option.value)
  else set.add(option.value)
  emit('update:modelValue', [...set])
}

function scrollHighlightIntoView() {
  nextTick(() => {
    const panel = panelRef.value
    if (!panel) return
    const items = panel.querySelectorAll<HTMLElement>('[role="option"]')
    const item = items[highlightIndex.value]
    if (item) item.scrollIntoView({ block: 'nearest' })
  })
}

function onTriggerKeydown(e: KeyboardEvent) {
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      openDropdown()
    }
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      highlightIndex.value = Math.min(highlightIndex.value + 1, props.options.length - 1)
      scrollHighlightIntoView()
      break
    case 'ArrowUp':
      e.preventDefault()
      highlightIndex.value = Math.max(highlightIndex.value - 1, 0)
      scrollHighlightIntoView()
      break
    case 'Home':
      e.preventDefault()
      highlightIndex.value = 0
      scrollHighlightIntoView()
      break
    case 'End':
      e.preventDefault()
      highlightIndex.value = props.options.length - 1
      scrollHighlightIntoView()
      break
    case 'Enter':
    case ' ':
      e.preventDefault()
      if (highlightIndex.value >= 0 && highlightIndex.value < props.options.length) {
        toggleOption(props.options[highlightIndex.value])
      }
      break
    case 'Escape':
      e.preventDefault()
      closeDropdown()
      triggerRef.value?.focus()
      break
  }
}

function onDocumentMousedown(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return
  closeDropdown()
}

function onWindowScroll(e: Event) {
  if (!open.value) return
  const target = e.target as Node
  if (panelRef.value?.contains(target)) return
  closeDropdown()
}

function onWindowResize() {
  if (open.value) closeDropdown()
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocumentMousedown)
    window.addEventListener('scroll', onWindowScroll, { capture: true, passive: true })
    window.addEventListener('resize', onWindowResize)
  } else {
    document.removeEventListener('mousedown', onDocumentMousedown)
    window.removeEventListener('scroll', onWindowScroll, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', onWindowResize)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMousedown)
  window.removeEventListener('scroll', onWindowScroll, { capture: true } as EventListenerOptions)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="velo-select-trigger"
    :class="widthClass"
    role="combobox"
    :aria-expanded="open"
    :aria-label="ariaLabel"
    aria-haspopup="listbox"
    @click="toggleDropdown"
    @keydown="onTriggerKeydown"
  >
    <span class="velo-select-option__label truncate">{{ summary }}</span>
    <svg class="velo-select-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>

  <Teleport to="body">
    <Transition name="velo-select-panel">
      <div
        v-if="open"
        ref="panelRef"
        class="velo-select-panel"
        role="listbox"
        :style="{
          top: `${panelTop}px`,
          left: `${panelLeft}px`,
          minWidth: `${panelMinWidth}px`,
        }"
      >
        <div
          v-for="(option, idx) in options"
          :key="option.value"
          class="velo-select-option"
          :class="{
            'velo-select-option--highlighted': idx === highlightIndex,
          }"
          role="option"
          :aria-selected="selectedSet.has(option.value)"
          @click="toggleOption(option)"
          @mouseenter="highlightIndex = idx"
        >
          <span class="flex items-center gap-2">
            <span
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
              :class="selectedSet.has(option.value)
                ? 'border-[var(--md-primary-color,#1F71D9)] bg-[var(--md-primary-color,#1F71D9)] text-white'
                : 'border-gray-300 dark:border-gray-500'"
            >
              <svg v-if="selectedSet.has(option.value)" width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5L4 7L8 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="velo-select-option__label">{{ option.label }}</span>
          </span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
// 设置页自定义下拉组件,替代原生 <select>。
//
// 设计要点:
// - **色块预览**:option.swatches 传入 hex 数组,在选项右侧渲染小圆点;
//   代码块主题用此功能预览各主题代表色,避免来回切 tab 看效果。
// - **Teleport to body**:面板 fixed 定位,防设置页 overflow 裁切(同 ContextMenuShell 范式)。
// - **键盘导航**:ArrowUp/Down 移动高亮、Enter 选中、Escape 关闭、Home/End 跳首尾。
// - **关闭时机**:点击外部 / 滚动 / 窗口 resize(触发器位置已变,面板需重新定位或关闭)。
// - **样式**:触发器走 .velo-select-trigger + Tailwind 宽度;面板 / 选项 / 色块走 _settings.scss 全局类(Teleport 内容不走 scoped)。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface VeloSelectOption {
  value: string
  label: string
  /** 色块预览:hex 颜色数组,渲染为小圆点(代码块主题用) */
  swatches?: string[]
}

const props = withDefaults(defineProps<{
  modelValue: string
  options: VeloSelectOption[]
  /** Tailwind 宽度 class,如 'w-48' / 'w-40' */
  widthClass?: string
  /** ARIA label */
  ariaLabel?: string
}>(), {
  widthClass: 'w-48',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const open = ref(false)
const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const highlightIndex = ref(-1)

const selectedOption = computed(() =>
  props.options.find(o => o.value === props.modelValue) ?? props.options[0],
)

// 面板 fixed 定位坐标 + 最小宽度(跟随触发器)
const panelTop = ref(0)
const panelLeft = ref(0)
const panelMinWidth = ref(0)

function updatePosition() {
  const el = triggerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  panelMinWidth.value = rect.width
  panelLeft.value = rect.left
  // 默认在触发器下方展开;测量面板实际高度后,若下方空间不足且上方更宽裕则向上翻转
  const panel = panelRef.value
  const panelHeight = panel?.offsetHeight ?? 300
  const spaceBelow = window.innerHeight - rect.bottom
  if (spaceBelow < panelHeight + 8 && rect.top > spaceBelow) {
    panelTop.value = Math.max(8, rect.top - panelHeight - 4)
  } else {
    panelTop.value = rect.bottom + 4
  }
}

function openDropdown() {
  if (open.value || props.options.length === 0) return
  open.value = true
  highlightIndex.value = Math.max(0, props.options.findIndex(o => o.value === props.modelValue))
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

function selectOption(option: VeloSelectOption) {
  emit('update:modelValue', option.value)
  closeDropdown()
  triggerRef.value?.focus()
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
      e.preventDefault()
      if (highlightIndex.value >= 0 && highlightIndex.value < props.options.length) {
        selectOption(props.options[highlightIndex.value])
      }
      break
    case 'Escape':
      e.preventDefault()
      closeDropdown()
      triggerRef.value?.focus()
      break
  }
}

// 点击外部关闭(mousedown 早于 click,防止选项 click 被吞)
function onDocumentMousedown(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return
  closeDropdown()
}

// 滚动 / resize:关闭面板(触发器已移位)。
// 面板自身滚动不触发关闭(capture 阶段判断 e.target 是否面板内)。
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
    :aria-haspopup="'listbox'"
    @click="toggleDropdown"
    @keydown="onTriggerKeydown"
  >
    <span class="velo-select-option__label">{{ selectedOption?.label }}</span>
    <!-- chevron-down:12px SVG,opacity 0.45,展开时旋转 180°(见 _settings.scss) -->
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
            'velo-select-option--selected': option.value === modelValue,
          }"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="selectOption(option)"
          @mouseenter="highlightIndex = idx"
        >
          <span class="velo-select-option__label">{{ option.label }}</span>
          <!-- 色块预览:keyword / string / func / comment 四个代表色 -->
          <span v-if="option.swatches && option.swatches.length > 0" class="velo-select-swatches">
            <span
              v-for="(color, ci) in option.swatches"
              :key="ci"
              class="velo-select-swatch"
              :style="{ backgroundColor: color }"
            />
          </span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

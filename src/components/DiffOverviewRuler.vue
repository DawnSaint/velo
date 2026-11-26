<script setup lang="ts">
// DiffOverviewRuler(#diff-ruler):滚动条与变更概览标尺合一组件(VS Code 两轨制)。
//
// - 18px 单一轨道同时承担滚动滑块(thumb)与变更色块展示,不再与内容区共存双滚动条
// - 两轨排布:左轨 = 删除(Primer 柔红),右轨 = 新增(Primer 柔绿);
//   同时含增删的 modified hunk 在左右两轨同时落块
// - 每轨独立做像素分桶合并,保证极端长文档下 DOM 节点数有硬上限
// - hover 色块不变色、点击色块无蓝框,直接触发 select(anchorIndex) 滚动到位

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DiffAnchor } from '@/utils/diffAnchors'

const props = defineProps<{
  anchors: DiffAnchor[]
  scrollElement: HTMLElement | null
}>()

const emit = defineEmits<{
  select: [index: number]
}>()

const MIN_MARK_HEIGHT = 4
const MIN_THUMB_HEIGHT = 40

interface RulerMark {
  key: string
  lane: 'del' | 'add'
  top: number
  height: number
  anchorIndex: number
}

const trackRef = ref<HTMLElement | null>(null)
const trackHeight = ref(0)

const thumbVisible = ref(false)
const thumbTop = ref(0)
const thumbHeight = ref(MIN_THUMB_HEIGHT)
const isDragging = ref(false)
const isThumbHover = ref(false)

/** 单轨像素分桶合并:将同一轨道内重叠或间距 ≤1px 的相邻色块合并,控制 DOM 上限 */
function buildLaneMarks(
  items: Array<{ startRatio: number; endRatio: number; anchorIndex: number }>,
  lane: 'del' | 'add',
  height: number,
): RulerMark[] {
  if (height <= 0 || items.length === 0) return []

  const raw = items.map((item) => {
    const rawTop = item.startRatio * height
    const rawH = Math.max((item.endRatio - item.startRatio) * height, MIN_MARK_HEIGHT)
    const top = Math.min(rawTop, Math.max(0, height - rawH))
    return {
      top,
      bottom: Math.min(height, top + rawH),
      anchorIndex: item.anchorIndex,
    }
  }).sort((a, b) => a.top - b.top)

  const merged: RulerMark[] = []
  for (const seg of raw) {
    const prev = merged[merged.length - 1]
    if (prev && seg.top <= prev.top + prev.height + 1) {
      const nextBottom = Math.max(prev.top + prev.height, seg.bottom)
      prev.height = nextBottom - prev.top
    }
    else {
      merged.push({
        key: `${lane}-${seg.anchorIndex}-${Math.round(seg.top)}`,
        lane,
        top: seg.top,
        height: seg.bottom - seg.top,
        anchorIndex: seg.anchorIndex,
      })
    }
  }
  return merged
}

const marks = computed<RulerMark[]>(() => {
  const h = trackHeight.value
  if (h <= 0 || props.anchors.length === 0) return []

  const delItems: Array<{ startRatio: number; endRatio: number; anchorIndex: number }> = []
  const addItems: Array<{ startRatio: number; endRatio: number; anchorIndex: number }> = []

  for (const anchor of props.anchors) {
    if (anchor.kind === 'removed' || anchor.kind === 'modified') {
      delItems.push({
        startRatio: anchor.startRatio,
        endRatio: anchor.endRatio,
        anchorIndex: anchor.index,
      })
    }
    if (anchor.kind === 'added' || anchor.kind === 'modified') {
      addItems.push({
        startRatio: anchor.startRatio,
        endRatio: anchor.endRatio,
        anchorIndex: anchor.index,
      })
    }
  }

  return [
    ...buildLaneMarks(delItems, 'del', h),
    ...buildLaneMarks(addItems, 'add', h),
  ]
})

function updateThumb(): void {
  const el = props.scrollElement
  const h = trackHeight.value || trackRef.value?.clientHeight || 0
  if (!el || h <= 0) {
    thumbVisible.value = false
    return
  }

  const { scrollTop, scrollHeight, clientHeight } = el
  if (scrollHeight <= clientHeight + 1) {
    thumbVisible.value = false
    return
  }

  thumbVisible.value = true
  const th = Math.min(h, Math.max((clientHeight / scrollHeight) * h, MIN_THUMB_HEIGHT))
  const maxScroll = scrollHeight - clientHeight
  const topRatio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0
  thumbHeight.value = th
  thumbTop.value = topRatio * Math.max(0, h - th)
}

let rafId: number | null = null
function scheduleThumbUpdate(): void {
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    updateThumb()
  })
}

// ── 滚动容器与内容尺寸监听 ──

let scrollCleanup: (() => void) | null = null

function bindScrollElement(el: HTMLElement | null): void {
  scrollCleanup?.()
  scrollCleanup = null

  if (!el) {
    thumbVisible.value = false
    return
  }

  const onScroll = () => scheduleThumbUpdate()
  el.addEventListener('scroll', onScroll, { passive: true })

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => scheduleThumbUpdate())
    : null
  ro?.observe(el)
  if (el.firstElementChild) ro?.observe(el.firstElementChild)

  const mo = typeof MutationObserver !== 'undefined'
    ? new MutationObserver(() => {
        if (el.firstElementChild) ro?.observe(el.firstElementChild)
        scheduleThumbUpdate()
      })
    : null
  mo?.observe(el, { childList: true })

  scrollCleanup = () => {
    el.removeEventListener('scroll', onScroll)
    ro?.disconnect()
    mo?.disconnect()
  }

  updateThumb()
}

watch(() => props.scrollElement, (el) => {
  bindScrollElement(el)
}, { immediate: true })

watch(() => props.anchors, () => {
  scheduleThumbUpdate()
})

// ── 轨道高度监听 ──

let trackRo: ResizeObserver | null = null

function measureTrack(): void {
  const h = trackRef.value?.clientHeight ?? 0
  if (h !== trackHeight.value) {
    trackHeight.value = h
  }
  updateThumb()
}

// ── 滑块与轨道拖拽交互 ──

type DragState =
  | { mode: 'thumb'; startY: number; startScrollTop: number; movableTrack: number }
  | { mode: 'track'; top: number; height: number }

let drag: DragState | null = null

function onDragMove(e: MouseEvent): void {
  const el = props.scrollElement
  if (!drag || !el) return
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
  if (maxScroll <= 0) return

  if (drag.mode === 'thumb') {
    const delta = e.clientY - drag.startY
    const next = drag.startScrollTop + (delta / Math.max(1, drag.movableTrack)) * maxScroll
    el.scrollTop = Math.max(0, Math.min(maxScroll, next))
  }
  else {
    const ratio = Math.max(0, Math.min(1, (e.clientY - drag.top) / Math.max(1, drag.height)))
    el.scrollTop = ratio * maxScroll
  }
}

function endDrag(): void {
  if (!drag) return
  drag = null
  isDragging.value = false
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', endDrag)
}

function onThumbMouseDown(e: MouseEvent): void {
  const el = props.scrollElement
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  const h = trackHeight.value || trackRef.value?.clientHeight || 0
  drag = {
    mode: 'thumb',
    startY: e.clientY,
    startScrollTop: el.scrollTop,
    movableTrack: Math.max(1, h - thumbHeight.value),
  }
  isDragging.value = true
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', endDrag)
}

function onTrackMouseDown(e: MouseEvent): void {
  const el = props.scrollElement
  const track = trackRef.value
  if (!el || !track) return
  e.preventDefault()
  const rect = track.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)))
  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
  el.scrollTop = ratio * maxScroll

  drag = { mode: 'track', top: rect.top, height: rect.height }
  isDragging.value = true
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', endDrag)
}

function onMarkMouseDown(e: MouseEvent, anchorIndex: number): void {
  e.preventDefault()
  e.stopPropagation()
  emit('select', anchorIndex)
}

onMounted(() => {
  measureTrack()
  if (typeof ResizeObserver !== 'undefined' && trackRef.value) {
    trackRo = new ResizeObserver(() => measureTrack())
    trackRo.observe(trackRef.value)
  }
})

onBeforeUnmount(() => {
  endDrag()
  scrollCleanup?.()
  scrollCleanup = null
  trackRo?.disconnect()
  trackRo = null
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
})
</script>

<template>
  <div
    ref="trackRef"
    data-diff-ruler
    class="relative w-[24px] shrink-0 select-none border-l border-[var(--surface-border)]"
    @mousedown="onTrackMouseDown"
  >
    <!-- 变更色块(两轨制:左删除 / 右新增;hover 不变色,点击无蓝框) -->
    <div
      v-for="m in marks"
      :key="m.key"
      :data-ruler-mark="m.lane"
      :data-anchor-idx="m.anchorIndex"
      class="absolute z-[5] cursor-pointer rounded-[1px]"
      :style="{
        top: `${m.top}px`,
        height: `${m.height}px`,
        left: m.lane === 'del' ? '3px' : '13px',
        width: '8px',
        backgroundColor: m.lane === 'del' ? 'var(--diff-ruler-del)' : 'var(--diff-ruler-add)',
      }"
      @mousedown="onMarkMouseDown($event, m.anchorIndex)"
    />

    <!-- 半透明滚动滑块(叠在色块之上,VS Code 风格) -->
    <div
      v-show="thumbVisible"
      data-ruler-thumb
      class="absolute left-0 right-0 z-[15] rounded-l-[4px] transition-colors duration-100"
      :class="isDragging ? 'cursor-grabbing' : 'cursor-grab'"
      :style="{
        top: `${thumbTop}px`,
        height: `${thumbHeight}px`,
        backgroundColor: (isThumbHover || isDragging)
          ? 'var(--diff-ruler-thumb-hover)'
          : 'var(--diff-ruler-thumb)',
      }"
      @mouseenter="isThumbHover = true"
      @mouseleave="isThumbHover = false"
      @mousedown="onThumbMouseDown"
    />
  </div>
</template>

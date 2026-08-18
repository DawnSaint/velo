<script setup lang="ts">
// Zoom 指示器浮层(v0.7.12 #zoom)
//
// 快捷键(Mod-Shift-= / Mod-Shift-- / Mod-Shift-0)触发 zoom 时弹出,
// 底部居中显示当前缩放百分比 + 可拖动滑块 + 重置按钮。
// 2s 无操作自动消失;拖动滑块时保持可见(useZoom timer 由 showZoomIndicator 重置)。
//
// 数据层:读 editorStore.zoomLevel + clampZoomLevel,拖动时直接写 store。
// 样式:复用 velo-slider-track / velo-slider-knob(同 EditorGroup 字号滑块)。

import { computed, ref } from 'vue'
import { RotateCcw } from '@lucide/vue'
import { useEditorStore, ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX, ZOOM_LEVEL_DEFAULT, clampZoomLevel } from '@/stores/editor'
import { zoomIndicatorVisible, showZoomIndicator } from '@/composables/useZoom'

const store = useEditorStore()

const zoomPercent = computed(() => `${Math.round(store.zoomLevel * 100)}%`)

// ---- 滑块拖动(同 EditorGroup 字号滑块范式) ----
const trackRef = ref<HTMLElement | null>(null)
const dragPointerId = ref<number | null>(null)
const draggingRatio = ref<number | null>(null)

const activeLevel = computed(() => {
  if (draggingRatio.value !== null) {
    const v = ZOOM_LEVEL_MIN + draggingRatio.value * (ZOOM_LEVEL_MAX - ZOOM_LEVEL_MIN)
    return Math.round(v * 10) / 10
  }
  return store.zoomLevel
})

const knobRatio = computed(() => {
  const v = draggingRatio.value !== null ? activeLevel.value : store.zoomLevel
  return (v - ZOOM_LEVEL_MIN) / (ZOOM_LEVEL_MAX - ZOOM_LEVEL_MIN)
})

function ratioFromClientX(clientX: number): number {
  const el = trackRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

function commitRatio(r: number) {
  const v = ZOOM_LEVEL_MIN + r * (ZOOM_LEVEL_MAX - ZOOM_LEVEL_MIN)
  store.zoomLevel = clampZoomLevel(Math.round(v * 10) / 10)
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  trackRef.value?.setPointerCapture(e.pointerId)
  dragPointerId.value = e.pointerId
  draggingRatio.value = ratioFromClientX(e.clientX)
}

function onPointerMove(e: PointerEvent) {
  if (dragPointerId.value !== e.pointerId) return
  e.preventDefault()
  draggingRatio.value = ratioFromClientX(e.clientX)
}

function endDrag(e: PointerEvent) {
  if (dragPointerId.value !== e.pointerId) return
  if (draggingRatio.value !== null) {
    commitRatio(draggingRatio.value)
    showZoomIndicator()
  }
  draggingRatio.value = null
  dragPointerId.value = null
  trackRef.value?.releasePointerCapture(e.pointerId)
}

function onReset() {
  store.zoomLevel = ZOOM_LEVEL_DEFAULT
  showZoomIndicator()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="velo-zoom-indicator">
      <div
        v-if="zoomIndicatorVisible"
        class="velo-zoom-indicator fixed bottom-8 left-1/2 z-[1000] flex items-center gap-3 rounded-full bg-[var(--surface-3)] px-5 py-2.5 shadow-[var(--shadow-popover)] ring-1 ring-black/5 dark:ring-white/10"
        role="region"
        aria-label="缩放"
      >
        <span class="min-w-[3.5rem] text-center text-sm font-medium tabular-nums text-gray-700 dark:text-gray-200">
          {{ zoomPercent }}
        </span>
        <div
          ref="trackRef"
          class="velo-slider-track relative h-5 w-40 touch-none select-none"
          :class="{ 'is-dragging': draggingRatio !== null }"
          role="slider"
          aria-label="缩放"
          :aria-valuenow="activeLevel"
          :aria-valuemin="ZOOM_LEVEL_MIN"
          :aria-valuemax="ZOOM_LEVEL_MAX"
          :aria-valuetext="`缩放 ${zoomPercent}`"
          tabindex="0"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <span class="velo-slider-line absolute inset-x-0 top-1/2 block h-1 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700" />
          <span
            class="velo-slider-knob absolute top-1/2 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
            :style="{ left: `${knobRatio * 100}%` }"
          />
        </div>
        <button
          type="button"
          class="shrink-0 rounded-full p-1 text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
          aria-label="重置缩放"
          title="重置缩放"
          @click="onReset"
        >
          <RotateCcw :size="16" aria-hidden="true" />
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.velo-zoom-indicator {
  transform: translateX(-50%);
}
.velo-zoom-indicator-enter-active,
.velo-zoom-indicator-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.velo-zoom-indicator-enter-from,
.velo-zoom-indicator-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>

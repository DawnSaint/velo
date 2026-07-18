<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { BUNDLED_THEMES } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'

const store = useEditorStore()

const lightThemes = computed(() => BUNDLED_THEMES.filter(t => t.type === 'light'))
const darkThemes = computed(() => BUNDLED_THEMES.filter(t => t.type === 'dark'))

function themeLabel(t: { displayName: string, id: string }): string {
  return t.displayName || t.id
}

/* ---------- 字号滑块 ---------- */
// 可视"可拖圆 + 直线"选择器,Obsidian / 微信风格:一段带刻度直线 + 可拖圆。
// 数据层仍走 store.fontSize(同旧 select 一致:px 字符串;持久化 / 导出 /
// 编辑器 rebuild 全链路不改);UI 层把它渲染成 slider。
// 可选范围 12~24,每 1px 一档。圆永远在线上(没有"已填充"的长条),放手吸附最近刻度。
const FONT_SIZE_MIN = 12
const FONT_SIZE_MAX = 24
const FONT_SIZE_DEFAULT = 16

function fontSizeToIndex(v: string): number {
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n))
}

const sliderTrackRef = ref<HTMLElement | null>(null)
const dragPointerId = ref<number | null>(null)
// 拖动中的圆心位置(0~1);放手后吸附最近刻度写入 store。
const draggingRatio = ref<number | null>(null)

// 当前刻度:拖动中取 draggingRatio 反算,否则取 store 解析后值。
const activeSize = computed(() => {
  if (draggingRatio.value !== null) {
    return Math.round(FONT_SIZE_MIN + draggingRatio.value * (FONT_SIZE_MAX - FONT_SIZE_MIN))
  }
  return fontSizeToIndex(store.fontSize)
})

// 圆心 0~1 位置。
const knobRatio = computed(() => {
  const size = draggingRatio.value !== null
    ? activeSize.value
    : fontSizeToIndex(store.fontSize)
  return (size - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN)
})

function ratioFromClientX(clientX: number): number {
  const el = sliderTrackRef.value
  if (!el) return 0
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

function commitRatio(r: number) {
  const size = Math.round(FONT_SIZE_MIN + r * (FONT_SIZE_MAX - FONT_SIZE_MIN))
  const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))
  // 只接受整数 px;store 是 px 字符串(同旧 select 格式,持久化 / 导出兼容)。
  store.fontSize = `${clamped}px`
}

function onTrackPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  sliderTrackRef.value?.setPointerCapture(e.pointerId)
  dragPointerId.value = e.pointerId
  draggingRatio.value = ratioFromClientX(e.clientX)
}

function onTrackPointerMove(e: PointerEvent) {
  if (dragPointerId.value !== e.pointerId) return
  e.preventDefault()
  draggingRatio.value = ratioFromClientX(e.clientX)
}

function endDrag(e: PointerEvent) {
  if (dragPointerId.value !== e.pointerId) return
  if (draggingRatio.value !== null) commitRatio(draggingRatio.value)
  draggingRatio.value = null
  dragPointerId.value = null
  sliderTrackRef.value?.releasePointerCapture(e.pointerId)
}
</script>

<template>
  <section class="space-y-5">
    <h2 class="text-sm font-semibold text-gray-700 dark:text-gray-200">编辑器</h2>

    <!-- 字号:滑块选择器。数值显示在 label 行右侧(不挂在拖圆上),
         刻度仅"精确选中"那一档高亮放大,其余保持灰色小点。 -->
    <div>
      <div class="velo-setting-row h-8">
        <span class="velo-setting-label">字号</span>
        <span class="velo-setting-value">{{ activeSize }}px</span>
      </div>
      <div
        ref="sliderTrackRef"
        class="velo-slider-track relative h-8 touch-none select-none"
        :class="{ 'is-dragging': draggingRatio !== null }"
        role="slider"
        aria-label="字号"
        :aria-valuenow="activeSize"
        :aria-valuemin="FONT_SIZE_MIN"
        :aria-valuemax="FONT_SIZE_MAX"
        :aria-valuetext="`字号 ${activeSize}px`"
        tabindex="0"
        @pointerdown="onTrackPointerDown"
        @pointermove="onTrackPointerMove"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <span class="velo-slider-line absolute inset-x-0 top-1/2 block h-0.5 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700" />
        <!-- 拖动圆:纯白球 + 灰边,暗色下深球 + 浅边(颜色见 CSS) -->
        <span
          class="velo-slider-knob absolute top-1/2 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
          :style="{ left: `${knobRatio * 100}%` }"
        />
      </div>
    </div>

    <!-- 代码块主题:浅色 + 深色,各一个下拉(带过滤)。切换走
      lazy load(~100-300ms),由 App.vue watch store 触发 ensureTheme +
      dispatch rebuild。独立于 darkMode toggle(后者是纯 CSS 切色)。 -->
    <div>
      <label class="velo-setting-toplabel">代码块主题(浅色)</label>
      <select
        v-model="store.codeLightTheme"
        class="velo-select w-full rounded-lg border p-1.5 text-sm outline-none"
      >
        <option v-for="t in lightThemes" :key="t.id" :value="t.id">{{ themeLabel(t) }}</option>
      </select>
    </div>
    <div>
      <label class="velo-setting-toplabel">代码块主题(深色)</label>
      <select
        v-model="store.codeDarkTheme"
        class="velo-select w-full rounded-lg border p-1.5 text-sm outline-none"
      >
        <option v-for="t in darkThemes" :key="t.id" :value="t.id">{{ themeLabel(t) }}</option>
      </select>
    </div>

    <!-- 开关项:左 label 右 switch,激活色走主题色 -->
    <div class="space-y-3 pt-1">
      <label class="velo-setting-row h-8 cursor-pointer">
        <span class="velo-setting-label">代码块行号</span>
        <input
          v-model="store.showCodeLineNumbers"
          type="checkbox"
          role="switch"
          class="velo-switch"
        >
      </label>
      <label class="velo-setting-row h-8 cursor-pointer">
        <span class="velo-setting-label">面包屑</span>
        <input
          v-model="store.showBreadcrumbs"
          type="checkbox"
          role="switch"
          class="velo-switch"
        >
      </label>
    </div>
  </section>
</template>

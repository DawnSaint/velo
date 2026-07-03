<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useDocumentStore } from '@/stores/document'
import { BUNDLED_THEMES } from './ProseMirrorEditor/nodes/CodeBlockLangs'

const store = useEditorStore()
const documentStore = useDocumentStore()

const lightThemes = computed(() =>
  BUNDLED_THEMES.filter(t => t.type === 'light'),
)
const darkThemes = computed(() =>
  BUNDLED_THEMES.filter(t => t.type === 'dark'),
)

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
  <div class="flex h-full min-w-0 flex-col p-4">
    <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-400">设置</h2>

    <!-- 统一的"行"样式:left-label right-control。
         子元素字号 13px medium,与主题一致;顶层分组标签沿用 12px uppercase。
         行高 h-8(=32px)让 switch/slider/颜色行视觉对齐。 -->
    <div class="flex-1 space-y-4">
      <!-- 字号:滑块选择器。数值显示在 label 行右侧(不挂在拖圆上),
           刻度仅"精确选中"那一档高亮放大,其余保持灰色小点。 -->
      <div>
        <div class="setting-row h-8">
          <span class="setting-label">字号</span>
          <span class="setting-label-value">{{ activeSize }}px</span>
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
        <label class="top-label">代码块主题(浅色)</label>
        <select
          v-model="store.codeLightTheme"
          class="velo-select w-full rounded-lg border p-1.5 text-sm outline-none"
        >
          <option v-for="t in lightThemes" :key="t.id" :value="t.id">{{ themeLabel(t) }}</option>
        </select>
      </div>
      <div>
        <label class="top-label">代码块主题(深色)</label>
        <select
          v-model="store.codeDarkTheme"
          class="velo-select w-full rounded-lg border p-1.5 text-sm outline-none"
        >
          <option v-for="t in darkThemes" :key="t.id" :value="t.id">{{ themeLabel(t) }}</option>
        </select>
      </div>

      <!-- 启动时打开内容 -->
      <div>
        <label class="top-label">启动时打开</label>
        <select
          v-model="store.startupMode"
          class="velo-select w-full rounded-lg border p-1.5 text-sm outline-none"
        >
          <option value="last-file">上次打开的文件</option>
          <option value="new-doc">新文档</option>
        </select>
      </div>

      <!-- 主色 -->
      <div class="setting-row h-8">
        <span class="setting-label">主色</span>
        <span class="flex items-center gap-2">
          <span class="text-sm tabular-nums text-gray-600 dark:text-gray-300">{{ store.primaryColor }}</span>
          <input
            v-model="store.primaryColor"
            type="color"
            class="velo-color-circle h-6 w-6 cursor-pointer rounded-full p-0 dark:border-gray-700"
          />
        </span>
      </div>

      <!-- 开关项:左 label 右 switch,激活色走主题色 -->
      <div class="space-y-3 pt-1">
        <label class="setting-row h-8 cursor-pointer">
          <span class="setting-label">Mac 代码块圆点</span>
          <input
            v-model="store.isMacCodeBlock"
            type="checkbox"
            role="switch"
            class="velo-switch"
          >
        </label>
        <label class="setting-row h-8 cursor-pointer">
          <span class="setting-label">代码块行号</span>
          <input
            v-model="store.showCodeLineNumbers"
            type="checkbox"
            role="switch"
            class="velo-switch"
          >
        </label>
        <label class="setting-row h-8 cursor-pointer">
          <span class="setting-label">暗色模式</span>
          <input
            v-model="store.darkMode"
            type="checkbox"
            role="switch"
            class="velo-switch"
          >
        </label>
        <label class="setting-row h-8 cursor-pointer">
          <span class="setting-label">自动保存</span>
          <input
            v-model="documentStore.autoSaveEnabled"
            type="checkbox"
            role="switch"
            class="velo-switch"
          >
        </label>
        <label class="setting-row h-8 cursor-pointer">
          <span class="setting-label">失焦保存</span>
          <input
            v-model="documentStore.autoSaveOnBlur"
            type="checkbox"
            role="switch"
            class="velo-switch"
          >
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 顶层分组标签:与 switch 行 label 同字号字重颜色(13px medium),
   仅比 setting-label 多一行"block + 下方间距",保证视觉统一。 */
.top-label {
  display: block;
  margin-bottom: 0.25rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgb(75 85 99); /* gray-600 */
}
.dark .top-label {
  color: rgb(209 213 219); /* gray-300 */
}

/* 统一"行"容器:左右排列、居中对齐。 */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
/* 行内 label:13px medium,与正文 / 字号显示一致 */
.setting-label {
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgb(75 85 99); /* gray-600 */
}
.dark .setting-label {
  color: rgb(209 213 219); /* gray-300 */
}
/* 行内右侧数值(如字号当前值):与 setting-label 同字号,等宽数字避免跳动 */
.setting-label-value {
  font-size: 0.8125rem;
  font-weight: 500;
  font-feature-settings: 'tnum';
  color: rgb(75 85 99); /* gray-600 */
}
.dark .setting-label-value {
  color: rgb(209 213 219); /* gray-300 */
}

/* select 控件:与 / 开关 / 颜色行视觉高度对齐(13px font + py */
.velo-select {
  border-color: rgb(229 231 235); /* gray-200 */
  background-color: white;
  color: rgb(17 24 39); /* gray-900 */
  font-size: 0.8125rem;
}
.dark .velo-select {
  border-color: rgb(55 65 81); /* gray-700 */
  background-color: rgb(37 37 37); /* #252525,同旧值 */
  color: rgb(229 231 235); /* gray-200 */
}
.velo-select option {
  font-size: 0.8125rem;
}

/* 去掉 input[type=color] 默认外观,内部色块(::-webkit-color-swatch / ::-moz-color-swatch)
 * 撑满整个圆,否则只有外框是圆的,中间是方形色块。 */
.velo-color-circle {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  overflow: hidden;
}
.velo-color-circle::-webkit-color-swatch-wrapper {
  padding: 0;
}
.velo-color-circle::-webkit-color-swatch {
  border: none;
  border-radius: 9999px;
}
.velo-color-circle::-moz-color-swatch {
  border: none;
  border-radius: 9999px;
}

/* ---------- 开关 ---------- */
/* 原生 checkbox 重绘画成 switch 外观;激活色走主题色 --md-primary-color。
 * 主题色由 App.vue 在根节点注入,这里直接引用即可。 */
.velo-switch {
  --switch-w: 36px;
  --switch-h: 20px;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  position: relative;
  width: var(--switch-w);
  height: var(--switch-h);
  border-radius: 9999px;
  background: #d1d5db; /* gray-300,未激活 */
  cursor: pointer;
  transition: background-color .18s ease;
  flex-shrink: 0;
}
.velo-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(var(--switch-h) - 4px);
  height: calc(var(--switch-h) - 4px);
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .18);
  transition: transform .18s ease;
}
.velo-switch:checked {
  background: var(--md-primary-color, #1F71D9);
}
.velo-switch:checked::after {
  transform: translateX(calc(var(--switch-w) - var(--switch-h)));
}
.dark .velo-switch:not(:checked) {
  background: #4b5563; /* gray-600 */
}
.velo-switch:focus-visible {
  outline: 2px solid var(--md-primary-color, #1F71D9);
  outline-offset: 2px;
}

/* ---------- 字号滑块 ---------- */
.velo-slider-track {
  cursor: pointer;
}
.velo-slider-track.is-dragging {
  cursor: grabbing;
}
/* 拖动圆:纯白球 + 灰边;暗色下深球 + 浅边。位置随指针即时跟随,不做放大/浮动反馈 */
.velo-slider-knob {
  will-change: left;
  background: #ffffff;
  border-color: rgb(209 213 219); /* gray-300 */
}
.dark .velo-slider-knob {
  background: rgb(37 37 37); /* #252525,同 select 暗色背景 */
  border-color: rgb(107 114 128); /* gray-500 */
}
.velo-slider-track:focus-visible {
  outline: 2px solid var(--md-primary-color, #1F71D9);
  outline-offset: 2px;
  border-radius: 6px;
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { BUNDLED_THEMES, NO_THEME } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import { THEME_PALETTES } from '@/components/ProseMirrorEditor/nodes/themePalettes'
import SettingsItem from '../SettingsItem.vue'
import VeloSelect, { type VeloSelectOption } from '../VeloSelect.vue'

const store = useEditorStore()

// 从主题色板提取 4 个代表色(keyword / string / func / comment)作为色块预览;
// 过滤空值(部分主题缺某些 scope 的颜色定义)。
function themeSwatches(id: string): string[] {
  const p = THEME_PALETTES[id]
  if (!p) return []
  return [p.keyword, p.string, p.func, p.comment].filter(c => c)
}

// 「无主题」选项:不使用 shiki 渲染,代码块显示纯文本。
const NO_THEME_OPTION: VeloSelectOption = { value: NO_THEME, label: '无主题' }

const lightThemeOptions = computed<VeloSelectOption[]>(() => [
  NO_THEME_OPTION,
  ...BUNDLED_THEMES.filter(t => t.type === 'light').map(t => ({
    value: t.id,
    label: t.displayName || t.id,
    swatches: themeSwatches(t.id),
  })),
])
const darkThemeOptions = computed<VeloSelectOption[]>(() => [
  NO_THEME_OPTION,
  ...BUNDLED_THEMES.filter(t => t.type === 'dark').map(t => ({
    value: t.id,
    label: t.displayName || t.id,
    swatches: themeSwatches(t.id),
  })),
])

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
  <section class="space-y-4 pt-6">
    <!-- 字号:滑块选择器,与 title 同行。数值文字 font-size 随当前设置值缩放,
         直观预览字号效果。数值放在滑块左侧,滑块固定宽度不再撑满整行。 -->
    <SettingsItem label="字号" :keywords="['font-size', 'size']">
      <div class="flex items-center gap-3">
        <span
          class="velo-setting-value whitespace-nowrap"
          :style="{ fontSize: `${activeSize}px` }"
        >{{ activeSize }}px</span>
        <div
          ref="sliderTrackRef"
          class="velo-slider-track relative h-8 w-48 touch-none select-none"
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
    </SettingsItem>

    <!-- 代码块主题:浅色 + 深色,各一个下拉(带过滤)。切换走
      lazy load(~100-300ms),由 App.vue watch store 触发 ensureTheme +
      dispatch rebuild。独立于 darkMode toggle(后者是纯 CSS 切色)。 -->
    <SettingsItem label="代码块主题(浅色)" :keywords="['code', 'theme', 'light', 'shiki']">
      <VeloSelect
        v-model="store.codeLightTheme"
        :options="lightThemeOptions"
        width-class="w-48"
        aria-label="代码块浅色主题"
      />
    </SettingsItem>
    <SettingsItem label="代码块主题(深色)" :keywords="['code', 'theme', 'dark', 'shiki']">
      <VeloSelect
        v-model="store.codeDarkTheme"
        :options="darkThemeOptions"
        width-class="w-48"
        aria-label="代码块深色主题"
      />
    </SettingsItem>


    <SettingsItem label="代码块行号" :keywords="['line-number', '行号']" clickable>
      <input
        v-model="store.showCodeLineNumbers"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>
    <SettingsItem label="面包屑" :keywords="['breadcrumb', '面包屑']" clickable>
      <input
        v-model="store.showBreadcrumbs"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>

  </section>
</template>

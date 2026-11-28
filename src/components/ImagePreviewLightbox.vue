<script setup lang="ts">
// 图片预览 lightbox —— 文件树点击图片 / 资产面板右键「预览」共用。
// 状态走 useImagePreviewStore(App.vue 单例挂载,Teleport to body)。
//
// 交互:
//  - 双击图片切换 适应↔100%(小图已在 100% 时 ↔200%)
//  - 滚轮缩放(锚定光标)/ 拖拽平移(任意比例,图片光标 grab)
//  - ← → 循环切换同组图片,Esc 关闭,+ - 0 1 键盘缩放
//  - 点暗背景关闭(点图片永远不关闭)
//
// 视觉:暗房式固定深色(不随主题翻面 —— 看图需要中性暗背景),
// 透明图铺棋盘格,浮层工具条沿用 surface 族的发丝边框 + 圆角语言。

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronLeft, ChevronRight, ImageOff, Loader2, Minus, Plus, Scan, X } from '@lucide/vue'
import { stat, tauriOnly } from '@/tauri/fs'
import { useImagePreviewStore } from '@/stores/imagePreview'
import { useConfirmStore } from '@/stores/confirm'

const preview = useImagePreviewStore()

const current = computed(() => preview.images[preview.index] ?? null)
const hasMany = computed(() => preview.images.length > 1)

// ========== 视口 / 缩放 / 平移 ==========

const vw = ref(window.innerWidth)
const vh = ref(window.innerHeight)

const natW = ref(0)
const natH = ref(0)
const loaded = ref(false)
const loadError = ref(false)
const fileSize = ref<number | null>(null)

const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const isFit = ref(true)

const MIN_SCALE = 0.02
const MAX_SCALE = 32
// 顶部栏 / 底部工具条 / 两侧箭头留白
const PAD_X = 72
const PAD_TOP = 64
const PAD_BOTTOM = 96

const fitScale = computed(() => {
  if (!natW.value || !natH.value) return 1
  return Math.min((vw.value - PAD_X * 2) / natW.value, (vh.value - PAD_TOP - PAD_BOTTOM) / natH.value, 1)
})

const percentLabel = computed(() => `${Math.round(scale.value * 100)}%`)

const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}))

function applyFit() {
  scale.value = fitScale.value
  tx.value = 0
  ty.value = 0
  isFit.value = true
}

/** 以视口内 (cx, cy) 为锚点缩放到 target:锚点下的像素保持不动。 */
function zoomTo(target: number, cx: number, cy: number) {
  const old = scale.value
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, target))
  if (next === old) return
  const px = cx - vw.value / 2
  const py = cy - vh.value / 2
  tx.value = px - (px - tx.value) * (next / old)
  ty.value = py - (py - ty.value) * (next / old)
  scale.value = next
  isFit.value = false
}

function zoomBy(factor: number) {
  zoomTo(scale.value * factor, vw.value / 2, vh.value / 2)
}

function onWheel(e: WheelEvent) {
  if (!loaded.value) return
  zoomTo(scale.value * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY)
}

/** 双击图片:非适应比例 → 回适应;适应且 <100% → 100%;小图已在 100% → 200%。
 *  按实际比例而非 isFit 标记判定,保证双击总有可见变化。 */
function toggleZoom() {
  if (!loaded.value) return
  if (Math.abs(scale.value - fitScale.value) > 0.001) {
    applyFit()
    return
  }
  if (scale.value < 0.999) zoomTo(1, vw.value / 2, vh.value / 2)
  else zoomTo(2, vw.value / 2, vh.value / 2)
}

// ========== 拖拽平移 + 单击缩放 / 点背景关闭 ==========

const stageRef = ref<HTMLDivElement | null>(null)
const dragging = ref(false)
let dragMoved = 0
let downOnImg = false
let lastX = 0
let lastY = 0
let lastClickAt = 0
let lastClickX = 0
let lastClickY = 0

// 图片 = 拖拽把手,恒 grab;背景点击 = 关闭,保持 default 不误导
const imgCursor = computed(() => {
  if (!loaded.value) return 'cursor-default'
  return dragging.value ? 'cursor-grabbing' : 'cursor-grab'
})

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  downOnImg = e.target instanceof HTMLImageElement
  dragMoved = 0
  if (!loaded.value) return
  dragging.value = true
  lastX = e.clientX
  lastY = e.clientY
  stageRef.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const dx = e.clientX - lastX
  const dy = e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  dragMoved += Math.abs(dx) + Math.abs(dy)
  tx.value += dx
  ty.value += dy
}

function onPointerUp(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  if (stageRef.value?.hasPointerCapture(e.pointerId)) {
    stageRef.value.releasePointerCapture(e.pointerId)
  }
}

/** 点暗背景 = 关闭;图片上单击不做事,双击(400ms 内同位置两击)切换缩放。
 *  不用原生 dblclick:舞台捕获指针后 click/dblclick 的 target 被重定向到舞台,
 *  原生双击在 capture 下不可靠;手动按 downOnImg + 时间/距离判定。
 *  拖拽松手不算点击,且打断双击链。 */
function onStageClick(e: MouseEvent) {
  if (dragMoved > 5) {
    lastClickAt = 0
    return
  }
  if (!downOnImg && !(e.target instanceof HTMLImageElement)) {
    lastClickAt = 0
    preview.close()
    return
  }
  const now = Date.now()
  if (now - lastClickAt < 400 && Math.abs(e.clientX - lastClickX) <= 10 && Math.abs(e.clientY - lastClickY) <= 10) {
    lastClickAt = 0
    toggleZoom()
  }
  else {
    lastClickAt = now
    lastClickX = e.clientX
    lastClickY = e.clientY
  }
}

// ========== 图片加载 / 元信息 ==========

let statToken = 0

function onImgLoad(e: Event) {
  const img = e.target as HTMLImageElement
  natW.value = img.naturalWidth
  natH.value = img.naturalHeight
  loaded.value = true
  loadError.value = false
  applyFit()
}

function onImgError() {
  loaded.value = false
  loadError.value = true
}

async function fetchSize(absPath: string | null) {
  const token = ++statToken
  fileSize.value = null
  if (!absPath || !tauriOnly()) return
  try {
    const info = await stat(absPath)
    if (token === statToken) fileSize.value = info.size
  }
  catch { /* 元信息拿不到就不显示 */ }
}

const sizeLabel = computed(() => {
  const n = fileSize.value
  if (n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
})

const metaLabel = computed(() => {
  const parts: string[] = []
  if (loaded.value && natW.value) parts.push(`${natW.value} × ${natH.value}`)
  if (sizeLabel.value) parts.push(sizeLabel.value)
  if (hasMany.value) parts.push(`${preview.index + 1} / ${preview.images.length}`)
  return parts.join(' · ')
})

// 切图:重置变换 + 元信息,预载相邻图让 ←→ 无白屏
watch(current, (img, old) => {
  if (img?.url === old?.url) return
  loaded.value = false
  loadError.value = false
  natW.value = 0
  natH.value = 0
  scale.value = 1
  tx.value = 0
  ty.value = 0
  isFit.value = true
  lastClickAt = 0
  void fetchSize(img?.absPath ?? null)
  if (!preview.isOpen || !img) return
  const n = preview.images.length
  if (n > 1) {
    for (const d of [-1, 1]) {
      const neighbor = preview.images[(preview.index + d + n) % n]
      if (neighbor && neighbor.url !== img.url) {
        const pre = new Image()
        pre.src = neighbor.url
      }
    }
  }
}, { immediate: true })

watch(() => preview.isOpen, (open) => {
  if (open && current.value) void fetchSize(current.value.absPath)
})

function onResize() {
  vw.value = window.innerWidth
  vh.value = window.innerHeight
  if (isFit.value) applyFit()
}

// ========== 键盘 ==========

function onKeydown(e: KeyboardEvent) {
  if (!preview.isOpen) return
  // 确认弹窗浮在 lightbox 之上时,Esc 交给弹窗结算
  if (useConfirmStore().current) return
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      preview.close()
      break
    case 'ArrowLeft':
      e.preventDefault()
      e.stopPropagation()
      preview.step(-1)
      break
    case 'ArrowRight':
      e.preventDefault()
      e.stopPropagation()
      preview.step(1)
      break
    case '+':
    case '=':
      e.preventDefault()
      zoomBy(1.25)
      break
    case '-':
      e.preventDefault()
      zoomBy(0.8)
      break
    case '0':
      e.preventDefault()
      applyFit()
      break
    case '1':
      e.preventDefault()
      zoomTo(1, vw.value / 2, vh.value / 2)
      break
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="lp">
      <div
        v-if="preview.isOpen && current"
        class="fixed inset-0 z-[1200] select-none bg-[#0b0d12]/95"
        role="dialog"
        aria-modal="true"
        :aria-label="current.name"
      >
        <!-- 舞台:滚轮缩放 / 拖拽平移 / 双击图片缩放 / 点背景关闭 -->
        <div
          ref="stageRef"
          class="absolute inset-0 flex items-center justify-center overflow-hidden"
          :class="dragging ? 'cursor-grabbing' : 'cursor-default'"
          style="touch-action: none"
          @wheel.prevent="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @click="onStageClick"
        >
          <img
            v-if="!loadError"
            :key="current.url"
            :src="current.url"
            :alt="current.name"
            draggable="false"
            class="lp-img max-w-none"
            :class="[{ 'lp-img--ready': loaded }, imgCursor]"
            :style="imgStyle"
            @load="onImgLoad"
            @error="onImgError"
          >
          <Loader2
            v-if="!loaded && !loadError"
            :size="28"
            class="pointer-events-none absolute animate-spin text-white/40"
          />
          <!-- 加载失败 -->
          <div v-if="loadError" class="pointer-events-none flex flex-col items-center gap-3 px-8 text-center">
            <ImageOff :size="40" :stroke-width="1.2" class="text-white/30" />
            <span class="text-sm text-gray-300">无法加载图片</span>
            <span class="max-w-[60vw] break-all font-mono text-[11px] text-gray-500">{{ current.absPath ?? current.url }}</span>
            <span class="text-[11px] text-gray-600">文件可能已被移动、删除,或网络不可达</span>
          </div>
        </div>

        <!-- 顶栏:名称 + 元信息 / 动作 -->
        <!-- top-9.5 避让顶栏高度:右上角关闭按钮不与窗口控制按钮 / macOS 交通灯重叠。 -->
        <div class="pointer-events-none absolute inset-x-0 top-9.5 flex h-14 items-center justify-between gap-4 bg-gradient-to-b from-black/50 to-transparent px-4">
          <div class="pointer-events-auto flex min-w-0 flex-col">
            <span class="truncate text-sm font-medium text-gray-100" :title="current.absPath ?? current.url">{{ current.name }}</span>
            <span v-if="metaLabel" class="text-[11px] tabular-nums text-gray-400">{{ metaLabel }}</span>
          </div>
          <div class="pointer-events-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="lp-btn"
              title="关闭 (Esc)"
              data-testid="lp-close"
              @click="preview.close()"
            >
              <X :size="17" />
            </button>
          </div>
        </div>

        <!-- 左右切换 -->
        <template v-if="hasMany">
          <button
            type="button"
            class="lp-nav left-3"
            title="上一张 (←)"
            data-testid="lp-prev"
            @click="preview.step(-1)"
          >
            <ChevronLeft :size="20" />
          </button>
          <button
            type="button"
            class="lp-nav right-3"
            title="下一张 (→)"
            data-testid="lp-next"
            @click="preview.step(1)"
          >
            <ChevronRight :size="20" />
          </button>
        </template>

        <!-- 底部缩放工具条 -->
        <div class="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-white/10 bg-[#1e222a]/90 px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] backdrop-blur-sm">
          <button type="button" class="lp-btn" title="缩小 (-)" data-testid="lp-zoom-out" @click="zoomBy(0.8)">
            <Minus :size="15" />
          </button>
          <button
            type="button"
            class="lp-btn min-w-14 px-1 text-xs tabular-nums"
            title="点击恢复适应窗口 (0)"
            data-testid="lp-percent"
            @click="applyFit"
          >
            {{ percentLabel }}
          </button>
          <button type="button" class="lp-btn" title="放大 (+)" data-testid="lp-zoom-in" @click="zoomBy(1.25)">
            <Plus :size="15" />
          </button>
          <div class="mx-1 h-4 w-px bg-white/15" />
          <button
            type="button"
            class="lp-btn gap-1 px-2 text-xs"
            :class="{ 'lp-btn--active': isFit }"
            title="适应窗口 (0)"
            data-testid="lp-fit"
            @click="applyFit"
          >
            <Scan :size="14" />
            适应
          </button>
          <button
            type="button"
            class="lp-btn px-2 text-xs tabular-nums"
            :class="{ 'lp-btn--active': !isFit && Math.abs(scale - 1) < 0.001 }"
            title="实际大小 (1)"
            data-testid="lp-actual"
            @click="zoomTo(1, vw / 2, vh / 2)"
          >
            1:1
          </button>
        </div>

        <!-- 快捷键提示 -->
        <div class="pointer-events-none absolute bottom-6 left-4 hidden text-[11px] text-white/30 md:block">
          双击缩放 · 拖拽平移 · 滚轮缩放 · ← → 切换 · Esc 关闭
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.lp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  min-width: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--color-gray-300);
  transition: background-color 120ms ease, color 120ms ease;
}
.lp-btn:hover {
  background: color-mix(in srgb, var(--color-white) 10%, transparent);
  color: var(--color-white);
}
.lp-btn--active {
  background: color-mix(in srgb, var(--color-white) 14%, transparent);
  color: var(--color-white);
}

.lp-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  border: 1px solid color-mix(in srgb, var(--color-white) 10%, transparent);
  background: color-mix(in srgb, var(--color-white) 5%, transparent);
  color: var(--color-gray-200);
  transition: background-color 120ms ease;
}
.lp-nav:hover {
  background: color-mix(in srgb, var(--color-white) 15%, transparent);
}

/* 透明图棋盘格(随图片一起缩放,与主流看图器一致) */
.lp-img {
  opacity: 0;
  transition: opacity 180ms ease;
  background-color: #22262d;
  background-image:
    linear-gradient(45deg, #2a2f38 25%, transparent 25%, transparent 75%, #2a2f38 75%),
    linear-gradient(45deg, #2a2f38 25%, transparent 25%, transparent 75%, #2a2f38 75%);
  background-size: 16px 16px;
  background-position: 0 0, 8px 8px;
  box-shadow: 0 8px 40px color-mix(in srgb, var(--color-black) 55%, transparent);
  will-change: transform;
}
.lp-img--ready {
  opacity: 1;
}

.lp-enter-active,
.lp-leave-active {
  transition: opacity 160ms ease;
}
.lp-enter-from,
.lp-leave-to {
  opacity: 0;
}
</style>
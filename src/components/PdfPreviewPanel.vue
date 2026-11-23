<script setup lang="ts">
// PDF 分页预览面板 —— 导出面板选「PDF 预览」后打开。
//
// 与最终 PDF 共用同一份 Display List：这里绝对定位成 DOM，导出时序列化成
// PDF 内容流。改页边距 / 字号 / 行距 / 页脚只走同步 relayout，正文不变
// 不重新渲染 KaTeX / mermaid / shiki / 图片。全部在前端完成，不依赖 WebView2。

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type ComponentPublicInstance } from 'vue'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { useExportStore } from '@/stores/export'
import { useNotifyStore } from '@/stores/notify'
import { save as saveDialog } from '@/tauri/dialog'
import { writeFile } from '@/tauri/fs'
import { formatError } from '@/utils/formatError'
import VeloSelect from '@/components/settings/VeloSelect.vue'
// 纸张表是纯常量，直接从 types 子模块取 —— 避免把整个 PDF 引擎拉进主包
// （引擎仍走下面的动态 import）。
import { PDF_PAPER_SIZES } from '@/lib/export/pdfPreview/types'
import type { PdfPaperSize } from '@/lib/export/pdfPreview/types'
import type { PdfBuild, PdfDocument, PdfLayoutOptions } from '@/lib/export/pdfPreview'

type Engine = typeof import('@/lib/export/pdfPreview')

const exportStore = useExportStore()
const documentStore = useDocumentStore()
const editorStore = useEditorStore()
const notify = useNotifyStore()

const open = () => exportStore.previewOpen
const engine = ref<Engine | null>(null)
const build = ref<PdfBuild | null>(null)
const doc = ref<PdfDocument | null>(null)
const pagesRef = ref<HTMLElement | null>(null)
const loading = ref(false)
const exporting = ref(false)
const errorText = ref('')
const buildMs = ref(0)
const layoutMs = ref(0)
const renderMs = ref(0)
/** 构建 / 重排 / 绘制耗时仅 dev 环境展示 */
const isDev = import.meta.env.DEV

const opts = reactive<PdfLayoutOptions>({
  margins: { horizontal: 16, vertical: 18 },
  paperSize: 'a4',
  fontSize: 12,
  lineHeight: 1.75,
  showHeader: false,
  showFooter: true,
  headerText: '',
  dark: false,
  // 与 webview 导出同源：脚注引用 / 回链用编辑器主色。
  primaryColor: editorStore.primaryColor,
})

/** 纸张下拉选项直接来自 PDF_PAPER_SIZES —— 新增纸张不必改这里。 */
const paperOptions = Object.entries(PDF_PAPER_SIZES).map(([value, spec]) => ({
  value,
  label: spec.label,
}))
/** VeloSelect 的 modelValue 是 string，进出时转成 PdfPaperSize 字面量。 */
const paperSize = computed({
  get: () => opts.paperSize ?? 'a4',
  set: (v: string) => { opts.paperSize = v as PdfPaperSize },
})

/** 预览固定 1 倍（无缩放控件；画布容器宽度足够 A4 展示）。 */
const PREVIEW_SCALE = 1

const pageCount = () => doc.value?.pages.length ?? 0
const warnCount = () => (doc.value?.warnings.length ?? 0) + (doc.value?.missingGlyphs.length ?? 0)

function source() {
  return {
    content: documentStore.content,
    currentFilePath: documentStore.currentFilePath,
    lightTheme: editorStore.codeLightTheme,
    darkTheme: editorStore.codeDarkTheme,
  }
}

// ---- 拖拽条（样式严格对齐设置里的 velo-slider：直线 + 可拖圆，pointer 捕获）----
// 与 EditorGroup 的字号 / 缩放滑块同一套实现与类名，保证视觉与交互一致。
const MARGIN_MIN = 5
const MARGIN_MAX = 60

function useSlider(read: () => number, write: (v: number) => void, min: number, max: number, step: number) {
  const track = ref<HTMLElement | null>(null)
  const pointerId = ref<number | null>(null)
  const draggingRatio = ref<number | null>(null)

  const active = computed(() => {
    if (draggingRatio.value !== null) {
      const raw = min + draggingRatio.value * (max - min)
      return Number((Math.round(raw / step) * step).toFixed(3))
    }
    return read()
  })
  const ratio = computed(() => (active.value - min) / (max - min))

  function ratioFromClientX(clientX: number): number {
    const el = track.value
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }
  function commit(r: number) {
    const raw = min + r * (max - min)
    write(Number((Math.round(raw / step) * step).toFixed(3)))
  }
  function onDown(e: PointerEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    track.value?.setPointerCapture(e.pointerId)
    pointerId.value = e.pointerId
    draggingRatio.value = ratioFromClientX(e.clientX)
  }
  function onMove(e: PointerEvent) {
    if (pointerId.value !== e.pointerId) return
    e.preventDefault()
    draggingRatio.value = ratioFromClientX(e.clientX)
  }
  function onUp(e: PointerEvent) {
    if (pointerId.value !== e.pointerId) return
    if (draggingRatio.value !== null) commit(draggingRatio.value)
    draggingRatio.value = null
    pointerId.value = null
    track.value?.releasePointerCapture(e.pointerId)
  }
  // 函数 ref：把 DOM 元素写回内部 track（模板里用 :ref 绑定）
  const attach = (el: Element | ComponentPublicInstance | null) => {
    track.value = el && '$el' in el ? (el.$el as HTMLElement | null) : (el as HTMLElement | null)
  }
  return { track, attach, draggingRatio, active, ratio, onDown, onMove, onUp }
}

// reactive 包裹 → 模板里 marginH.active / marginH.ratio 直接是数值（自动解包）。
const marginH = reactive(useSlider(() => opts.margins.horizontal, v => { opts.margins.horizontal = v }, MARGIN_MIN, MARGIN_MAX, 1))
const marginV = reactive(useSlider(() => opts.margins.vertical, v => { opts.margins.vertical = v }, MARGIN_MIN, MARGIN_MAX, 1))
const fontSize = reactive(useSlider(() => opts.fontSize, v => { opts.fontSize = v }, 8, 20, 0.5))
const lineHeight = reactive(useSlider(() => opts.lineHeight, v => { opts.lineHeight = v }, 1.2, 2.4, 0.05))

let raf = 0
function scheduleDraw() {
  if (raf) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => { raf = 0; void draw() })
}

async function draw() {
  const mod = engine.value
  const d = doc.value
  if (!mod || !d || !pagesRef.value) return
  await nextTick()
  renderMs.value = mod.renderAllPages(pagesRef.value, d, PREVIEW_SCALE)
}

async function rebuild() {
  const mod = engine.value
  if (!mod || !open()) return
  loading.value = true
  errorText.value = ''
  try {
    const b = await mod.buildPdf(source(), opts)
    build.value = b
    doc.value = b.doc
    buildMs.value = b.buildMs
    layoutMs.value = b.layoutMs
    await draw()
  } catch (e) {
    errorText.value = formatError(e)
    console.error('PDF 预览构建失败', e)
  } finally {
    loading.value = false
  }
}

async function ensureEngine() {
  if (!engine.value) engine.value = await import('@/lib/export/pdfPreview')
  return engine.value
}

let contentTimer: ReturnType<typeof setTimeout> | null = null
watch(() => documentStore.content, () => {
  if (!open() || !engine.value) return
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = setTimeout(() => { void rebuild() }, 180)
})

watch(opts, () => {
  const b = build.value
  if (!b || !open()) return
  layoutMs.value = performance.now()
  doc.value = b.relayout({ ...opts, margins: { ...opts.margins } })
  layoutMs.value = performance.now() - layoutMs.value
  scheduleDraw()
}, { deep: true })

// 编辑器换主题色 → 同步重排（脚注引用 / 回链跟随主色）。
watch(() => editorStore.primaryColor, () => {
  if (!open()) return
  opts.primaryColor = editorStore.primaryColor
})

watch(() => exportStore.previewOpen, async (v) => {
  if (!v) return
  await ensureEngine()
  await rebuild()
})

function onKeydown(e: KeyboardEvent) {
  if (!open() || e.key !== 'Escape') return
  e.preventDefault(); e.stopPropagation()
  exportStore.closePdfPreview()
}

onMounted(() => document.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true)
  if (contentTimer) clearTimeout(contentTimer)
  if (raf) cancelAnimationFrame(raf)
})

function resetOpts() {
  opts.margins = { horizontal: 16, vertical: 18 }
  opts.paperSize = 'a4'
  opts.fontSize = 12
  opts.lineHeight = 1.75
  opts.showFooter = true
}

async function doExport() {
  const mod = engine.value
  const d = doc.value
  if (!mod || !d || exporting.value) return
  const raw = exportStore.previewFileName || documentStore.fileName || 'untitled'
  const base = raw.replace(/\.[^.]+$/, '')
  const target = await saveDialog({
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    defaultPath: `${base}.pdf`,
  })
  if (!target) return
  exporting.value = true
  try {
    const bytes = await mod.serializePdf(d)
    await writeFile(target, bytes)
    notify.success(`已导出:${target}`)
  } catch (e) {
    console.error('PDF 预览导出失败', e)
    notify.error(`导出失败:${formatError(e)}`)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="velo-pdf-preview">
      <div
        v-if="open()"
        class="fixed inset-0 z-[1400] flex items-center justify-center bg-black/30 dark:bg-black/60"
        @click.self="exportStore.closePdfPreview()"
      >
        <div
          class="flex h-[94vh] w-[min(1440px,96vw)] flex-col overflow-hidden rounded-2xl border border-[var(--surface-border)] bg-[var(--surface-3)] shadow-[var(--shadow-popover)]"
          role="dialog"
          aria-modal="true"
          aria-label="PDF 分页预览"
        >
          <!-- 顶栏 -->
          <div class="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--surface-border)] px-5">
            <span class="text-base font-semibold text-[var(--chrome-text-active)]">PDF 预览</span>
            <span class="rounded-md bg-[var(--surface-hover)] px-2 py-0.5 text-xs text-[var(--chrome-text-secondary)]">
              {{ pageCount() }} 页
            </span>
            <span v-if="isDev" class="text-xs text-[var(--chrome-text-secondary)]">
              构建 {{ buildMs.toFixed(0) }}ms · 重排 {{ layoutMs.toFixed(1) }}ms · 绘制 {{ renderMs.toFixed(1) }}ms
            </span>
            <span v-if="warnCount()" class="text-xs text-amber-600 dark:text-amber-400">{{ warnCount() }} 项降级</span>
            <span v-if="loading" class="text-xs text-[var(--chrome-accent-blue)]">重排中…</span>
            <div class="ml-auto flex items-center gap-3">
              <button
                type="button"
                class="rounded-lg border border-[var(--surface-border)] px-3 py-1.5 text-sm text-[var(--chrome-text-primary)] hover:bg-[var(--surface-hover)]"
                @click="exportStore.closePdfPreview()"
              >关闭</button>
              <button
                type="button"
                :disabled="exporting || !doc"
                class="rounded-lg bg-[var(--chrome-accent-blue)] px-4 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                @click="void doExport()"
              >{{ exporting ? '导出中…' : '导出 PDF' }}</button>
            </div>
          </div>

          <div class="flex min-h-0 flex-1">
            <!-- 参数侧栏 -->
            <aside class="w-[268px] shrink-0 overflow-y-auto border-r border-[var(--surface-border)] px-4 py-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-xs font-semibold text-[var(--chrome-text-primary)]">页面参数</span>
                <button type="button" class="text-xs text-[var(--chrome-accent-blue)] hover:underline" @click="resetOpts">重置</button>
              </div>

              <div class="mb-6">
                <div class="mb-1.5 text-[11px] text-[var(--chrome-text-secondary)]">纸张大小</div>
                <VeloSelect
                  v-model="paperSize"
                  :options="paperOptions"
                  width-class="w-full"
                  aria-label="纸张大小"
                  :panel-z-index="1500"
                />
              </div>

              <div class="mb-6">
                <div class="mb-1.5 text-[11px] text-[var(--chrome-text-secondary)]">页边距（mm）</div>
                <!-- 水平（左右） -->
                <div class="flex items-center gap-2">
                  <span class="w-12 shrink-0 text-[11px] text-[var(--chrome-text-secondary)]">水平</span>
                  <span class="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--chrome-text-primary)]">{{ marginH.active }}</span>
                  <div
                    :ref="marginH.attach"
                    class="velo-slider-track relative h-6 min-w-0 flex-1 touch-none select-none"
                    :class="{ 'is-dragging': marginH.draggingRatio !== null }"
                    role="slider"
                    aria-label="水平页边距"
                    :aria-valuenow="marginH.active"
                    :aria-valuemin="MARGIN_MIN"
                    :aria-valuemax="MARGIN_MAX"
                    :aria-valuetext="`水平页边距 ${marginH.active} mm`"
                    tabindex="0"
                    @pointerdown="marginH.onDown"
                    @pointermove="marginH.onMove"
                    @pointerup="marginH.onUp"
                    @pointercancel="marginH.onUp"
                  >
                    <span class="velo-slider-line absolute inset-x-0 top-1/2 block h-0.5 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <span
                      class="velo-slider-knob absolute top-1/2 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
                      :style="{ left: `${marginH.ratio * 100}%` }"
                    />
                  </div>
                </div>
                <!-- 垂直（上下） -->
                <div class="mt-4 flex items-center gap-2">
                  <span class="w-12 shrink-0 text-[11px] text-[var(--chrome-text-secondary)]">垂直</span>
                  <span class="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--chrome-text-primary)]">{{ marginV.active }}</span>
                  <div
                    :ref="marginV.attach"
                    class="velo-slider-track relative h-6 min-w-0 flex-1 touch-none select-none"
                    :class="{ 'is-dragging': marginV.draggingRatio !== null }"
                    role="slider"
                    aria-label="垂直页边距"
                    :aria-valuenow="marginV.active"
                    :aria-valuemin="MARGIN_MIN"
                    :aria-valuemax="MARGIN_MAX"
                    :aria-valuetext="`垂直页边距 ${marginV.active} mm`"
                    tabindex="0"
                    @pointerdown="marginV.onDown"
                    @pointermove="marginV.onMove"
                    @pointerup="marginV.onUp"
                    @pointercancel="marginV.onUp"
                  >
                    <span class="velo-slider-line absolute inset-x-0 top-1/2 block h-0.5 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <span
                      class="velo-slider-knob absolute top-1/2 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
                      :style="{ left: `${marginV.ratio * 100}%` }"
                    />
                  </div>
                </div>
              </div>

              <div class="mb-6 space-y-4">
                <div class="flex items-center gap-2">
                  <span class="w-12 shrink-0 text-[11px] text-[var(--chrome-text-secondary)]">字号</span>
                  <span class="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--chrome-text-primary)]">{{ fontSize.active }}pt</span>
                  <div
                    :ref="fontSize.attach"
                    class="velo-slider-track relative h-6 min-w-0 flex-1 touch-none select-none"
                    :class="{ 'is-dragging': fontSize.draggingRatio !== null }"
                    role="slider"
                    aria-label="正文字号"
                    :aria-valuenow="fontSize.active"
                    :aria-valuemin="8"
                    :aria-valuemax="20"
                    :aria-valuetext="`字号 ${fontSize.active}pt`"
                    tabindex="0"
                    @pointerdown="fontSize.onDown"
                    @pointermove="fontSize.onMove"
                    @pointerup="fontSize.onUp"
                    @pointercancel="fontSize.onUp"
                  >
                    <span class="velo-slider-line absolute inset-x-0 top-1/2 block h-0.5 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <span
                      class="velo-slider-knob absolute top-1/2 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
                      :style="{ left: `${fontSize.ratio * 100}%` }"
                    />
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <span class="w-12 shrink-0 text-[11px] text-[var(--chrome-text-secondary)]">行距</span>
                  <span class="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--chrome-text-primary)]">{{ lineHeight.active.toFixed(2) }}</span>
                  <div
                    :ref="lineHeight.attach"
                    class="velo-slider-track relative h-6 min-w-0 flex-1 touch-none select-none"
                    :class="{ 'is-dragging': lineHeight.draggingRatio !== null }"
                    role="slider"
                    aria-label="行距"
                    :aria-valuenow="lineHeight.active"
                    :aria-valuemin="1.2"
                    :aria-valuemax="2.4"
                    :aria-valuetext="`行距 ${lineHeight.active.toFixed(2)}`"
                    tabindex="0"
                    @pointerdown="lineHeight.onDown"
                    @pointermove="lineHeight.onMove"
                    @pointerup="lineHeight.onUp"
                    @pointercancel="lineHeight.onUp"
                  >
                    <span class="velo-slider-line absolute inset-x-0 top-1/2 block h-0.5 -translate-y-1/2 rounded-full bg-gray-200 dark:bg-gray-700" />
                    <span
                      class="velo-slider-knob absolute top-1/2 block h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
                      :style="{ left: `${lineHeight.ratio * 100}%` }"
                    />
                  </div>
                </div>
              </div>

              <div class="space-y-2 border-t border-[var(--surface-border)] pt-3">
                <label class="flex items-center gap-2 text-xs text-[var(--chrome-text-primary)]">
                  <input v-model="opts.showFooter" type="checkbox" class="accent-[var(--chrome-accent-blue)]"> 显示页码
                </label>
              </div>

              <div v-if="errorText" class="mt-4 rounded-md bg-red-500/10 p-2 text-[11px] text-red-600 dark:text-red-400">{{ errorText }}</div>
              <div v-if="doc?.warnings?.length" class="mt-4 space-y-1">
                <div class="text-[11px] font-semibold text-[var(--chrome-text-secondary)]">降级 / 警告</div>
                <div v-for="(w, i) in doc.warnings.slice(0, 8)" :key="i" class="text-[11px] text-amber-600 dark:text-amber-400">· {{ w }}</div>
              </div>
              <div v-if="doc?.missingGlyphs?.length" class="mt-3">
                <div class="text-[11px] font-semibold text-[var(--chrome-text-secondary)]">字库缺字</div>
                <div class="mt-1 break-all text-[11px] text-amber-600 dark:text-amber-400">{{ doc.missingGlyphs.slice(0, 40).join(' ') }}</div>
              </div>
            </aside>

            <!-- 分页画布 -->
            <main class="min-w-0 flex-1 overflow-auto bg-[var(--surface-2)] p-6">
              <div ref="pagesRef" class="mx-auto flex w-max flex-col items-center gap-6" />
            </main>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.velo-pdf-preview-enter-active,
.velo-pdf-preview-leave-active { transition: opacity 0.16s ease; }
.velo-pdf-preview-enter-from,
.velo-pdf-preview-leave-to { opacity: 0; }
:deep(.velo-pdf-page) {
  box-shadow: var(--shadow-popover);
  flex: none;
}
</style>

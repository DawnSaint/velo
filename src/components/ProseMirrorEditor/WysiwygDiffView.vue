<script setup lang="ts">
// WysiwygDiffView(#diff-wysiwyg):WYSIWYG diff 视图。
//
// 在 ProseMirror 只读渲染上叠加 Decoration 标记增删:
// - 标记走线条语义(新增绿色下划线 / 整框,删除删除线 + 灰字,格式 / 类型琥珀点线),
//   见 _editor-diff.scss;整框与字符级新增的贯通下划线都由 plugins/diffGroupFrames.ts
//   的同一层 overlay 画(后者见 plugins/diffInlineUnderlines.ts),CSS 只留降级
//
// 与源码 diff(DiffView.vue 的行级列表)共用同一 diff 算法结果(Myers),
// 切换模式不重算 diff。
//
// 只读 PM 渲染:复用项目 schema + fromMarkdown,装最小化插件集
// (仅视觉渲染需要的 NodeView / Decoration,不含编辑类插件)。
//
// 增量渲染(#diff-incremental):
// - 选中版本条目变化时**不销毁重建 EditorView**
//   - newContent 变 → 换成新 doc 的新 state(view.updateState),复用同一批插件实例
//   - oldContent 变 → 只 dispatch setMeta(diffDecorationKey,{ oldDoc }),
//     decoration 由插件增量重建
// - 挂载 viewportPlugin 让 diffDecoration 视口感知:长文档只为可见 block 构建装饰,
//   滚动时按需追加(player-common sticky 范式)

import { onMounted, onBeforeUnmount, ref, watch, shallowRef } from 'vue'
import { EditorState, Plugin, PluginKey } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap } from 'prosemirror-commands'
import { useDocumentStore } from '@/stores/document'
import { resolveImageSrc } from '@/utils/imageSrc'
import { schema as veloSchema, type VeloSchema } from './editor/schema'
import { fromMarkdown } from './editor/markdownIO'
import { setDiffOldDoc, diffDecorationPlugin, getDiffAnchors } from './plugins/diffDecoration'
import type { DiffAnchor } from '@/utils/diffAnchors'
import { createDiffGroupFrames, type DiffGroupFrames } from './plugins/diffGroupFrames'
import { viewportPlugin, setInitialViewportHint, refreshViewport } from './nodes/viewportPlugin'
import { createImageNodeView } from './editor/imageNodeView'
import { createHrNodeView } from './nodes/HrNodeView'
import { createEmojiNodeView } from './nodes/EmojiNodeView'
import { frontmatterNodeViewPlugin } from './nodes/FrontmatterNodeView'
import { createHtmlNodeViewPlugin } from './nodes/HtmlNodeView'
import { mathEditPlugin } from './nodes/MathNodeViews'
import { mermaidDecoration } from './nodes/MermaidDecoration'
import { taskListPlugin } from './nodes/TaskListNodeView'
import { footnoteEditPlugin } from './nodes/FootnoteNodeViews'
import { tocDecoration } from './nodes/TocDecoration'
import { codeHighlightPlugin } from './nodes/CodeHighlightWidget'
import { codeWrapPlugin } from './nodes/CodeWrapPlugin'
import { codeLineNumberPlugin } from './nodes/CodeLineNumberWidget'
import { findHighlight } from './findreplace/findHighlight'
import type { Node as PMNode } from 'prosemirror-model'

const props = defineProps<{
  /** 新版本 markdown(当前选中条目的 content) */
  newContent: string
  /** 旧版本 markdown(前一版本的 content) */
  oldContent: string
  /** 是否隐藏原生滚动条(当外层挂载 DiffOverviewRuler 合一滚动条时开启) */
  hideScrollbar?: boolean
}>()

const emit = defineEmits<{
  'anchors-change': [anchors: DiffAnchor[]]
}>()

const scrollContainerRef = ref<HTMLElement | null>(null)
const containerRef = ref<HTMLElement | null>(null)
const viewRef = shallowRef<EditorView | null>(null)
const error = ref<string | null>(null)
/** 插件实例数组:updateState 换新 doc 时必须复用同一批实例(否则 plugin state 全丢) */
let pluginInstances: Plugin[] | null = null
/** overlay 层:连续新增块的整框 + 字符级新增的贯通下划线,见 plugins/diffGroupFrames.ts */
let frames: DiffGroupFrames | null = null
/** 当前未做 DOM 像素校正的原始锚点(供 ResizeObserver / 滚动挂载 widget 后重测) */
let rawAnchors: DiffAnchor[] = []
let lastEmittedAnchors: DiffAnchor[] = []
let contentRo: ResizeObserver | null = null
let measureRafId: number | null = null

const INNER_DIFF_SELECTOR = [
  '.velo-diff-added',
  '.velo-diff-added-inline',
  '.velo-diff-removed',
  '.velo-diff-deleted-group',
  '.velo-diff-added-cell',
  '.velo-diff-removed-cell',
  '.velo-diff-boundary-hint',
].join(', ')

// 与主编辑器共用同一份 src 解析:必须基于当前文档目录把相对路径转绝对路径,
// 否则 asset:// 指向不存在的位置,预览模式里本地图片会全部裂图。
const imageSrcProxy = (url: string) => resolveImageSrc(url, useDocumentStore().currentFilePath)

const imageNodeView = createImageNodeView({ proxyDomURL: imageSrcProxy })
const htmlNodeViewPlugin = createHtmlNodeViewPlugin({ proxyDomURL: imageSrcProxy })

// 最小化插件集:只保留视觉渲染需要的插件,不含编辑类(keymap/inputrules/history/paste 等)
function buildPlugins(): Plugin[] {
  return [
    // 只读模式仍需 baseKeymap 支持选区导航(方向键 / Cmd+A 等)
    keymap(baseKeymap),
    // ── Viewport(须先于读取 viewport state 的 decoration 插件)──
    viewportPlugin,
    // ── Code Decorations ──
    codeHighlightPlugin,
    codeWrapPlugin,
    codeLineNumberPlugin,
    // ── NodeView ──
    new Plugin({ key: new PluginKey('imageInlineView'), props: { nodeViews: { image: imageNodeView } } }),
    new Plugin({ key: new PluginKey('hrNodeView'), props: { nodeViews: { hr: createHrNodeView() } } }),
    new Plugin({ key: new PluginKey('emojiNodeView'), props: { nodeViews: { emoji: createEmojiNodeView() } } }),
    frontmatterNodeViewPlugin,
    htmlNodeViewPlugin,
    // ── Math & Mermaid ──
    mathEditPlugin,
    mermaidDecoration,
    // ── Misc Decorations ──
    taskListPlugin,
    footnoteEditPlugin,
    tocDecoration,
    findHighlight,
    // ── Diff 装饰(核心) ──
    diffDecorationPlugin,
  ]
}

function parseMarkdown(md: string): PMNode | null {
  try {
    return fromMarkdown(md, veloSchema as VeloSchema)
  } catch {
    return null
  }
}

/** 首屏优化的窄 viewport hint:让 decoration 插件先只为首屏构建,随后 rAF 刷真值 */
const FIRST_SCREEN_HINT = { from: 0, to: 5000 }

function makeState(doc: PMNode): EditorState {
  if (!pluginInstances) pluginInstances = buildPlugins()
  setInitialViewportHint(FIRST_SCREEN_HINT)
  try {
    return EditorState.create({ schema: veloSchema, doc, plugins: pluginInstances })
  } finally {
    setInitialViewportHint(null) // 防止泄漏到后续 state 创建
  }
}

/** 用真实 DOM 像素几何校正锚点比例(解决含大图/Mermaid/表格时 doc pos 与滚动条位置错位) */
function measureAnchorsWithDom(anchors: DiffAnchor[]): DiffAnchor[] {
  const view = viewRef.value
  const scroller = scrollContainerRef.value
  if (!view || !scroller || anchors.length === 0) return anchors

  const scrollHeight = scroller.scrollHeight
  const scrollerRect = scroller.getBoundingClientRect()
  if (scrollHeight <= 0 || scrollerRect.height <= 0) return anchors

  const scrollTop = scroller.scrollTop
  const doc = view.state.doc
  const docSize = doc.content.size
  const topBlocks: Array<{ from: number; to: number }> = []
  doc.forEach((child, offset) => {
    topBlocks.push({ from: offset, to: offset + child.nodeSize })
  })

  const toContentY = (viewportY: number) => scrollTop + (viewportY - scrollerRect.top)

  return anchors.map((anchor) => {
    const from = Math.min(Math.max(anchor.from ?? 0, 0), docSize)
    const to = Math.min(Math.max(anchor.to ?? from, from), docSize)

    let topY: number | null = null
    let bottomY: number | null = null

    if (from === to) {
      // 删除块 widget:若已挂载在 DOM 中取其真实 rect,否则取紧随其后的 block 顶部
      if (from < docSize) {
        const dom = view.nodeDOM(from)
        if (dom instanceof HTMLElement) {
          const prev = dom.previousElementSibling
          if (prev instanceof HTMLElement && prev.classList.contains('velo-diff-deleted-block')) {
            const r = prev.getBoundingClientRect()
            topY = toContentY(r.top)
            bottomY = toContentY(r.bottom)
          }
          else {
            const y = toContentY(dom.getBoundingClientRect().top)
            topY = y
            bottomY = y
          }
        }
      }
      else {
        const last = view.dom.lastElementChild
        if (last instanceof HTMLElement && last.classList.contains('velo-diff-deleted-block')) {
          const r = last.getBoundingClientRect()
          topY = toContentY(r.top)
          bottomY = toContentY(r.bottom)
        }
        else {
          topY = scrollHeight
          bottomY = scrollHeight
        }
      }
    }
    else {
      // 找到覆盖 [from, to) 的首尾顶层块
      let firstBlock: { from: number; to: number } | null = null
      let lastBlock: { from: number; to: number } | null = null
      for (const b of topBlocks) {
        if (b.to > from && b.from < to) {
          if (!firstBlock) firstBlock = b
          lastBlock = b
        }
      }
      if (firstBlock && lastBlock) {
        const firstDom = view.nodeDOM(firstBlock.from)
        const lastDom = view.nodeDOM(lastBlock.from)
        if (firstBlock === lastBlock && firstDom instanceof HTMLElement) {
          // 单个容器块(如长列表 / 表格)内局部改动:若内部 diff 元素已挂载,取它们的并集范围
          const innerEls = firstDom.querySelectorAll<HTMLElement>(INNER_DIFF_SELECTOR)
          if (innerEls.length > 0) {
            let minTop = Infinity
            let maxBottom = -Infinity
            innerEls.forEach((el) => {
              const r = el.getBoundingClientRect()
              if (r.height > 0 || r.width > 0) {
                if (r.top < minTop) minTop = r.top
                if (r.bottom > maxBottom) maxBottom = r.bottom
              }
            })
            if (minTop < Infinity) {
              topY = toContentY(minTop)
              bottomY = toContentY(maxBottom)
            }
          }
        }
        if (topY === null && firstDom instanceof HTMLElement && lastDom instanceof HTMLElement) {
          topY = toContentY(firstDom.getBoundingClientRect().top)
          bottomY = toContentY(lastDom.getBoundingClientRect().bottom)
        }
      }
    }

    if (topY === null || bottomY === null) return anchor

    const startRatio = Math.min(1, Math.max(0, topY / scrollHeight))
    const endRatio = Math.min(1, Math.max(startRatio, bottomY / scrollHeight))
    return { ...anchor, startRatio, endRatio }
  })
}

function anchorsRatiosChanged(a: DiffAnchor[], b: DiffAnchor[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (
      Math.abs(a[i].startRatio - b[i].startRatio) > 0.0005
      || Math.abs(a[i].endRatio - b[i].endRatio) > 0.0005
      || a[i].kind !== b[i].kind
    ) {
      return true
    }
  }
  return false
}

function scheduleMeasureAnchors() {
  if (measureRafId !== null) return
  measureRafId = requestAnimationFrame(() => {
    measureRafId = null
    if (!viewRef.value || rawAnchors.length === 0) return
    const measured = measureAnchorsWithDom(rawAnchors)
    if (anchorsRatiosChanged(measured, lastEmittedAnchors)) {
      lastEmittedAnchors = measured
      emit('anchors-change', measured)
    }
  })
}

/** 注入 diff 基准(oldDoc),由插件增量重建 decoration —— 不重建 view */
function applyOldDoc(view: EditorView) {
  // 第三个参数供「整块删除」widget 用:它走 DOMSerializer,不经过 image NodeView,
  // 需要同一个 src 解析器把 markdown 相对路径转成 asset:// URL。
  setDiffOldDoc(view, parseMarkdown(props.oldContent), imageSrcProxy)
  rawAnchors = getDiffAnchors(view.state)
  const measured = measureAnchorsWithDom(rawAnchors)
  lastEmittedAnchors = measured
  emit('anchors-change', measured)
  scheduleMeasureAnchors()
}

function resolveAnchorTargetTop(view: EditorView, pos: number): number | null {
  try {
    const dom = view.nodeDOM(pos)
    if (dom instanceof HTMLElement) {
      const innerDiff = dom.querySelector<HTMLElement>(INNER_DIFF_SELECTOR)
      if (innerDiff) {
        const r = innerDiff.getBoundingClientRect()
        if (r.height > 0 || r.width > 0) return r.top
      }
      return dom.getBoundingClientRect().top
    }
  }
  catch { /* 落到 coordsAtPos 兜底 */ }

  try {
    return view.coordsAtPos(pos).top
  }
  catch {
    return null
  }
}

/** 滚动到指定变更锚点,并立即刷新视口装饰与整框 overlay */
function scrollToAnchor(anchor: DiffAnchor) {
  const view = viewRef.value
  const scroller = scrollContainerRef.value
  if (!view || !scroller) return

  const docSize = view.state.doc.content.size
  const pos = Math.min(Math.max(anchor.from ?? 0, 0), docSize)

  if (pos >= docSize) {
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    refreshViewport(view)
    frames?.refresh()
    requestAnimationFrame(() => {
      if (view.isDestroyed) return
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
      frames?.refresh()
      scheduleMeasureAnchors()
    })
    return
  }

  const alignOnce = () => {
    const rectTop = resolveAnchorTargetTop(view, pos)
    if (rectTop === null) return
    const scrollerRect = scroller.getBoundingClientRect()
    const targetTop = scroller.scrollTop + (rectTop - scrollerRect.top) - scroller.clientHeight * 0.25
    scroller.scrollTop = Math.max(0, targetTop)
  }

  alignOnce()
  refreshViewport(view)
  frames?.refresh()
  // refreshViewport 可能在目标之前/内部挂载了新的删除 widget 或局部 diff 元素,再校正一次落点
  alignOnce()
  scheduleMeasureAnchors()
}

defineExpose({ scrollToAnchor, scrollContainerRef })

function createView() {
  if (!containerRef.value) return
  error.value = null

  try {
    const newDoc = parseMarkdown(props.newContent)
    if (!newDoc) throw new Error('无法解析新版本内容')

    const view = new EditorView(containerRef.value, {
      state: makeState(newDoc),
      editable: () => false,
      // 只读模式:apply transaction 更新 state(让 diffDecoration plugin 的 setMeta 生效),
      // 但不触发 onChange 回写 —— 只读视图不需要序列化 markdown。
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr))
        frames?.schedule()
        scheduleMeasureAnchors()
      },
    })

    viewRef.value = view
    frames = createDiffGroupFrames(containerRef.value, view)
    applyOldDoc(view)
    frames.refresh()
    // DOM 布局就绪后按真实视口补装饰(FIRST_SCREEN_HINT 只覆盖首屏),并校正 ruler 像素位置
    requestAnimationFrame(() => {
      refreshViewport(view)
      frames?.refresh()
      scheduleMeasureAnchors()
    })

    // 监听内容高度变化(图片异步加载 / Mermaid 渲染 / 窗口缩放)实时校正 ruler 锚点位置
    if (typeof ResizeObserver !== 'undefined') {
      contentRo = new ResizeObserver(() => scheduleMeasureAnchors())
      contentRo.observe(containerRef.value)
      if (scrollContainerRef.value) contentRo.observe(scrollContainerRef.value)
    }
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

/** 换新 doc:复用同一批插件实例 updateState,避免销毁重建 EditorView */
function replaceDoc(doc: PMNode) {
  const view = viewRef.value
  if (!view) return
  view.updateState(makeState(doc))
  frames?.schedule()
  requestAnimationFrame(() => {
    refreshViewport(view)
    frames?.refresh()
  })
}

onMounted(() => {
  createView()
})

onBeforeUnmount(() => {
  contentRo?.disconnect()
  contentRo = null
  if (measureRafId !== null) {
    cancelAnimationFrame(measureRafId)
    measureRafId = null
  }
  frames?.destroy()
  frames = null
  if (viewRef.value) {
    viewRef.value.destroy()
    viewRef.value = null
    pluginInstances = null
  }
})

// 选中条目变化时增量更新(#diff-incremental):
// 合并监听避免切换条目时 newContent + oldContent 同 tick 各触发一次 buildDiffPlan
watch(
  [() => props.newContent, () => props.oldContent],
  ([nextNew, nextOld], [prevNew, prevOld]) => {
    const view = viewRef.value
    if (!view) return
    if (nextNew !== prevNew) {
      const doc = parseMarkdown(nextNew)
      if (!doc) return
      replaceDoc(doc)
      applyOldDoc(view)
      return
    }
    if (nextOld !== prevOld) {
      applyOldDoc(view)
    }
  },
)
</script>

<template>
  <div
    ref="scrollContainerRef"
    class="velo-wysiwyg-diff-container h-full overflow-y-auto"
    :class="{ 'velo-hide-scrollbar': hideScrollbar }"
  >
    <div v-if="error" class="p-4 text-sm text-red-500">
      diff 渲染失败:{{ error }}
    </div>
    <div ref="containerRef" class="velo-editor velo-diff-editor" />
  </div>
</template>

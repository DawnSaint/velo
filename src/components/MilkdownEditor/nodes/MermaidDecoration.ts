// MermaidNodeView 的 SVG 渲染 → 改走 ProseMirror Decoration.widget。
//
// 根因:atom NodeView 内部调 `dom.innerHTML = svg` 改自家 outer dom,被
// ProseMirror 的 DOMObserver 当成"外部突变",触发 readDOMChange →
// view.updateState → NodeViewDesc.create → mermaid 块全销毁重建。
//
// widget 由 ProseMirror View 内部管理,WidgetViewDesc.ignoreMutation 默认
// 忽略所有非 selection 突变(prose-view: `mutation.type != "selection"`),
// 不会触发 readDOMChange/updateState 报警。
//
// 显示 + 编辑统一由 widget 管:
// - 非编辑态(plugin state.editNodePos !== pos): 显示 SVG
// - 编辑态(editNodePos === pos): 显示 textarea + 实时预览 + commit/cancel
//
// 没有 NodeView —— schema toDOM 直接输出 `height:0` 隐藏占位(atom 必须有
// dom 用于 posAtCoords / selection 映射,藏掉视觉即可)。
//
// 范式对标:findreplace/findHighlight.ts(Decoration + DecorationSet + tr.setMeta)。

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import type { EditorState } from '@milkdown/prose/state'
import type { Node as PMNode } from '@milkdown/prose/model'
import type { EditorView } from '@milkdown/prose/view'
import mermaid from 'mermaid'

// ========== ID 生成 ==========

let nextId = 1
function uid(): string {
  return `mermaid-${nextId++}`
}

// ========== 主题探测 ==========

function getMermaidTheme(): 'default' | 'dark' {
  if (document.documentElement.classList.contains('dark')) return 'dark'
  return 'default'
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'default',
})

// ========== HTML 转义(用于 error UI) ==========

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ========== 异步渲染 ==========

interface RenderOutcome {
  svg: string
  bindFunctions?: (element: Element) => void
  error: string | null
}

async function renderMermaid(code: string, id: string, theme: 'default' | 'dark'): Promise<RenderOutcome> {
  const trimmed = code.trim()
  if (!trimmed) return { svg: '', error: null }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
  })

  try {
    await mermaid.parse(trimmed)
  }
  catch (e: any) {
    return { svg: '', error: e?.message || 'Syntax error' }
  }

  try {
    const result = await mermaid.render(id, trimmed)
    return { svg: result.svg, bindFunctions: result.bindFunctions, error: null }
  }
  catch (e: any) {
    return { svg: '', error: e?.message || 'Render error' }
  }
}

// ========== Plugin state ==========

interface MermaidDecoState {
  svgCache: Map<string, string>
  errorCache: Map<string, string>
  pending: Map<string, Promise<RenderOutcome>>
  /** 哪个 pos 正在编辑(widget 自己 click 时设,commit/cancel 清) */
  editNodePos: number | null
}

function initialState(): MermaidDecoState {
  return {
    svgCache: new Map(),
    errorCache: new Map(),
    pending: new Map(),
    editNodePos: null,
  }
}

// ========== Plugin key ==========

export const mermaidDecoKey = new PluginKey<MermaidDecoState>('mermaidDecoration')

// ========== Module-level view ref ==========

let currentView: EditorView | null = null

// ========== buildDecorations ==========
//
// 关键:**所有** mermaid 节点都生成 widget(包括编辑态)。
// 编辑态 widget 内部渲染 textarea 而不是 SVG。
// 这样 widget key 稳定(state 变化时复用),不会出现"切编辑态时 widget 卸载"的问题。

function buildDecorations(state: EditorState, deco: MermaidDecoState): DecorationSet {
  const decos: Decoration[] = []
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'mermaid') return
    const source = (node.attrs.value || '').trim()
    const isEditing = deco.editNodePos === pos
    const widget = makeMermaidWidget(source, getMermaidTheme(), deco, pos, isEditing, node)
    decos.push(Decoration.widget(pos, widget, {
      block: true,
      // pos + isEditing 联合:同 pos 进/出编辑态时 key 变,widget 重建
      // 同 pos 同状态稳定时,不带 source 防止用户编辑时 source 变 → key 变 → widget 重建
      key: `mermaid-widget:${pos}:${isEditing ? 'edit' : 'view'}`,
      ignoreSelection: true,
      destroy(dom) {
        const fn = widgetListeners.get(dom as HTMLElement)
        if (fn) {
          window.removeEventListener('velo:theme-change', fn)
          widgetListeners.delete(dom as HTMLElement)
        }
      },
    }))
  })
  return DecorationSet.create(state.doc, decos)
}

// ========== Widget factory ==========

function makeMermaidWidget(
  source: string,
  theme: 'default' | 'dark',
  deco: MermaidDecoState,
  pos: number,
  isEditing: boolean,
  node: PMNode,
): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'mermaid-node mermaid-widget'

  if (isEditing) {
    fillEditor(dom, node, pos)
  }
  else {
    // click → 进入编辑态(只在显示态挂)
    dom.addEventListener('mousedown', (e) => { e.stopPropagation() }, true)
    dom.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      const view = currentView
      if (!view || view.isDestroyed) return
      view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { startEditAt: pos }))
    })

    // 主题切换:widget 自己挂 listener 直接改 dom,不走 plugin state(避免死循环)
    const onThemeChange = () => {
      if (!source) return
      deco.svgCache.delete(source)
      deco.errorCache.delete(source)
      renderLoader(dom)
      const p = renderMermaid(source, uid(), getMermaidTheme())
      deco.pending.set(source, p)
      p.then((outcome) => {
        deco.pending.delete(source)
        if (outcome.error) {
          deco.errorCache.set(source, outcome.error)
          renderError(dom, outcome.error)
        }
        else {
          deco.svgCache.set(source, outcome.svg)
          dom.innerHTML = outcome.svg
          const newSvg = dom.querySelector('svg')
          if (newSvg) newSvg.style.height = 'auto'
        }
      }).catch(() => deco.pending.delete(source))
    }
    widgetListeners.set(dom, onThemeChange)
    window.addEventListener('velo:theme-change', onThemeChange)

    fillWidget(dom, source, theme, deco)
  }

  return dom
}

// 跟踪 widget dom → theme change listener
const widgetListeners = new WeakMap<HTMLElement, () => void>()

// ========== 编辑态 widget 内容 ==========

function fillEditor(dom: HTMLElement, node: PMNode, pos: number): void {
  dom.classList.add('is-editing')

  const initialValue = (node.attrs.value as string) || ''

  const textarea = document.createElement('textarea')
  textarea.value = initialValue
  textarea.className = 'edit-textarea'
  textarea.placeholder = 'graph TD\n  A[开始] --> B[结束]'

  const preview = document.createElement('div')
  preview.className = 'edit-preview'

  dom.appendChild(textarea)
  dom.appendChild(preview)

  const view = currentView
  if (view && !view.isDestroyed) {
    view.dom.classList.add('prosemirror-caret-hidden')
  }

  // 隔离 ProseMirror
  textarea.addEventListener('beforeinput', (e) => { e.stopPropagation() })
  textarea.addEventListener('paste', (e) => { e.stopPropagation() })
  textarea.addEventListener('mousedown', (e) => { e.stopPropagation() }, true)
  textarea.addEventListener('click', (e) => { e.stopPropagation() })

  // autoSize
  function autoHeight() {
    textarea.style.height = `${textarea.scrollHeight}px`
  }
  setTimeout(autoHeight, 0)

  // 实时预览(debounce + stale 丢弃)
  let lastPreviewCode = ''
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  function schedulePreview(code: string) {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; doPreview(code) }, 400)
  }
  function doPreview(code: string) {
    if (lastPreviewCode === code) return
    lastPreviewCode = code
    const trimmed = code.trim()
    if (!trimmed) { preview.innerHTML = ''; return }
    preview.innerHTML = '<div class="mermaid-loading">渲染中...</div>'
    renderMermaid(trimmed, uid(), getMermaidTheme()).then((outcome) => {
      if (lastPreviewCode !== code) return
      if (outcome.error) {
        preview.innerHTML = `<span class="mermaid-error">${escapeHtml(outcome.error)}</span>`
      }
      else {
        preview.innerHTML = outcome.svg
        const svgEl = preview.querySelector('svg')
        if (svgEl) svgEl.style.height = 'auto'
      }
    })
  }

  textarea.addEventListener('input', (e) => {
    e.stopPropagation()
    autoHeight()
    schedulePreview(textarea.value)
  })

  // 已有 svg 作为初始 preview
  const initSource = initialValue.trim()
  if (initSource) {
    const v = currentView
    if (v) {
      const cur = mermaidDecoKey.getState(v.state)
      if (cur && cur.svgCache.has(initSource)) {
        preview.innerHTML = cur.svgCache.get(initSource)!
        const svgEl = preview.querySelector('svg')
        if (svgEl) svgEl.style.height = 'auto'
        lastPreviewCode = initialValue
      }
    }
  }

  function commit() {
    const v = currentView
    if (!v || v.isDestroyed) return
    const value = textarea.value
    const tr = v.state.tr
    if (value !== node.attrs.value) tr.setNodeAttribute(pos, 'value', value)
    tr.setMeta(mermaidDecoKey, { commitAt: pos })
    v.dom.classList.remove('prosemirror-caret-hidden')
    v.dispatch(tr)
  }

  function cancel() {
    const v = currentView
    if (!v || v.isDestroyed) return
    v.dom.classList.remove('prosemirror-caret-hidden')
    v.dispatch(v.state.tr.setMeta(mermaidDecoKey, { cancelAt: pos }))
  }

  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
    if (e.key === 'Tab') {
      e.preventDefault()
      const start = textarea.selectionStart ?? textarea.value.length
      const end = textarea.selectionEnd ?? textarea.value.length
      textarea.value = textarea.value.slice(0, start) + '\t' + textarea.value.slice(end)
      textarea.selectionStart = textarea.selectionEnd = start + 1
      autoHeight()
      schedulePreview(textarea.value)
    }
  })

  textarea.addEventListener('blur', () => commit())

  // 自动焦点
  setTimeout(() => textarea.focus(), 0)
}

function fillWidget(
  dom: HTMLElement,
  source: string,
  theme: 'default' | 'dark',
  deco: MermaidDecoState,
): void {
  const hasOldSvg = !!dom.querySelector('svg')

  if (!source) {
    renderPlaceholder(dom)
    return
  }
  if (deco.svgCache.has(source)) {
    renderSvg(dom, deco.svgCache.get(source)!)
    return
  }
  if (deco.errorCache.has(source)) {
    renderError(dom, deco.errorCache.get(source)!)
    return
  }
  if (!hasOldSvg) {
    renderLoader(dom)
  }

  let p = deco.pending.get(source)
  if (!p) {
    p = renderMermaid(source, uid(), theme)
    deco.pending.set(source, p)
  }

  p.then((outcome) => {
    deco.pending.delete(source)
    if (outcome.error) {
      deco.errorCache.set(source, outcome.error)
      renderError(dom, outcome.error)
    }
    else {
      deco.svgCache.set(source, outcome.svg)
      deco.errorCache.delete(source)
      const svgEl = dom.querySelector('svg')
      if (svgEl) {
        svgEl.outerHTML = outcome.svg
      }
      else {
        dom.innerHTML = outcome.svg
      }
      const newSvg = dom.querySelector('svg')
      if (newSvg) newSvg.style.height = 'auto'
    }
  }).catch(() => deco.pending.delete(source))
}

function renderPlaceholder(dom: HTMLElement): void {
  dom.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'mermaid-placeholder'
  el.textContent = '点击添加 Mermaid 图表'
  dom.appendChild(el)
}

function renderLoader(dom: HTMLElement): void {
  dom.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'mermaid-loading'
  el.textContent = '渲染中...'
  dom.appendChild(el)
}

function renderError(dom: HTMLElement, msg: string): void {
  dom.innerHTML = ''
  const el = document.createElement('div')
  el.className = 'mermaid-error'
  el.innerHTML = `<span class="mermaid-error-icon">!</span>
    <span class="mermaid-error-msg">${escapeHtml(msg)}</span>
    <span class="mermaid-error-hint">点击编辑</span>`
  dom.appendChild(el)
}

function renderSvg(dom: HTMLElement, svg: string): void {
  dom.innerHTML = svg
  const svgEl = dom.querySelector('svg')
  if (svgEl) svgEl.style.height = 'auto'
}

// ========== Plugin ==========

const mermaidDecoPlugin = new Plugin<MermaidDecoState>({
  key: mermaidDecoKey,
  state: {
    init: () => initialState(),
    apply(tr, prev) {
      const meta = tr.getMeta(mermaidDecoKey)
      let { svgCache, errorCache, pending, editNodePos } = prev

      if (meta) {
        if (meta.startEditAt !== undefined) editNodePos = meta.startEditAt
        if (meta.commitAt !== undefined) editNodePos = null
        if (meta.cancelAt !== undefined) editNodePos = null
      }

      // doc 变化跟住 editNodePos
      if (editNodePos != null) {
        const mapped = tr.mapping.map(editNodePos)
        editNodePos = mapped == null ? null : mapped
      }

      return { svgCache, errorCache, pending, editNodePos }
    },
  },
  props: {
    decorations(state) {
      const deco = mermaidDecoKey.getState(state)
      if (!deco) return null
      return buildDecorations(state, deco)
    },
  },
  view: (view: EditorView) => {
    currentView = view
    return {
      destroy() {
        if (currentView === view) currentView = null
      },
    }
  },
})

export const mermaidDecoration = $prose(() => mermaidDecoPlugin)

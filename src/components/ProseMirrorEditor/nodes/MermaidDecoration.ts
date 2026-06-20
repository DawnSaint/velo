// Mermaid SVG 渲染走 ProseMirror Decoration.widget(老教训:atom NodeView 内部改
// innerHTML 会被 DOMObserver 当外部突变 → 全量 remount + loader 闪烁)。
//
// v0.4.6 改造:```mermaid 改走 `code_block { language: 'mermaid' }`(与其他 fenced
// code 同管线)。本 plugin 的职责:
//   - 默认态:在 pre 之前挂 widget(side: -1,SVG 在上 / pre 在下)
//   - widget 内部:SVG 容器 + 自管 toolbar(切换源码 / 复制 / 删除 / 关闭)
//   - 隐藏态:Decoration.node 改 pre `data-mermaid-source="hidden"` → SCSS display:none
//   - 切换"看源码"态:点击 SVG 派发 setMeta(toggleEditAt) → state 翻转 →
//     派发 setSelection 把光标放进 pre 内部(focus 进 pre);关闭时把
//     selection 移出(blur)
//   - 源码编辑:用户在 doc 中直接编辑 code_block(pre 一直存在,只是 CSS 隐藏)
//   - SVG 主题切换:widget 工厂挂 `velo:theme-change` listener 自己改 dom
//
// 关键设计取舍:
//   - 不再用 textarea + 自管 commit/cancel(source 全程在 doc.textContent 里)
//   - widget 在 side: -1(在 pre 之前)→ codeHighlight 在 mermaid 上**不**挂 toolbar
//     (我们 widget 自带 toolbar 接管),避免同 pos 同 side 多 widget 冲突
//   - focus 走 view.focus() + TextSelection 进 pre 内部;blur 走 view.dispatch
//     把 selection 移到 doc 顶层
//
// 范式对标:findreplace/findHighlight.ts(Decoration + DecorationSet + tr.setMeta)。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
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
  /**
   * 哪些 pos 正在编辑(多个 mermaid 可同时展开;v0.4.6+ 互斥单数 → set 多 pos,
   * 避免点第二个 toggle 时把第一个自动收起)。
   * set 的元素是 `$from.start()` 风格的绝对 pos(经过 tr.mapping 跟住 doc 变化)。
   */
  editNodeSet: Set<number>
  /**
   * 一次性 focus 标记:set of pos,plugin view 的 `update` 钩子见到非空就
   * focus 每个 pos 一次,然后 dispatch 把它清掉。允许多 mermaid 同时 focus
   * (用户连续点多个 toggle)。
   */
  pendingFocusSet: Set<number>
}

function initialState(): MermaidDecoState {
  return {
    svgCache: new Map(),
    errorCache: new Map(),
    pending: new Map(),
    editNodeSet: new Set(),
    pendingFocusSet: new Set(),
  }
}

// ========== Plugin key ==========

export const mermaidDecoKey = new PluginKey<MermaidDecoState>('mermaidDecoration')

let currentView: EditorView | null = null

// ========== buildDecorations ==========
//
// 每个 code_block lang='mermaid' 挂两件 decoration:
//   1) Decoration.node 在 pre 上加 inline style(display:none <-> 可见),控制是否"看源码"
//   2) Decoration.widget 在 pre **之前**挂 SVG(side: -1),点击切到"看源码"态
//      pre 在上 / SVG 在下 ← 用户要求

function buildDecorations(state: EditorState, deco: MermaidDecoState): DecorationSet {
  const decos: Decoration[] = []
  state.doc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'code_block') return
    if ((node.attrs.language as string) !== 'mermaid') return
    const source = (node.textContent || '').trim()
    // 计算绝对 pos:doc 顶级子节点 descendants 给 fragment offset,绝对 pos =
    // pos + 1(跳过 child 的 open token,即 $from.start() 风格)。
    const absolutePos = pos + 1
    // 这个 mermaid 是否展开:editNodeSet 包含其绝对 pos(允许多 mermaid 同时展开)。
    const isEditing = deco.editNodeSet.has(absolutePos)
    // 1) pre 隐藏 / 显示
    decos.push(Decoration.node(pos, pos + node.nodeSize, {
      'data-mermaid-source': isEditing ? 'visible' : 'hidden',
    }))
    // 2) widget 锚在 block 末尾之后(side: 1)→ DOM 顺序 pre → svgArea + toolbar
    //    视觉上 pre 在上 / SVG 在下(用户要求)
    const widgetPos = pos + node.nodeSize
    // 关键:传给 widget 工厂的 pos 必须是 **绝对 pos** ($from.start() 风格),
    // 跟 setMeta / tr.delete / tr.setSelection 共用一套坐标系。
    const widget = makeMermaidWidget(source, getMermaidTheme(), deco, absolutePos, isEditing, node)
    decos.push(Decoration.widget(widgetPos, widget, {
      block: true,
      side: 1,
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
//
// 渲染 SVG + 自管 toolbar(切换源码 / 删除 / 关闭)。
// 源码编辑走 prose code_block 自身(用户直接在 doc 里打字)。
// 注意:语言选择 + 复制由 CodeHighlightPlugin 的 toolbar 提供(同 code_block
// 共享,无重复)— 本 widget 只补 mermaid 特有的"切源码 / 删 / 关"。

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
  if (isEditing) dom.classList.add('is-editing')

  // 容器 = svg area + toolbar
  const svgArea = document.createElement('div')
  svgArea.className = 'mermaid-svg-area'
  dom.appendChild(svgArea)

  const toolbar = document.createElement('div')
  toolbar.className = 'mermaid-toolbar'
  toolbar.contentEditable = 'false'
  // toggle 按钮自带"折叠 ↔ 展开"两态图标:
  //   - 折叠态(默认):chevron-down(向下)→ 点击展开 code block
  //   - 展开态:chevron-up(向上)→ 点击收起 code block
  // (避免叉号容易被误认为删除;未来要做可缩放/拖动,这是唯一入口)
  toolbar.appendChild(makeToggleBtn(pos, isEditing))
  toolbar.appendChild(makeDeleteBtn(pos, node))
  dom.appendChild(toolbar)

  // v0.4.6+:SVG 区域不再响应 click(避免与后续 zoom/pan 拖动手势冲突);
  // 展开/收起 code block 仅通过 toolbar 上的 chevron 按钮。

  // 主题切换:widget 自己挂 listener 直接改 dom,不走 plugin state(避免死循环)
  const onThemeChange = () => {
    if (!source) return
    deco.svgCache.delete(source)
    deco.errorCache.delete(source)
    renderLoader(svgArea)
    const p = renderMermaid(source, uid(), getMermaidTheme())
    deco.pending.set(source, p)
    p.then((outcome) => {
      deco.pending.delete(source)
      if (outcome.error) {
        deco.errorCache.set(source, outcome.error)
        renderError(svgArea, outcome.error)
      }
      else {
        deco.svgCache.set(source, outcome.svg)
        svgArea.innerHTML = outcome.svg
        const newSvg = svgArea.querySelector('svg')
        if (newSvg) newSvg.style.height = 'auto'
      }
    }).catch(() => deco.pending.delete(source))
  }
  widgetListeners.set(dom, onThemeChange)
  window.addEventListener('velo:theme-change', onThemeChange)

  fillWidget(svgArea, source, theme, deco)

  // **不在 widget 工厂里 focus**:widget 会在每次 decorations 重建时重新创建,
  // 如果在这里 focus → 每次用户尝试移出 pre 都会被 ProseMirror 的 DOMObserver
  // 反推 → 重建 → 再次 focus 进 pre(用户报告"光标被拉回"根因)。
  // 真正的 focus 走 plugin view 的 `update` 钩子,只消费一次 pendingFocus 标记。

  return dom
}

// ========== Toolbar 按钮工厂 ==========

function makeToggleBtn(pos: number, isEditing: boolean): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mermaid-btn mermaid-btn-toggle'
  // 折叠态(SVG 显示 / pre 隐藏)→ chevron-up(向上,点击展开 code block)
  // 展开态(pre 显示)→ chevron-down(向下,点击收起 code block)
  // (避免叉号歧义;后续要做可缩放/拖动,这是唯一切换入口)
  const title = isEditing ? '收起源码' : '展开源码'
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.innerHTML = isEditing
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="6 9 12 15 18 9"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="18 15 12 9 6 15"/></svg>`
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const view = currentView
    if (!view || view.isDestroyed) return
    view.dispatch(view.state.tr.setMeta(mermaidDecoKey, { toggleEditAt: pos }))
  })
  return btn
}

function makeDeleteBtn(pos: number, node: PMNode): HTMLElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mermaid-btn mermaid-btn-delete'
  btn.title = '删除 mermaid 块'
  btn.setAttribute('aria-label', '删除 mermaid 块')
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>`
  btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const view = currentView
    if (!view || view.isDestroyed) return
    // 整段 code_block 删除(走 tr.delete,跟 imageKeymap 的"选中即删"同一机制)。
    // 注意:widget 工厂收的 `pos` 是 absolutePos = descendant pos + 1,在
    // code_block **内部** (open token 之后、content 起点)。要删整段必须
    // 回退到 open token 之前的边界 (pos - 1) 到 close token 之后 (pos - 1 + node.nodeSize)。
    // 否则范围越界 1 位,跨过 close token 吃进下一个 paragraph 的 open token →
    // 残留的 code_block open token 把后续 paragraph 内容"吞"进 code_block,
    // 表现为"清空 code block + 把后面段落移进去,mermaid 删不掉"。
    const blockStart = pos - 1
    const blockEnd = blockStart + node.nodeSize
    const tr = view.state.tr.delete(blockStart, blockEnd)
    // 顺手把 editNodeSet 清掉,避免悬挂状态
    tr.setMeta(mermaidDecoKey, { toggleEditAt: -1 } as any)
    view.dispatch(tr)
    view.focus()
  })
  return btn
}

// 跟踪 widget dom → theme change listener
const widgetListeners = new WeakMap<HTMLElement, () => void>()

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
  el.textContent = '暂无内容'
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
    <span class="mermaid-error-msg">${escapeHtml(msg)}</span>`
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
      // 不可变:set 新对象,apply 是纯函数
      let { svgCache, errorCache, pending } = prev
      let editNodeSet = new Set(prev.editNodeSet)
      let pendingFocusSet = new Set(prev.pendingFocusSet)

      if (meta) {
        // toggle:同 pos 再次点击 → 退出;否则进入(add 到 set)。
        // toggleEditAt === -1 是 delete 路径,清空整个 set(整段被删)。
        if (meta.toggleEditAt !== undefined) {
          if (meta.toggleEditAt === -1) {
            editNodeSet = new Set()
            pendingFocusSet = new Set()
          }
          else {
            const pos = meta.toggleEditAt
            if (editNodeSet.has(pos)) {
              // 同 pos 再次 → 退出
              editNodeSet.delete(pos)
              pendingFocusSet.delete(pos)
            }
            else {
              // 不同 pos → 加入 set(允许多 mermaid 同时展开)
              editNodeSet.add(pos)
              pendingFocusSet.add(pos)
            }
          }
        }
        // consumeFocus:update 钩子处理完一次 focus 后回报,清标记
        if (meta.consumeFocus !== undefined) {
          if (pendingFocusSet.has(meta.consumeFocus)) {
            pendingFocusSet.delete(meta.consumeFocus)
          }
        }
      }

      // doc 变化跟住 editNodeSet(每个 pos 都映射,失效的删掉)
      //
      // **坑**:tr.mapping.map(pos) 默认 assoc=+1(关联"变更之后")。
      // 我们的 pos 是 absolutePos = descendant_pos + 1 = content 起点(在 open
      // token 之后、第一个 content 字符之前)。当用户在这个位置 insertText
      // 时,assoc=+1 会把"content 起点"映射到"插入文本末尾"(pos + insertSize),
      // 导致 set 里的 pos 跑到 code_block content 尾部,下次 buildDecorations
      // 用 descendants 重新找到的 absolutePos(还是 content 起点)跟 set 对不上
      // → pre 被误判为 hidden。必须用 assoc=-1 保留"在变更之前"的语义:
      // content 起点在 insertText 之前/之后都不变,只在被删时才丢。
      if (editNodeSet.size > 0) {
        const mapped = new Set<number>()
        for (const pos of editNodeSet) {
          const m = tr.mapping.map(pos, -1)
          if (m != null) mapped.add(m)
        }
        editNodeSet = mapped
      }
      // pendingFocusSet 也跟 doc 变化映射(同坑,同样 fix)
      if (pendingFocusSet.size > 0) {
        const mapped = new Set<number>()
        for (const pos of pendingFocusSet) {
          const m = tr.mapping.map(pos, -1)
          if (m != null) mapped.add(m)
        }
        pendingFocusSet = mapped
      }

      return { svgCache, errorCache, pending, editNodeSet, pendingFocusSet }
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
    // 一次性 focus 防重入标志:在 dispatch 之后,DOMObserver 会因 selection 变化
    // 触发新一轮 update,我们靠这个标志识别"我们自己造成的 selection 变化",
    // 避免再排一次 focus(否则会循环)。
    let focusing = false
    return {
      update(updatedView, _prevState) {
        const curDeco = mermaidDecoKey.getState(updatedView.state) as MermaidDecoState | undefined
        if (!curDeco || curDeco.pendingFocusSet.size === 0) return
        if (focusing) return
        // 取一个 set 副本作为本次要消费的(避免边迭代边删)
        const focusPositions = Array.from(curDeco.pendingFocusSet)
        if (focusPositions.length === 0) return
        focusing = true
        // 用微任务放到当前事务落幕之后,再操作 DOM / dispatch
        queueMicrotask(() => {
          try {
            if (updatedView.isDestroyed) return
            // 走 prose setSelection + view.focus:让 prose 自己把 selection 写进 DOM,
            // observer 见到 `currentSelection.eq(sel)` 立刻 true → 不会再 dispatch 一次。
            // (原 DOM Selection API 路径会触发 observer 反推 tr.setSelection → 死循环)。
            // 多 mermaid 同时展开时:选**最后一个**展开的作为光标目标(用户最后一次
            // 操作的),前面已经展开的保留展开态不抢光标(用户阅读/复制更顺)。
            const focusPos = focusPositions[focusPositions.length - 1]
            const node = updatedView.state.doc.nodeAt(focusPos)
            const insidePos = node
              ? Math.min(focusPos + node.content.size, updatedView.state.doc.content.size)
              : focusPos
            const $end = updatedView.state.doc.resolve(insidePos)
            const tr = updatedView.state.tr
              .setSelection(TextSelection.near($end, -1))
              .setMeta(mermaidDecoKey, { consumeFocus: focusPos })
            updatedView.dispatch(tr)
            updatedView.focus()
          }
          catch { /* swallow */ }
          finally {
            focusing = false
          }
        })
      },
      destroy() {
        if (currentView === view) currentView = null
      },
    }
  },
})

export const mermaidDecoration = mermaidDecoPlugin

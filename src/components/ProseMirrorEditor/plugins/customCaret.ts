// 自绘 caret 插件 —— 消除 code_block 末行 / fold_placeholder 等"非文本位置"光标
// 明显高于文本位置光标的视觉差。
//
// ## 根因(见 docs/architecture/editor.md「坑续(空行/末位非文本光标"明显更高")」行 113-120)
//
// Chromium 的 `LocalCaretRect` 在两个位置分两套规则:
//   - 文本位置 (text node offset):caret 高度 = em-square
//   - 非文本位置 (atomic inline / <br> 的 BeforeNode/AfterNode):caret 高度 = line box
//
// line box 由块级 `line-height × font-size` 决定,无法对单行单独缩小;把 separator
// 高度改 0/1px 也不影响 line box(实测 no-fix 版 separator 0×0、line box 仍是 23.04)。
// code_block `1.6 × 14.4 = 23.04px` vs 文本位置 `14px`,h2 `1.75 × 25.6 = 44.8` vs
// 文本位置 `34px`,两个差都被用户感知为"明显更高"。
//
// ## 方案(与 CM6 drawSelection 同范式,但只覆盖非文本位置)
//
// 插件在选区是 collapsed 且落点 DOM 不是文本节点时,接管:把原生 caret 藏掉
// (`caret-color: transparent`),用一个绝对定位 overlay `<div>` 画一根 1px 红条。
//
// **几何来源**:`view.coordsAtPos(pos)`。PM 的 `_coordsAtPos` 在非文本位置返回的
// rect **不等于 Blink 实际画的 caret 高度**,反而落在该行"如果有个文本位置,
// caret 该在哪儿"的网格上 —— 直接画即可与同段文本位置 caret 像素一致
// (实测 code_block 末行 Δ=0、h2 fold_placeholder 后 Δ=0)。三档决策:
//
//   - H ≈ F      :coordsAtPos 取到字盒(已在行网格上)→ 原样画 (as-is)
//   - H ≈ strutH :coordsAtPos 取到 line box / 原子 inline 盒 → 收缩到 F 并居中 (shrink)
//   - 其余(行盒被行内大盒子如图片撑开)→ 不接管,让原生 baseline caret 处理
//
// **不接管条件**:文本位置(isTextPosition)、范围选区、NodeSelection、IME composition、
// 焦点丢失、CellSelection `.ProseMirror-hideselection`、几何无法归类。
//
// ## 挂载位置
//
// overlay 挂在 `view.dom.parentNode`(兄弟节点,不在 PM contentDOM 子树内):
// prosemirror-view `DOMObserver.registerMutation` 第 4482 行 `desc == view.docView`
// 时属性变更直接忽略,新加元素也不在 contentDOM 子树内 → 不会被 PM 当外部突变重建
// 文档。`position: absolute; pointer-events: none`,与滚动容器同跑(layout 变化由
// ResizeObserver 触发重算 + 跟随 scroll 自然移动)。
//
// ## 字体度量
//
// `fontBoxHeight` 用 Canvas `ctx.measureText('Ag').fontBoundingBoxAscent + Descent`
// 算 em-square,按 CSS font 简写 key 缓存;`document.fonts.loadingdone/ready` 触发
// clear 兜底异步字体加载。`measureText('Ag')` 含 ascender + descender + x-height,
// 对 6 个字体实测与原生文本位置 caret 高度 Δ=0.00。
//
// ## 同步调度
//
// `requestAnimationFrame` 合并同帧多次 `view.update`;`update()` 每次 state 变更
// 都 schedule;`destroy()` 取消 rAF + disconnect RO + 移除 el + 清理 view.dom class。
// 切文件 `view.updateState(EditorState.create(...))` 走 `view.update` 链 → 触发 schedule,
// 旧 overlay destroy 时已清,新 view mount 时挂新 overlay,无残留。

import { Plugin, PluginKey, NodeSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

const caretKey = new PluginKey('veloCustomCaret')

// ── 字体度量缓存 ────────────────────────────────────────────────────────

const metricCache = new Map<string, number>()
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null

function getCtx(): CanvasRenderingContext2D | null {
  if (ctx) return ctx
  if (typeof document === 'undefined') return null
  canvas = document.createElement('canvas')
  ctx = canvas.getContext('2d')
  return ctx
}

/** 由 CSS font 简写 key 算出 em-square 高度(px)。非法串 / 度量失败返 0,调用方降级。 */
function fontBoxHeight(font: string): number {
  const hit = metricCache.get(font)
  if (hit !== undefined) return hit
  const c = getCtx()
  if (!c) return 0
  let h = 0
  try {
    c.font = font
    const m = c.measureText('Ag')
    const v = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent
    if (isFinite(v) && v > 0) h = v
  } catch {
    // 字体串非法 → 0,调用方回退原生
  }
  metricCache.set(font, h)
  return h
}

if (typeof document !== 'undefined' && document.fonts) {
  const clear = () => metricCache.clear()
  document.fonts.addEventListener?.('loadingdone', clear)
  document.fonts.ready?.then(clear)
}

// ── 决策函数 ────────────────────────────────────────────────────────────

/** 光标是否落在文本节点上(是 → 完全交还原生 caret)。只查下游保守,shrink 分支兜底
 *  上游紧贴 atom 的边界(实测 h2 fold_placeholder 前的"text↔atom"边界)。 */
function isTextPosition(node: Node, offset: number): boolean {
  if (node.nodeType === 3) return true
  const n = offset < node.childNodes.length ? node.childNodes[offset] : node.childNodes[offset - 1]
  return !!n && n.nodeType === 3
}

interface ResolvedCaret {
  top: number
  height: number
  mode: 'as-is' | 'shrink' | 'fallback'
  F: number
  strutH: number
}

/** 由 coordsAtPos 的 rect 推出"应当绘制"的 caret 尺寸。返 null = 不接管。
 *  - H ≈ F      :coordsAtPos 已落在字盒上 → 原样画(等同文本位置 caret)
 *  - H ≈ strutH :coordsAtPos 取到 line box / 原子 inline 盒 → 收缩到 F 并居中
 *  - 其余(行内大盒子如 60px 图片撑开行盒)→ 不接管,留给原生 baseline caret */
function resolveCaret(host: HTMLElement, c: { top: number; bottom: number }): ResolvedCaret | null {
  const cs = getComputedStyle(host)
  const F = fontBoxHeight(
    `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`,
  )
  const strutH = parseFloat(cs.lineHeight)
  if (!F || !isFinite(strutH)) return null
  const H = c.bottom - c.top
  if (Math.abs(H - F) <= 1) return { top: c.top, height: H, mode: 'as-is', F, strutH }
  if (Math.abs(H - strutH) <= 1)
    return { top: c.top + (H - F) / 2, height: F, mode: 'shrink', F, strutH }
  return null
}

// ── Plugin view ─────────────────────────────────────────────────────────

class CaretView {
  private el: HTMLDivElement
  private raf: number | null = null
  private ro: ResizeObserver | null = null

  constructor(private readonly view: EditorView) {
    this.el = document.createElement('div')
    this.el.className = 'velo-fake-caret'
    const mount = view.dom.parentNode as HTMLElement
    if (getComputedStyle(mount).position === 'static') {
      mount.style.position = 'relative'
    }
    mount.appendChild(this.el)
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.schedule())
      this.ro.observe(view.dom)
    }
    caretViews.set(view, this)
    this.schedule()
  }

  private schedule() {
    if (this.raf != null) return
    this.raf = requestAnimationFrame(() => {
      this.raf = null
      this.sync()
    })
  }

  sync() {
    try {
      this.syncInner()
    } catch {
      // 任何几何异常(越界 pos / display:none 节点 / 不可测位置)都回落到隐藏,
      // 绝不能让上一帧画在旧位置的 overlay 残留 → 光标"卡"在标题后等 stale 位置。
      this.hide()
    }
  }

  private syncInner() {
    const view = this.view
    if (view.isDestroyed) return
    const sel = view.state.selection

    // 接管条件互斥闸
    const hide =
      !view.hasFocus() ||
      !sel.empty ||
      view.composing ||
      sel instanceof NodeSelection ||
      view.dom.classList.contains('ProseMirror-hideselection')
    if (hide) {
      this.hide()
      return
    }

    const { node, offset } = view.domAtPos(sel.head)
    if (isTextPosition(node, offset)) {
      this.hide()
      return
    }

    const candidates: Array<{ c: { top: number; bottom: number; left: number }, host: HTMLElement }> = []
    const pushCand = (p: number) => {
      if (p < 0 || p > view.state.doc.content.size) return
    }
    pushCand(sel.head)
    pushCand(sel.head - 1)
    pushCand(sel.head + 1)

    let chosen: { c: { top: number; bottom: number; left: number }, host: HTMLElement, r: ResolvedCaret } | null = null
    for (const cand of candidates) {
      const r = resolveCaret(cand.host, cand.c)
      if (!r) continue
      // as-is(em-square)优先:caret 直接落在文本边上,纵向与文本对齐
      if (r.mode === 'as-is') {
        chosen = { ...cand, r }
        break
      }
      if (!chosen) chosen = { ...cand, r }
    }

    // 无 as-is 候选(典型:折叠区段 display:none,coordsAtPos 返回零高矩形)→
    // 退回原 near 元素构造兜底
    if (!chosen) {
      const near = view.domAtPos(Math.max(sel.head - 1, 0))
      // 原子 inline(如 fold_placeholder)的「start 位置」domAtPos 返回的是外层
      // block 元素 + offset=原子在子节点中的序号,而非原子自身。要拿到紧贴光标
      // 左侧的 inline 盒,取该 offset 处的子元素;取不到(纯文本位置)再退回父元素。
      let nearEl: HTMLElement | null = null
      if (near.node.nodeType === 3) {
        nearEl = near.node.parentElement as HTMLElement | null
      } else if (near.node.nodeType === 1) {
        const kids = near.node.childNodes
        const cand = near.offset < kids.length ? kids[near.offset] : kids[near.offset - 1]
        nearEl = (cand && cand.nodeType === 1) ? (cand as HTMLElement) : (near.node as HTMLElement)
      }
      const box = nearEl?.getBoundingClientRect()
      const nearCs = nearEl ? getComputedStyle(nearEl) : null
      if (box && box.width > 0 && box.height > 0 && nearCs && nearCs.display.startsWith('inline')) {
        const F = fontBoxHeight(
          `${nearCs.fontStyle} ${nearCs.fontWeight} ${nearCs.fontSize} / ${nearCs.lineHeight} ${nearCs.fontFamily}`,
        )
        const strutH = parseFloat(nearCs.lineHeight)
        if (F > 0 && isFinite(strutH)) {
          chosen = {
            c: { top: box.top, bottom: box.bottom, left: box.right },
            host: nearEl!,
            r: { top: box.top + (box.height - F) / 2, height: F, mode: 'fallback', F, strutH },
          }
        }
      }
    }

    if (!chosen) {
      this.hide()
      return
    }

    // 接管:关原生 caret,把 overlay 定位到 mount 的相对坐标
    view.dom.classList.add('velo-native-caret-off')
    const mount = this.el.parentNode as HTMLElement
    const mr = mount.getBoundingClientRect()
    this.el.style.display = 'block'
    this.el.style.left = `${chosen.c.left - mr.left - mount.clientLeft}px`
    this.el.style.top = `${chosen.r.top - mr.top - mount.clientTop}px`
    this.el.style.height = `${chosen.r.height}px`
  }

  private hide() {
    this.view.dom.classList.remove('velo-native-caret-off')
    this.el.style.display = 'none'
  }

  update() {
    this.schedule()
  }

  destroy() {
    if (this.raf != null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.ro?.disconnect()
    this.ro = null
    this.hide()
    this.el.remove()
    caretViews.delete(this.view)
  }
}

/** view → caret view 映射(支持多编辑器)。供 fold 等插件在"程序化重定向光标"后
 *  立刻让自绘 caret 重算/隐藏,避免 overlay 停在上一个位置(见
 *  FoldDecoration.handleTextInput / handleKeyDown)。 */
const caretViews = new WeakMap<EditorView, CaretView>()

/** 立即重算自绘 caret(同步,不经 rAF)。程序化改完 selection 后调用,确保 overlay
 *  立刻跟随到新位置 / 或在新位置是文本位置时隐藏,不依赖下一帧 rAF 时序。 */
export function resetCustomCaret(view: EditorView) {
  if (view.isDestroyed) return
  caretViews.get(view)?.sync()
}

export const customCaretPlugin = new Plugin({
  key: caretKey,
  view: (v) => new CaretView(v),
})

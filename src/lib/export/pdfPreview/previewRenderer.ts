// Display List → DOM 预览。
//
// 与 pdfWriter 消费**同一份** PdfPage.ops：这里把算子绝对定位成 DOM，
// 那里把算子序列化成 PDF 内容流。一致性来源是共享布局树，不是共享慢引擎。
//
// 预览用与 PDF 相同的三套子集字体（@font-face 指向同一批 TTF），因此
// 断行 / 字宽在预览里就能看出来，不需要等导出。

import { ensurePreviewStyles } from './fragmentBuilder'
import { katexCssFont } from './katexVector'
import { FONT_FAMILY, fontSet, tokensOf } from './tokens'
import { PX_TO_PT, type FragmentOp, type PdfDocument, type PdfPage, type RichFragment } from './types'

const STYLE_ID = 'velo-pdf-font-faces'
const SVG_NS = 'http://www.w3.org/2000/svg'
let installedSet: object | null = null
const blobUrls: string[] = []
/** 公式 clipPath id 递增，避免同页多个公式撞 id */
let formulaSeq = 0

const num = (n: number): string => (Math.round(n * 100) / 100).toString()

interface PreviewFont {
  family: string
  weight: number
  style: 'normal' | 'italic'
}

/**
 * PDF 路径算子（操作数在前：`x y m`）→ SVG path d（命令在前：`m x y`）。
 * 提取器只产出 m/l/c/h，二者仅操作数顺序不同。
 */
function pdfPathOpsToSvg(ops: string): string {
  const tokens = ops.trim().split(/\s+/)
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const nums: string[] = []
    while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i])) nums.push(tokens[i++])
    if (i >= tokens.length) break
    const cmd = tokens[i++]
    // SVG 小写命令是相对语义，PDF 路径算子没有相对形式 —— 必须翻成大写（绝对）
    if (nums.length) out.push(`${cmd.toUpperCase()} ${nums.join(' ')}`)
  }
  return out.join(' ')
}

function formulaFont(font: string): PreviewFont {
  if (font === 'sans' || font === 'bold' || font === 'mono') {
    return { family: FONT_FAMILY[font], weight: 400, style: 'normal' }
  }
  return katexCssFont(font) ?? { family: 'sans-serif', weight: 400, style: 'normal' }
}

/**
 * 公式矢量片段：直接画 `RichFragment.formula` 算子（与 pdfWriter 同一份数据）。
 *
 * 局部坐标换算是关键：公式算子以「基线左端、y 向上」为原点，而预览盒是
 * 「左上角、y 向下」。盒高 = height + depth，故基线的盒内 y = h - depth，
 * 任意算子纵坐标 cy → 盒内 y-down = (h - depth) - cy。路径整体走
 * `translate(0, h-depth) scale(1,-1)`，文字逐字绝对定位。
 */
function renderFormulaFragment(root: HTMLElement, fr: RichFragment, op: FragmentOp, s: number): void {
  const fx = fr.formula
  if (!fx) return
  // 公式墨迹可能超出 .katex 盒（\overbrace / 大号可伸缩分隔符的 SVG 溢出不进
  // 盒高），PDF 侧不裁；预览也必须 overflow:visible，否则 brace 顶部被切掉。
  const box = el('div',
    `position:absolute;left:${op.x * s}px;top:${op.y * s}px;width:${op.w * s}px;height:${op.h * s}px;`
    + 'overflow:visible;pointer-events:none;')
  const baselineY = op.h - fx.depth

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', num(op.w * s))
  svg.setAttribute('height', num(op.h * s))
  svg.setAttribute('viewBox', `0 0 ${num(op.w)} ${num(op.h)}`)
  svg.setAttribute('style', 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none')

  for (const r of fx.rects) {
    const rect = document.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('x', num(r.x))
    rect.setAttribute('y', num(baselineY - (r.y + r.h)))
    rect.setAttribute('width', num(r.w))
    rect.setAttribute('height', num(r.h))
    rect.setAttribute('fill', r.color)
    svg.appendChild(rect)
  }

  for (const p of fx.paths) {
    const outer = document.createElementNS(SVG_NS, 'g')
    if (p.clip) {
      const cid = `velo-fx-${formulaSeq++}`
      const clipPath = document.createElementNS(SVG_NS, 'clipPath')
      clipPath.setAttribute('id', cid)
      const crect = document.createElementNS(SVG_NS, 'rect')
      crect.setAttribute('x', num(p.clip.x))
      crect.setAttribute('y', num(baselineY - (p.clip.y + p.clip.h)))
      crect.setAttribute('width', num(p.clip.w))
      crect.setAttribute('height', num(p.clip.h))
      clipPath.appendChild(crect)
      svg.appendChild(clipPath)
      outer.setAttribute('clip-path', `url(#${cid})`)
    }
    const inner = document.createElementNS(SVG_NS, 'g')
    inner.setAttribute('transform', `translate(0 ${num(baselineY)}) scale(1 -1)`)
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', pdfPathOpsToSvg(p.ops))
    path.setAttribute('fill', p.fill ?? 'none')
    if (p.stroke) {
      path.setAttribute('stroke', p.stroke)
      path.setAttribute('stroke-width', num(p.strokeWidth ?? 0.5))
    } else {
      path.setAttribute('stroke', 'none')
    }
    inner.appendChild(path)
    outer.appendChild(inner)
    svg.appendChild(outer)
  }

  for (const t of fx.texts) {
    const pf = formulaFont(t.font)
    const span = el('span',
      `position:absolute;left:${t.x * s}px;top:${(baselineY - t.y - t.size * 0.82) * s}px;`
      + `font-family:'${pf.family}',sans-serif;font-weight:${pf.weight};font-style:${pf.style};`
      + `font-size:${t.size * s}px;line-height:1;color:${t.color};white-space:pre;`)
    span.textContent = t.ch
    box.appendChild(span)
  }

  box.appendChild(svg)
  root.appendChild(box)
}

/**
 * 注入 @font-face 与 KaTeX CSS。@font-face 指向**运行时子集 TTF** 的 blob URL
 * （与 PDF FontFile2 嵌入同一份字节），子集变化时重建。必须在 installFontSet
 * 之后调用（buildPdf 内部顺序已保证）。
 */
export function ensurePreviewDomStyles(): void {
  const set = fontSet()
  if (installedSet !== set) {
    installedSet = set
    for (const u of blobUrls) URL.revokeObjectURL(u)
    blobUrls.length = 0
    const css = (['sans', 'bold', 'mono'] as const).map(k => {
      const url = URL.createObjectURL(new Blob([set[k].ttf.slice().buffer as ArrayBuffer], { type: 'font/ttf' }))
      blobUrls.push(url)
      return `@font-face{font-family:'${FONT_FAMILY[k]}';src:url('${url}') format('truetype');font-display:block;}`
    }).join('\n')
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }
    style.textContent = css
  }
  void ensurePreviewStyles()
}

function el(tag: string, css: string): HTMLElement {
  const e = document.createElement(tag)
  e.style.cssText = css
  return e
}

/** 把一页渲染成一个可插入文档流的 div。scale = 缩放倍率（1 ≈ 72dpi）。 */
export function renderPageDom(doc: PdfDocument, index: number, scale: number): HTMLElement {
  const page: PdfPage = doc.pages[index]
  const t = tokensOf(doc.options)
  const s = scale
  const root = el('div', `position:relative;width:${doc.pageWidth * s}px;height:${doc.pageHeight * s}px;background:${t.pageBg};overflow:hidden;box-sizing:border-box;`)
  root.className = 'velo-pdf-page'
  root.dataset.page = String(index + 1)

  // 线条统一走一层 SVG，避免大量旋转 div
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(doc.pageWidth * s))
  svg.setAttribute('height', String(doc.pageHeight * s))
  svg.setAttribute('viewBox', `0 0 ${doc.pageWidth * s} ${doc.pageHeight * s}`)
  svg.setAttribute('style', 'position:absolute;left:0;top:0;pointer-events:none')
  let lineCount = 0

  for (const op of page.ops) {
    switch (op.op) {
      case 'text': {
        if (!op.text) break
        const span = el('span',
          `position:absolute;left:${op.x * s}px;top:${(op.y - op.size * 0.82) * s}px;`
          + `font-family:'${FONT_FAMILY[op.font]}',sans-serif;font-size:${op.size * s}px;`
          + `line-height:1;color:${op.color};white-space:pre;`)
        span.textContent = op.text
        root.appendChild(span)
        break
      }
      case 'rect': {
        root.appendChild(el('div',
          `position:absolute;left:${op.x * s}px;top:${op.y * s}px;width:${op.w * s}px;height:${op.h * s}px;background:${op.fill};`))
        break
      }
      case 'strokeRect': {
        root.appendChild(el('div',
          `position:absolute;box-sizing:border-box;left:${op.x * s}px;top:${op.y * s}px;width:${op.w * s}px;height:${op.h * s}px;border:${Math.max(1, op.width * s)}px solid ${op.color};`))
        break
      }
      case 'deco': {
        // 自写 HTML 标签底衬（kbd / mark / sub / sup / 自定义标签）
        const radius = Math.min(op.radius ?? 3, (op.w * s) / 2, (op.h * s) / 2)
        const parts = [
          `position:absolute;left:${op.x * s}px;top:${op.y * s}px;width:${op.w * s}px;height:${op.h * s}px;`,
          `border-radius:${radius * s}px;box-sizing:border-box;`,
        ]
        if (op.fill) parts.push(`background:${op.fill};`)
        if (op.stroke) parts.push(`border:${Math.max(0.5, (op.width ?? 1) * s)}px solid ${op.stroke};`)
        root.appendChild(el('div', parts.join('')))
        break
      }
      case 'line': {
        const ln = document.createElementNS(SVG_NS, 'line')
        ln.setAttribute('x1', String(op.x1 * s)); ln.setAttribute('y1', String(op.y1 * s))
        ln.setAttribute('x2', String(op.x2 * s)); ln.setAttribute('y2', String(op.y2 * s))
        ln.setAttribute('stroke', op.color)
        ln.setAttribute('stroke-width', String(Math.max(0.5, op.width * s)))
        svg.appendChild(ln)
        lineCount++
        break
      }
      case 'fragment': {
        const fr = doc.fragments[op.id]
        if (!fr) break
        // 公式矢量：预览直接画同一份 formula 算子，与 PDF 内容流同源
        if (fr.formula) {
          renderFormulaFragment(root, fr, op, s)
          break
        }
        const box = el('div',
          `position:absolute;left:${op.x * s}px;top:${op.y * s}px;width:${op.w * s}px;height:${op.h * s}px;overflow:hidden;`)
        box.dataset.frag = op.id
        const natW = fr.w / PX_TO_PT, natH = fr.h / PX_TO_PT
        const inner = el('div', `position:absolute;left:0;top:0;width:${natW}px;height:${natH}px;transform-origin:0 0;transform:scale(${(op.w * s) / Math.max(1, natW)});`)
        // A 档主路径 offset 为 {0,0}、previewEl 是裁剪好的 <img>，直接铺满；
        // 非零偏移只用于 foreignObject 不可用时退回 DOM 预览的兜底路径。
        const holder = el('div',
          `position:absolute;left:${fr.contentOffset.x}px;top:${fr.contentOffset.y}px;`
          + `width:${fr.contentSize.w}px;height:${fr.contentSize.h}px;`)
        // formula 片段已在上方分支处理；这里 previewEl 必然存在（mermaid / 图片 / 位图兜底）
        const clone = (fr.previewEl as Element | null)?.cloneNode(true) as Element | null
        if (!clone) break
        const own = clone.getAttribute('style') ?? ''
        if (clone instanceof SVGElement || clone instanceof HTMLImageElement) {
          clone.setAttribute('style', `${own};width:100%;height:100%;max-width:none;max-height:none;`)
        } else {
          // KaTeX / raw HTML 保持原本的 inline / block 显示类型 ——
          // 给 inline 元素写 width/height 无效，反而会破坏 vlist 定位。
          clone.setAttribute('style', `${own};max-width:none;max-height:none;`)
        }
        holder.appendChild(clone)
        inner.appendChild(holder)
        box.appendChild(inner)
        root.appendChild(box)
        break
      }
      default: break
    }
  }
  if (lineCount) root.insertBefore(svg, root.firstChild)
  return root
}

/** 整篇渲染到容器（替换内容）。返回耗时 ms，供面板显示。 */
export function renderAllPages(host: HTMLElement, doc: PdfDocument, scale: number): number {
  const t0 = performance.now()
  const frag = document.createDocumentFragment()
  for (let i = 0; i < doc.pages.length; i++) frag.appendChild(renderPageDom(doc, i, scale))
  host.replaceChildren(frag)
  return performance.now() - t0
}

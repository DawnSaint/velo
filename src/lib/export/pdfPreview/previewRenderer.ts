// Display List → DOM 预览。
//
// 与 pdfWriter 消费**同一份** PdfPage.ops：这里把算子绝对定位成 DOM，
// 那里把算子序列化成 PDF 内容流。一致性来源是共享布局树，不是共享慢引擎。
//
// 预览用与 PDF 相同的三套子集字体（@font-face 指向同一批 TTF），因此
// 断行 / 字宽在预览里就能看出来，不需要等导出。

import { ensurePreviewStyles } from './fragmentBuilder'
import { FONT_FAMILY, fontSet, tokensOf } from './tokens'
import { PX_TO_PT, type PdfDocument, type PdfPage } from './types'

const STYLE_ID = 'velo-pdf-font-faces'
let installedSet: object | null = null
const blobUrls: string[] = []

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
  const svgNs = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNs, 'svg')
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
        const ln = document.createElementNS(svgNs, 'line')
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
        const clone = fr.previewEl.cloneNode(true) as Element
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

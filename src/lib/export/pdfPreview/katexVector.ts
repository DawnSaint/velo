// KaTeX 公式 → PDF 矢量内容（真实 DOM 实测提取）。
//
// 与「拿 __renderToDomTree 虚拟树纯 JS 直译」相比，这里不手写 KaTeX 依赖的浏览器
// CSS 排版语义（vlist / 字号级联 / spacing / overflow:hidden）：把 katex.renderToString
// 的结果挂进真实 DOM，让 Chromium / WebKit 自己排，再用 Range + getBoundingClientRect
// 逐字形、逐 SVG、逐边框取坐标。因此 `\left(\right)` 伸缩括号、accent、\overbrace、
// \cancel、\binom 这类几何字形不需要逐命令适配，也不会随 KaTeX 内部实现漂移。
//
// 测量在 `bodyPt × 10` 字号下进行再整体 ÷10：浏览器布局单位是 1/64px，1× 下
// KaTeX 的 `min-height:1px` 之类规则会引入取整误差，放大后折算可忽略。
//
// 输出坐标统一为 pt、y 向上、原点为公式基线左端（与 types.ts 的 FormulaContent 约定）。
// 路径算子只有 m/l/c/h（绝对语义），直接进 PDF 内容流；预览转 SVG path d 时必须翻成大写
// （SVG 小写是相对命令，PDF 没有相对形式，见 previewRenderer.pdfPathOpsToSvg）。

import type { FormulaContent, FontKey, PdfColor } from './types'
import { fontMeta } from './tokens'
import { buildKatexFontSet, type SubsetFont } from './fontSubset'

/** 测量放大倍率：探针字号 = bodyPt × 该值 */
const KATEX_PROBE_SCALE = 10

export interface FormulaBox {
  width: number
  height: number
  depth: number
}

interface RawText {
  char: string
  family: string
  bold: boolean
  x: number
  y: number
  size: number
  color: PdfColor
}

interface RawPath {
  ops: string
  fill?: PdfColor | null
  stroke?: PdfColor | null
  strokeWidth?: number
  clip?: { x: number; y: number; w: number; h: number }
}

interface RawRect {
  x: number
  y: number
  w: number
  h: number
  color: PdfColor
}

export interface RawOps {
  texts: RawText[]
  paths: RawPath[]
  rects: RawRect[]
  /** 遇到不支持的 SVG 形状（circle / use / 带 transform 的 g 等），调用方据此回退位图 */
  unsupported: string[]
}

export interface MeasuredFormula {
  id: string
  kind: 'katex-inline' | 'katex-block'
  tex: string
  box: FormulaBox
  ops: RawOps
}

export interface FinalizedFormula {
  contents: Map<string, FormulaContent>
  fonts: { key: string; meta: SubsetFont['meta']; ttf: Uint8Array }[]
  /** 转换失败（缺字 / 不支持形状）→ 调用方回退位图 */
  failed: Set<string>
  warnings: string[]
}

// ---- 浏览器侧测量 ------------------------------------------------------------

let vectorHost: HTMLDivElement | null = null
/** 离屏测量容器：不用 visibility:hidden —— getComputedStyle 会继承 hidden，提取器会跳过所有内容 */
function measureHost(): HTMLDivElement {
  if (!vectorHost) {
    vectorHost = document.createElement('div')
    vectorHost.style.cssText =
      'position:fixed;left:-100000px;top:0;width:700px;font-size:16px;line-height:1.2;pointer-events:none;'
    vectorHost.setAttribute('aria-hidden', 'true')
    document.body.appendChild(vectorHost)
  }
  return vectorHost
}

let fontsPromise: Promise<void> | null = null
/** 强制解码全部已声明 @font-face（KaTeX 20 个族按需懒加载，不显式 load 会量到 fallback 字宽） */
function ensureFontsLoaded(): Promise<void> {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      try {
        const loads: Promise<unknown>[] = []
        document.fonts.forEach(f => {
          try { loads.push(f.load()) } catch { /* 单个字体失败不阻塞 */ }
        })
        await Promise.allSettled(loads)
        await document.fonts.ready
      } catch { /* 字体 API 不可用时不阻塞，像素裁剪 / 缺字检查仍兜底 */ }
    })()
  }
  return fontsPromise
}

/** 把已渲染好的 .katex 元素放进离屏容器，按 bodyPt 对应的 10× 字号测量，返回 pt 坐标。 */
export async function measureKatexVector(
  el: HTMLElement,
  bodyPt: number,
): Promise<{ box: FormulaBox; ops: RawOps } | null> {
  // 探针字号 = bodyPt × 10（.katex 自身 1.21em → basePt × 10），÷10 后即 pt
  const wrap = document.createElement('div')
  wrap.style.cssText =
    `display:inline-block;font-size:${bodyPt * KATEX_PROBE_SCALE}px;line-height:1.2;`
    + 'white-space:nowrap;color:#333333;'
  wrap.appendChild(el)
  const host = measureHost()
  host.appendChild(wrap)
  try {
    await ensureFontsLoaded()
    return extractKatexDom(wrap, 1 / KATEX_PROBE_SCALE)
  } finally {
    host.removeChild(wrap)
  }
}

/** computed font-family / weight / style → KaTeX 族文件名后缀（Main-Regular 等）。 */
function mapFont(fontFamily: string, fontWeight: string, fontStyle: string): string {
  const first = (fontFamily.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '')
  const bold = fontWeight === 'bold' || parseInt(fontWeight, 10) >= 600
  const italic = fontStyle === 'italic' || fontStyle === 'oblique'
  switch (first) {
    case 'KaTeX_Main':
      if (bold && italic) return 'Main-BoldItalic'
      if (bold) return 'Main-Bold'
      if (italic) return 'Main-Italic'
      return 'Main-Regular'
    case 'KaTeX_Math':
      return bold ? 'Math-BoldItalic' : 'Math-Italic'
    case 'KaTeX_AMS':
      return 'AMS-Regular'
    case 'KaTeX_Caligraphic':
      return bold ? 'Caligraphic-Bold' : 'Caligraphic-Regular'
    case 'KaTeX_Fraktur':
      return bold ? 'Fraktur-Bold' : 'Fraktur-Regular'
    case 'KaTeX_SansSerif':
      // KaTeX 无 SansSerif-BoldItalic，粗斜体兜底 Bold
      if (bold) return 'SansSerif-Bold'
      if (italic) return 'SansSerif-Italic'
      return 'SansSerif-Regular'
    case 'KaTeX_Script':
      return 'Script-Regular'
    case 'KaTeX_Typewriter':
      return 'Typewriter-Regular'
    case 'KaTeX_Size1':
      return 'Size1-Regular'
    case 'KaTeX_Size2':
      return 'Size2-Regular'
    case 'KaTeX_Size3':
      return 'Size3-Regular'
    case 'KaTeX_Size4':
      return 'Size4-Regular'
    default:
      // \text{中文} 这类继承文档字体的内容 → 正文 sans
      return 'body'
  }
}

/** 预览用：族名 → katexCss 已内联的 CSS family / weight / style。 */
export function katexCssFont(key: string): { family: string; weight: number; style: 'normal' | 'italic' } | null {
  const table: Record<string, { family: string; weight: number; style: 'normal' | 'italic' }> = {
    'Main-Regular': { family: 'KaTeX_Main', weight: 400, style: 'normal' },
    'Main-Bold': { family: 'KaTeX_Main', weight: 700, style: 'normal' },
    'Main-Italic': { family: 'KaTeX_Main', weight: 400, style: 'italic' },
    'Main-BoldItalic': { family: 'KaTeX_Main', weight: 700, style: 'italic' },
    'Math-Italic': { family: 'KaTeX_Math', weight: 400, style: 'italic' },
    'Math-BoldItalic': { family: 'KaTeX_Math', weight: 700, style: 'italic' },
    'AMS-Regular': { family: 'KaTeX_AMS', weight: 400, style: 'normal' },
    'Caligraphic-Regular': { family: 'KaTeX_Caligraphic', weight: 400, style: 'normal' },
    'Caligraphic-Bold': { family: 'KaTeX_Caligraphic', weight: 700, style: 'normal' },
    'Fraktur-Regular': { family: 'KaTeX_Fraktur', weight: 400, style: 'normal' },
    'Fraktur-Bold': { family: 'KaTeX_Fraktur', weight: 700, style: 'normal' },
    'SansSerif-Regular': { family: 'KaTeX_SansSerif', weight: 400, style: 'normal' },
    'SansSerif-Bold': { family: 'KaTeX_SansSerif', weight: 700, style: 'normal' },
    'SansSerif-Italic': { family: 'KaTeX_SansSerif', weight: 400, style: 'italic' },
    'Script-Regular': { family: 'KaTeX_Script', weight: 400, style: 'normal' },
    'Typewriter-Regular': { family: 'KaTeX_Typewriter', weight: 400, style: 'normal' },
    'Size1-Regular': { family: 'KaTeX_Size1', weight: 400, style: 'normal' },
    'Size2-Regular': { family: 'KaTeX_Size2', weight: 400, style: 'normal' },
    'Size3-Regular': { family: 'KaTeX_Size3', weight: 400, style: 'normal' },
    'Size4-Regular': { family: 'KaTeX_Size4', weight: 400, style: 'normal' },
  }
  return table[key] ?? null
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString()

function rgbToHex(cssColor: string): PdfColor | null {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(cssColor.trim())
  if (!m) return null
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1
  if (a <= 0.01) return null
  const hex = (n: string) => Math.max(0, Math.min(255, Math.round(parseFloat(n)))).toString(16).padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
}

/** 弧线（SVG A）→ 三次贝塞尔段（PDF 无弧算子）。 */
function arcToCubic(
  x1: number, y1: number, rx: number, ry: number, phi: number,
  large: boolean, sweep: boolean, x2: number, y2: number,
): number[][] {
  if (rx === 0 || ry === 0) return [[x2, y2]]
  const rad = phi * Math.PI / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  let rxx = Math.abs(rx), ryy = Math.abs(ry)
  const lambda = (x1p * x1p) / (rxx * rxx) + (y1p * y1p) / (ryy * ryy)
  if (lambda > 1) { const k = Math.sqrt(lambda); rxx *= k; ryy *= k }
  const numerator = rxx * rxx * ryy * ryy - rxx * rxx * y1p * y1p - ryy * ryy * x1p * x1p
  const den = rxx * rxx * y1p * y1p + ryy * ryy * x1p * x1p
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / (den || 1)))
  const cxp = coef * rxx * y1p / (ryy || 1)
  const cyp = -coef * ryy * x1p / (rxx || 1)
  const cxp0 = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cyp0 = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const theta = ang(1, 0, (x1p - cxp) / rxx, (y1p - cyp) / ryy)
  let delta = ang((x1p - cxp) / rxx, (y1p - cyp) / ryy, (-x1p - cxp) / rxx, (-y1p - cyp) / ryy)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const segments: number[][] = []
  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)))
  for (let i = 0; i < count; i++) {
    const a0 = theta + delta * i / count
    const a1 = theta + delta * (i + 1) / count
    const t = 4 / 3 * Math.tan((a1 - a0) / 4)
    const p = (px: number, py: number) => [cos * px - sin * py + cxp0, sin * px + cos * py + cyp0]
    const e0 = p(rxx * Math.cos(a0), ryy * Math.sin(a0))
    const e1 = p(rxx * Math.cos(a1), ryy * Math.sin(a1))
    const d0 = p(-rxx * t * Math.sin(a0), ryy * t * Math.cos(a0))
    const d1 = p(rxx * t * Math.sin(a1), -ryy * t * Math.cos(a1))
    segments.push([e0[0] + d0[0], e0[1] + d0[1], e1[0] + d1[0], e1[1] + d1[1], e1[0], e1[1]])
  }
  return segments
}

/** SVG path d → PDF 路径算子（含 S/Q/T；相对命令保留相对）。 */
function convertPathD(d: string, fx: (x: number) => number, fy: (y: number) => number): string {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0
  let lastC2: [number, number] | null = null
  let out = ''
  const num = (): number => { const n = Number(tokens[i++]); return Number.isFinite(n) ? n : 0 }
  const abs = (cc: string, nx: number, ny: number): [number, number] =>
    cc === cc.toLowerCase() ? [x + nx, y + ny] : [nx, ny]
  const P = (nx: number, ny: number) => `${f(fx(nx))} ${f(fy(ny))}`
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++]
    const cc = cmd
    switch (cc.toUpperCase()) {
      case 'M': {
        const [nx, ny] = abs(cc, num(), num()); x = nx; y = ny; sx = x; sy = y
        lastC2 = null
        out += `${P(x, y)} m `
        cmd = cc === 'M' ? 'L' : 'l'
        break
      }
      case 'L': { const [nx, ny] = abs(cc, num(), num()); x = nx; y = ny; lastC2 = null; out += `${P(x, y)} l `; break }
      case 'H': { x = cc === 'H' ? num() : x + num(); lastC2 = null; out += `${P(x, y)} l `; break }
      case 'V': { y = cc === 'V' ? num() : y + num(); lastC2 = null; out += `${P(x, y)} l `; break }
      case 'C': {
        const [a, b] = abs(cc, num(), num())
        const [d1, d2] = abs(cc, num(), num())
        const [nx, ny] = abs(cc, num(), num())
        out += `${P(a, b)} ${P(d1, d2)} ${P(nx, ny)} c `
        x = nx; y = ny; lastC2 = [d1, d2]
        break
      }
      case 'S': {
        const [d1, d2] = abs(cc, num(), num())
        const [nx, ny] = abs(cc, num(), num())
        const r: [number, number] = lastC2 ? [2 * x - lastC2[0], 2 * y - lastC2[1]] : [x, y]
        out += `${P(r[0], r[1])} ${P(d1, d2)} ${P(nx, ny)} c `
        x = nx; y = ny; lastC2 = [d1, d2]
        break
      }
      case 'Q': {
        const [cx, cy] = abs(cc, num(), num())
        const [nx, ny] = abs(cc, num(), num())
        const c1x = x + (2 / 3) * (cx - x), c1y = y + (2 / 3) * (cy - y)
        const c2x = nx + (2 / 3) * (cx - nx), c2y = ny + (2 / 3) * (cy - ny)
        out += `${P(c1x, c1y)} ${P(c2x, c2y)} ${P(nx, ny)} c `
        x = nx; y = ny; lastC2 = [cx, cy]
        break
      }
      case 'T': {
        const [nx, ny] = abs(cc, num(), num())
        const [cx, cy]: [number, number] = lastC2 ? [2 * x - lastC2[0], 2 * y - lastC2[1]] : [x, y]
        const c1x = x + (2 / 3) * (cx - x), c1y = y + (2 / 3) * (cy - y)
        const c2x = nx + (2 / 3) * (cx - nx), c2y = ny + (2 / 3) * (cy - ny)
        out += `${P(c1x, c1y)} ${P(c2x, c2y)} ${P(nx, ny)} c `
        x = nx; y = ny; lastC2 = [cx, cy]
        break
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0
        const [nx, ny] = abs(cc, num(), num())
        for (const seg of arcToCubic(x, y, rx, ry, rot, large, sweep, nx, ny)) {
          out += `${P(seg[0], seg[1])} ${P(seg[2], seg[3])} ${P(seg[4], seg[5])} c `
        }
        x = nx; y = ny; lastC2 = null
        break
      }
      case 'Z': out += 'h '; x = sx; y = sy; lastC2 = null; break
      default: i++
    }
  }
  return out
}

/**
 * 遍历 `.katex-html` 提取文本 / SVG / 边框三类图元。
 * @param wrapEl 包裹 `.katex` / `.katex-display` 的容器
 * @param pxToPt 测量 px → pt 的折算（1 / KATEX_PROBE_SCALE）
 */
function extractKatexDom(
  wrapEl: HTMLElement,
  pxToPt: number,
): { box: FormulaBox; ops: RawOps } | null {
  const texts: RawText[] = []
  const paths: RawPath[] = []
  const rects: RawRect[] = []
  const unsupported: string[] = []

  const katexHtml = wrapEl.querySelector('.katex-html') as HTMLElement | null
  if (!katexHtml) return null

  // 公式外盒与主基线：在首个 .katex-base 内插 0×0 inline-block 探针取 alphabetic baseline
  const katexEl = (wrapEl.querySelector('.katex') as HTMLElement | null) ?? katexHtml
  const katexRect = katexEl.getBoundingClientRect()
  const firstBase = (katexHtml.querySelector('.katex-base') as HTMLElement | null) ?? katexHtml
  const rootProbe = document.createElement('span')
  rootProbe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;'
  firstBase.appendChild(rootProbe)
  const baseY = rootProbe.getBoundingClientRect().bottom
  firstBase.removeChild(rootProbe)

  const ptX = (px: number): number => (px - katexRect.left) * pxToPt
  const ptY = (px: number): number => (baseY - px) * pxToPt

  /** SVG 的祖先 overflow:hidden / clip 盒（hide-tail 等），转成基线系裁剪矩形 */
  const findClip = (el: Element): { x: number; y: number; w: number; h: number } | undefined => {
    let cur: Element | null = el.parentElement
    let left = -Infinity, top = -Infinity, right = Infinity, bottom = Infinity
    let clipped = false
    while (cur && cur !== katexHtml && cur !== wrapEl) {
      const cs = getComputedStyle(cur)
      if (cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden') {
        const r = cur.getBoundingClientRect()
        left = Math.max(left, r.left)
        top = Math.max(top, r.top)
        right = Math.min(right, r.right)
        bottom = Math.min(bottom, r.bottom)
        clipped = true
      }
      cur = cur.parentElement
    }
    if (!clipped) return undefined
    const w = Math.max(0, right - left) * pxToPt
    const h = Math.max(0, bottom - top) * pxToPt
    return { x: ptX(left), y: ptY(bottom), w, h }
  }

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? ''
      if (!raw || /^[\u200b\ufeff\s]*$/.test(raw)) return
      const parent = node.parentElement
      if (!parent) return
      const cs = getComputedStyle(parent)
      const color = rgbToHex(cs.color) ?? '#000000'
      const family = mapFont(cs.fontFamily, cs.fontWeight, cs.fontStyle)
      const bold = cs.fontWeight === 'bold' || parseInt(cs.fontWeight, 10) >= 600
      const size = parseFloat(cs.fontSize) * pxToPt

      // 0×0 inline-block 探针：父行盒的 CSS alphabetic baseline
      const probe = document.createElement('span')
      probe.style.cssText = 'display:inline-block;width:0;height:0;overflow:hidden;vertical-align:baseline;'
      parent.insertBefore(probe, node.nextSibling)
      const y = ptY(probe.getBoundingClientRect().bottom)
      parent.removeChild(probe)

      const range = document.createRange()
      let offset = 0
      for (const ch of raw) {
        const len = ch.length
        if (!/^[\u200b\ufeff\s]$/.test(ch)) {
          range.setStart(node, offset)
          range.setEnd(node, offset + len)
          const r = range.getBoundingClientRect()
          texts.push({ char: ch, family, bold, x: ptX(r.left), y, size, color })
        }
        offset += len
      }
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as Element
    const cls = el.classList
    if (cls.contains('katex-mathml') || cls.contains('vlist-s') || cls.contains('katex-strut') || cls.contains('pstrut')) return
    const cs = getComputedStyle(el)
    if (cs.display === 'none') return

    if (el.tagName.toLowerCase() === 'svg') {
      const svg = el as SVGSVGElement
      const svgRect = svg.getBoundingClientRect()
      if (svgRect.width <= 0 || svgRect.height <= 0) return
      const clip = findClip(svg)
      const vbAttr = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
      const vbX = vbAttr.length === 4 && Number.isFinite(vbAttr[0]) ? vbAttr[0] : 0
      const vbY = vbAttr.length === 4 && Number.isFinite(vbAttr[1]) ? vbAttr[1] : 0
      const vbW = vbAttr.length === 4 && vbAttr[2] > 0 ? vbAttr[2] : svgRect.width
      const vbH = vbAttr.length === 4 && vbAttr[3] > 0 ? vbAttr[3] : svgRect.height
      const pa = (svg.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').trim()

      let sx = svgRect.width / vbW
      let sy = svgRect.height / vbH
      let oxPx = svgRect.left - vbX * sx
      let oyPx = svgRect.top - vbY * sy
      if (pa !== 'none') {
        const parts = pa.split(/\s+/)
        const align = parts[0] || 'xMidYMid'
        const meetOrSlice = parts[1] || 'meet'
        const s = meetOrSlice === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy)
        sx = s
        sy = s
        const extraW = svgRect.width - vbW * s
        const extraH = svgRect.height - vbH * s
        const ax = align.startsWith('xMax') ? 1 : align.startsWith('xMid') ? 0.5 : 0
        const ay = align.endsWith('YMax') ? 1 : align.endsWith('YMid') ? 0.5 : 0
        oxPx = svgRect.left + extraW * ax - vbX * s
        oyPx = svgRect.top + extraH * ay - vbY * s
      }

      const fx = (vx: number): number => ptX(oxPx + vx * sx)
      const fy = (vy: number): number => ptY(oyPx + vy * sy)

      for (const child of svg.querySelectorAll('*')) {
        const tag = child.tagName.toLowerCase()
        if (tag === 'g' && child.getAttribute('transform')) unsupported.push('svg:g[transform]')
        else if (!['path', 'line', 'rect', 'g', 'defs', 'title', 'desc'].includes(tag)) {
          unsupported.push(`svg:${tag}`)
        }
      }

      for (const child of svg.querySelectorAll('path, line, rect')) {
        const ccs = getComputedStyle(child)
        const fill = rgbToHex(ccs.fill) ?? undefined
        const stroke = rgbToHex(ccs.stroke) ?? undefined
        const strokeWidth = stroke ? Math.max(0.2, parseFloat(ccs.strokeWidth || '1') * sx * pxToPt) : undefined
        const tag = child.tagName.toLowerCase()
        if (tag === 'path') {
          const d = child.getAttribute('d') ?? ''
          if (d) paths.push({ ops: convertPathD(d, fx, fy), fill, stroke, strokeWidth, clip })
        } else if (tag === 'line') {
          const x1 = parseFloat(child.getAttribute('x1') ?? '0')
          const y1 = parseFloat(child.getAttribute('y1') ?? '0')
          const x2 = parseFloat(child.getAttribute('x2') ?? '0')
          const y2 = parseFloat(child.getAttribute('y2') ?? '0')
          paths.push({
            ops: `${f(fx(x1))} ${f(fy(y1))} m ${f(fx(x2))} ${f(fy(y2))} l `,
            stroke: stroke ?? rgbToHex(ccs.color) ?? '#000000',
            strokeWidth: strokeWidth ?? 0.5,
            clip,
          })
        } else {
          const rx = parseFloat(child.getAttribute('x') ?? '0')
          const ry = parseFloat(child.getAttribute('y') ?? '0')
          const rw = parseFloat(child.getAttribute('width') ?? '0')
          const rh = parseFloat(child.getAttribute('height') ?? '0')
          const x0 = fx(rx), x1 = fx(rx + rw), y0 = fy(ry + rh), y1 = fy(ry)
          paths.push({
            ops: `${f(x0)} ${f(y0)} m ${f(x1)} ${f(y0)} l ${f(x1)} ${f(y1)} l ${f(x0)} ${f(y1)} l h `,
            fill, stroke, strokeWidth, clip,
          })
        }
      }
      return
    }

    // HTML 元素的背景色与四边 border（frac-line / overline-line / hline / rule / colorbox）
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 || rect.height > 0) {
      const bg = rgbToHex(cs.backgroundColor)
      if (bg && rect.width > 0 && rect.height > 0) {
        rects.push({ x: ptX(rect.left), y: ptY(rect.bottom), w: rect.width * pxToPt, h: rect.height * pxToPt, color: bg })
      }
      const addBorder = (wStr: string, styleStr: string, colorStr: string, xPx: number, yBottomPx: number, wPx: number, hPx: number): void => {
        const bw = parseFloat(wStr)
        if (!(bw > 0) || styleStr === 'none') return
        const c = rgbToHex(colorStr)
        if (!c || wPx <= 0 || hPx <= 0) return
        rects.push({ x: ptX(xPx), y: ptY(yBottomPx), w: wPx * pxToPt, h: hPx * pxToPt, color: c })
      }
      const bB = parseFloat(cs.borderBottomWidth) || 0
      const bT = parseFloat(cs.borderTopWidth) || 0
      const bL = parseFloat(cs.borderLeftWidth) || 0
      const bR = parseFloat(cs.borderRightWidth) || 0
      if (bB > 0) addBorder(cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor, rect.left, rect.bottom, rect.width, bB)
      if (bT > 0) addBorder(cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor, rect.left, rect.top + bT, rect.width, bT)
      if (bL > 0) addBorder(cs.borderLeftWidth, cs.borderLeftStyle, cs.borderLeftColor, rect.left, rect.bottom, bL, rect.height)
      if (bR > 0) addBorder(cs.borderRightWidth, cs.borderRightStyle, cs.borderRightColor, rect.right - bR, rect.bottom, bR, rect.height)
    }

    for (const child of el.childNodes) walk(child)
  }

  walk(katexHtml)

  return {
    box: {
      width: katexRect.width * pxToPt,
      height: Math.max(0, (baseY - katexRect.top) * pxToPt),
      depth: Math.max(0, (katexRect.bottom - baseY) * pxToPt),
    },
    ops: { texts, paths, rects, unsupported },
  }
}

// ---- 解析 gid（构建期一次性，字体子集同时生成）------------------------------

interface ResolvedGlyph {
  font: string
  gid: number
}

/**
 * 把一批实测公式落成最终矢量内容：收集各 KaTeX 族字符集 → 运行时子集化 → 解析 gid。
 * 缺字 / 含不支持形状的公式进 `failed`，由调用方回退位图（与 mermaid 双编码器同策略）。
 */
export async function finalizeFormulaVector(items: MeasuredFormula[]): Promise<FinalizedFormula> {
  const warnings: string[] = []
  const failed = new Set<string>()
  const contents = new Map<string, FormulaContent>()

  if (!items.length) return { contents, fonts: [], failed, warnings }

  const charsetByFamily: Record<string, Set<string>> = {}
  for (const item of items) {
    for (const t of item.ops.texts) {
      if (t.family === 'body') continue
      ;(charsetByFamily[t.family] ??= new Set()).add(t.char)
    }
  }

  let katexFonts: Record<string, SubsetFont> = {}
  try {
    const input: Record<string, string> = {}
    for (const [family, set] of Object.entries(charsetByFamily)) input[family] = [...set].join('')
    katexFonts = await buildKatexFontSet(input)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    for (const item of items) failed.add(item.id)
    return { contents, fonts: [], failed, warnings: [`公式矢量字体子集化失败，已回退位图: ${msg}`] }
  }

  const bodyMeta = fontMeta()
  const resolveBody = (ch: string, bold: boolean): ResolvedGlyph | null => {
    const order: FontKey[] = bold ? ['bold', 'sans', 'mono'] : ['sans', 'bold', 'mono']
    for (const key of order) {
      const hit = bodyMeta[key].chars[ch]
      if (hit) return { font: key, gid: hit[0] }
    }
    return null
  }
  const resolveKatex = (family: string, ch: string, bold: boolean): ResolvedGlyph | null => {
    const direct = katexFonts[family]?.meta.chars[ch]
    if (direct) return { font: family, gid: direct[0] }
    // 少数符号在不同族间同形（如 Main-Regular 的备用字形），再退 Main-Regular
    const main = katexFonts['Main-Regular']?.meta.chars[ch]
    if (main) return { font: 'Main-Regular', gid: main[0] }
    // `\text{中文}` 这类被分到 KaTeX_Main 但没有对应字形的字符：
    // 浏览器侧会落到系统 serif，PDF 无相同回退字体，用正文 sans 保内容不丢
    return resolveBody(ch, bold)
  }

  for (const item of items) {
    const missing: string[] = []
    const texts: FormulaContent['texts'] = []
    for (const t of item.ops.texts) {
      const hit = t.family === 'body'
        ? resolveBody(t.char, t.bold)
        : resolveKatex(t.family, t.char, t.bold)
      if (!hit) {
        missing.push(`${t.family}:${t.char}`)
        continue
      }
      texts.push({ ch: t.char, font: hit.font, gid: hit.gid, x: t.x, y: t.y, size: t.size, color: t.color })
    }
    if (missing.length) {
      failed.add(item.id)
      warnings.push(`公式矢量缺字，已回退位图（${missing.slice(0, 6).join(' ')}）: ${item.tex.slice(0, 40)}`)
      continue
    }
    if (item.ops.unsupported.length) {
      failed.add(item.id)
      warnings.push(`公式含未适配形状，已回退位图（${[...new Set(item.ops.unsupported)].slice(0, 4).join(' ')}）: ${item.tex.slice(0, 40)}`)
      continue
    }
    contents.set(item.id, {
      width: item.box.width,
      height: item.box.height,
      depth: item.box.depth,
      texts,
      paths: item.ops.paths,
      rects: item.ops.rects,
    })
  }

  return {
    contents,
    fonts: Object.entries(katexFonts).map(([key, sub]) => ({ key, meta: sub.meta, ttf: sub.ttf })),
    failed,
    warnings,
  }
}

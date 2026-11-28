// B 档：pele / mermaid SVG → PDF 矢量内容流。
//
// 不是通用 SVG 引擎，只覆盖 Velo 图表实际用到的方言（实测 sample.md 的 3 个图）：
// svg/g/path/rect/text/tspan、M/L/C/A/Z、translate、fill/stroke/rx、text-anchor、
// CSS 变量着色。不支持的元素收进 warnings 由调用方决定是否降级回位图。
//
// 坐标系：输出内容流已经是 **y 向上的 PDF 用户坐标**（在 viewBox 内），
// 即每个 SVG y 都在转换时做 `y' = height + minY - y` 翻转。PdfWriter 只需包一层
// 正缩放 `q sx 0 0 sy x y cm ... Q`，不需要负 d —— 负 d 会把文字整体镜像，
// 这是 SVG→PDF 最容易踩的坑。

import { FONT_RES, colorToRgb, encodeGidsHex, encodeMixed, measureMixed, type Tokens } from './tokens'

export interface SvgToPdfResult {
  pdf: string
  /** viewBox 尺寸（SVG 用户单位），PdfWriter 用它算缩放 */
  width: number
  height: number
  warnings: string[]
}

interface State {
  fill: string | null
  stroke: string | null
  strokeWidth: number
  fontSize: number
  fontWeight: number
  textAnchor: 'start' | 'middle' | 'end'
}

const DEFAULT_STATE: State = {
  fill: '#1f1f1f', stroke: null, strokeWidth: 1,
  fontSize: 12, fontWeight: 400, textAnchor: 'start',
}

const f = (n: number): string => (Math.round(n * 100) / 100).toString()

/** pele 用 CSS 变量着色，PDF 不解析 var()；按 SVG 内的 fallback 静态展开。 */
function expandVars(svg: string): string {
  const vars: Record<string, string> = {}
  const rootStyle = /<svg[^>]*style="([^"]*)"/i.exec(svg)?.[1] ?? ''
  for (const m of rootStyle.matchAll(/--(_[\w-]+)\s*:\s*var\(--[\w-]+\s*,\s*([^)]+)\)/g)) {
    vars[m[1]] = m[2].trim()
  }
  for (const m of rootStyle.matchAll(/--(_[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!(m[1] in vars) && !m[2].includes('var(')) vars[m[1]] = m[2].trim()
  }
  let s = svg.replace(/var\(--(_[\w-]+)(?:\s*,\s*([^)]+))?\)/g, (_a, name, fb) => vars[name] || fb || '#1f1f1f')
  s = s.replace(/var\(--[\w-]+\s*,\s*([^)]+)\)/g, '$1')
  return s
}

// ---- SVG arc → 三次贝塞尔（PDF 没有弧线算子）--------------------------------
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
  const num = rxx * rxx * ryy * ryy - rxx * rxx * y1p * y1p - ryy * ryy * x1p * x1p
  const den = rxx * rxx * y1p * y1p + ryy * ryy * x1p * x1p
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (den || 1)))
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
    const p = (x: number, y: number) => [
      cos * x - sin * y + cxp0,
      sin * x + cos * y + cyp0,
    ]
    const e0 = p(rxx * Math.cos(a0), ryy * Math.sin(a0))
    const e1 = p(rxx * Math.cos(a1), ryy * Math.sin(a1))
    const d0 = p(-rxx * t * Math.sin(a0), ryy * t * Math.cos(a0))
    const d1 = p(rxx * t * Math.sin(a1), -ryy * t * Math.cos(a1))
    segments.push([
      e0[0] + d0[0], e0[1] + d0[1],
      e1[0] + d1[0], e1[1] + d1[1],
      e1[0], e1[1],
    ])
  }
  return segments
}

interface Coord { fx: (x: number) => number; fy: (y: number) => number }

/** d 属性 → PDF 路径算子（不含 fill/stroke 结束符），所有 y 已经翻转。 */
function pathOps(d: string, c: Coord): string {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0
  let out = ''
  const num = () => Number(tokens[i++])
  const abs = (cc: string, nx: number, ny: number): [number, number] =>
    cc === cc.toLowerCase() ? [x + nx, y + ny] : [nx, ny]
  const P = (nx: number, ny: number) => `${f(c.fx(nx))} ${f(c.fy(ny))}`
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++]
    const cc = cmd
    switch (cc.toUpperCase()) {
      case 'M': {
        const [nx, ny] = abs(cc, num(), num()); x = nx; y = ny; sx = x; sy = y
        out += `${P(x, y)} m `
        cmd = cc === 'M' ? 'L' : 'l'
        break
      }
      case 'L': { const [nx, ny] = abs(cc, num(), num()); x = nx; y = ny; out += `${P(x, y)} l `; break }
      case 'H': { const nx = cc === 'H' ? num() : x + num(); x = nx; out += `${P(x, y)} l `; break }
      case 'V': { const ny = cc === 'V' ? num() : y + num(); y = ny; out += `${P(x, y)} l `; break }
      case 'C': {
        const [a, b] = abs(cc, num(), num())
        const [d1, d2] = abs(cc, num(), num())
        const [nx, ny] = abs(cc, num(), num())
        out += `${P(a, b)} ${P(d1, d2)} ${P(nx, ny)} c `
        x = nx; y = ny
        break
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0
        const [nx, ny] = abs(cc, num(), num())
        for (const seg of arcToCubic(x, y, rx, ry, rot, large, sweep, nx, ny)) {
          // seg = [x1,y1,x2,y2,x3,y3]，逐点翻 y（几何反射，不改变填充结果）
          out += `${P(seg[0], seg[1])} ${P(seg[2], seg[3])} ${P(seg[4], seg[5])} c `
        }
        x = nx; y = ny
        break
      }
      case 'Z': out += 'h '; x = sx; y = sy; break
      default: i++ // 未知命令：跳过一个 token，避免死循环
    }
  }
  return out
}

/** 圆角矩形，直接在翻转后的坐标系里画（T = 上边，B = 下边）。 */
function roundedRect(x: number, y: number, w: number, h: number, rx: number, c: Coord): string {
  const r = Math.max(0, Math.min(rx, w / 2, h / 2))
  const L = c.fx(x), R = c.fx(x + w), T = c.fy(y), B = c.fy(y + h)
  if (r === 0) return `${f(L)} ${f(B)} ${f(w)} ${f(h)} re `
  const k = 0.5523 * r
  return [
    `${f(L + r)} ${f(T)} m `,
    `${f(R - r)} ${f(T)} l `,
    `${f(R - r + k)} ${f(T)} ${f(R)} ${f(T - r + k)} ${f(R)} ${f(T - r)} c `,
    `${f(R)} ${f(B + r)} l `,
    `${f(R)} ${f(B + r - k)} ${f(R - r + k)} ${f(B)} ${f(R - r)} ${f(B)} c `,
    `${f(L + r)} ${f(B)} l `,
    `${f(L + r - k)} ${f(B)} ${f(L)} ${f(B + r - k)} ${f(L)} ${f(B + r)} c `,
    `${f(L)} ${f(T - r)} l `,
    `${f(L)} ${f(T - r + k)} ${f(L + r - k)} ${f(T)} ${f(L + r)} ${f(T)} c `,
    'h ',
  ].join('')
}

function stateOf(el: Element, parent: State): State {
  const s: State = { ...parent }
  const fill = el.getAttribute('fill')
  if (fill !== null) s.fill = fill === 'none' ? null : (fill.startsWith('#') || fill.startsWith('rgb') ? fill : s.fill)
  const stroke = el.getAttribute('stroke')
  if (stroke !== null) s.stroke = stroke === 'none' ? null : stroke
  const sw = el.getAttribute('stroke-width')
  if (sw) s.strokeWidth = parseFloat(sw) || s.strokeWidth
  const fs = el.getAttribute('font-size')
  if (fs) s.fontSize = parseFloat(fs) || s.fontSize
  const fw = el.getAttribute('font-weight')
  if (fw) s.fontWeight = parseInt(fw, 10) || (fw === 'bold' ? 700 : s.fontWeight)
  const ta = el.getAttribute('text-anchor')
  if (ta === 'middle' || ta === 'end' || ta === 'start') s.textAnchor = ta
  const style = el.getAttribute('style')
  if (style) {
    const inlineFill = /fill:\s*(#[0-9a-f]{3,8}|rgb\([^)]*\)|none)/i.exec(style)?.[1]
    if (inlineFill) s.fill = inlineFill === 'none' ? null : inlineFill
    const inlineStroke = /stroke:\s*(#[0-9a-f]{3,8}|rgb\([^)]*\)|none)/i.exec(style)?.[1]
    if (inlineStroke) s.stroke = inlineStroke === 'none' ? null : inlineStroke
    const inlineFs = /(?:font-size|font)\s*:\s*([\d.]+)px/i.exec(style)?.[1]
    if (inlineFs) s.fontSize = parseFloat(inlineFs)
  }
  return s
}

function colorOf(value: string | null, fallback: string): string | null {
  if (value === null || value === 'none') return null
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) || /^rgba?\(/i.test(value)) return value
  return fallback
}

/**
 * SVG 字符串 → PDF 内容流。返回的 pdf 是「viewBox 内、y 向上」的用户坐标，
 * 由 PdfWriter 包一层正缩放 cm。图内文字走 PDF text 算子 + 子集字体 + ToUnicode，
 * 因此在最终 PDF 里可选中 / 可搜索（不是 path outline）。
 */
export function svgToPdf(svgSource: string, tokens: Tokens): SvgToPdfResult {
  const warnings: string[] = []
  const svg = expandVars(svgSource)
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName === 'parsererror') {
    return { pdf: '', width: 0, height: 0, warnings: ['SVG 解析失败'] }
  }
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const hasViewBox = vb.length === 4 && vb.every(n => Number.isFinite(n))
  const minX = hasViewBox ? vb[0] : 0
  const minY = hasViewBox ? vb[1] : 0
  const width = hasViewBox ? vb[2] : parseFloat(root.getAttribute('width') ?? '300') || 300
  const height = hasViewBox ? vb[3] : parseFloat(root.getAttribute('height') ?? '150') || 150
  const coord: Coord = {
    fx: x => x - minX,
    fy: y => height + minY - y,
  }

  let out = ''
  const walk = (el: Element, parent: State): void => {
    const st = stateOf(el, parent)
    const tag = el.localName.toLowerCase()
    const transform = el.getAttribute('transform')
    const tx = /translate\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/.exec(transform ?? '')
    // 翻转后的坐标系里，SVG 的「向下平移 ty」等价于 PDF 的 -ty
    if (tx) out += `q 1 0 0 1 ${f(Number(tx[1]))} ${f(-Number(tx[2]))} cm\n`

    if (tag === 'path') {
      const d = el.getAttribute('d') ?? ''
      const ops = pathOps(d, coord)
      if (ops) {
        const fill = colorOf(st.fill, tokens.ink)
        const stroke = colorOf(st.stroke, '')
        if (fill) out += `${colorToRgb(fill)} rg\n`
        if (stroke) out += `${colorToRgb(stroke)} RG\n${f(st.strokeWidth)} w\n`
        out += ops
        if (fill && stroke) out += 'B\n'
        else if (fill) out += 'f\n'
        else if (stroke) out += 'S\n'
        else out += 'n\n'
      }
    } else if (tag === 'rect') {
      const x = parseFloat(el.getAttribute('x') ?? '0') || 0
      const y = parseFloat(el.getAttribute('y') ?? '0') || 0
      const w = parseFloat(el.getAttribute('width') ?? '0') || 0
      const h = parseFloat(el.getAttribute('height') ?? '0') || 0
      const styleRx = /rx:\s*([\d.]+)/.exec(el.getAttribute('style') ?? '')?.[1]
      const rx = parseFloat(el.getAttribute('rx') ?? styleRx ?? '0') || 0
      const fill = colorOf(st.fill, tokens.ink)
      const stroke = colorOf(st.stroke, '')
      if (fill) out += `${colorToRgb(fill)} rg\n`
      if (stroke) out += `${colorToRgb(stroke)} RG\n${f(st.strokeWidth)} w\n`
      out += roundedRect(x, y, w, h, rx, coord)
      if (fill && stroke) out += 'B\n'
      else if (fill) out += 'f\n'
      else if (stroke) out += 'S\n'
      else out += 'n\n'
    } else if (tag === 'text') {
      // pele 把标题写进 <tspan x y>（<text> 自身没有坐标），饼图标题 / 图例
      // 都靠 tspan 定位；逐 tspan 出文字算子才能落在正确位置。
      const tspans = Array.from(el.children).filter(c => c.localName.toLowerCase() === 'tspan')
      const parts = (tspans.length ? tspans : [el]).map(node => ({
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
        x: parseFloat(node.getAttribute('x') ?? el.getAttribute('x') ?? '0') || 0,
        y: parseFloat(node.getAttribute('y') ?? el.getAttribute('y') ?? '0') || 0,
        anchor: (node.getAttribute('text-anchor') as State['textAnchor']) || st.textAnchor,
      }))
      for (const part of parts) {
        if (!part.text) continue
        const size = st.fontSize
        const font: 'sans' | 'bold' = st.fontWeight >= 600 ? 'bold' : 'sans'
        const w = measureMixed(part.text, font, size)
        let x = part.x
        if (part.anchor === 'middle') x -= w / 2
        else if (part.anchor === 'end') x -= w
        const fill = colorOf(st.fill, tokens.ink) ?? tokens.ink
        let cx = x
        for (const run of encodeMixed(part.text, font)) {
          const hex = encodeGidsHex(run.font, run.gids)
          if (hex) {
            out += `${colorToRgb(fill)} rg\nBT /${FONT_RES[run.font]} ${f(size)} Tf 1 0 0 1 ${f(cx - minX)} ${f(coord.fy(part.y))} Tm <${hex}> Tj ET\n`
          }
          cx += run.units / 1000 * size
        }
      }
    } else if (!['svg', 'g', 'tspan', 'defs', 'title', 'desc'].includes(tag)) {
      warnings.push(`SVG 元素未适配: ${tag}`)
    }

    if (tag !== 'text' && tag !== 'path' && tag !== 'rect') {
      for (const child of Array.from(el.children)) walk(child, st)
    }
    if (tx) out += 'Q\n'
  }

  walk(root, DEFAULT_STATE)
  return { pdf: out, width, height, warnings }
}

// 富片段构建：把「轻量布局器画不了」的内容变成 RichFragment。
//
// 三条通路（对应调研文档 §4A.5 的 A / B / C 档）：
//   - **B 档**：mermaid / pele SVG → svgToPdf 生成矢量内容流，图内文字仍是
//     PDF text 算子（可选中 / 可搜索），不是路径轮廓。
//   - **C 档**：shiki 代码块不走片段，layoutEngine 直接按 token 颜色出 TextOp，
//     文本层 100% 保留；图片走 /Image XObject。
//   - **A 档**：KaTeX、块级 raw HTML 走 foreignObject 位图，构建时一次性做
//     「宽松画布 → 像素裁剪」；previewEl 与 image 是同一张 JPEG，预览与导出
//     不可能再各自裁掉不同部分。
//
// B 档 / 图片仍用真实 DOM / SVG 作 previewEl；A 档用位图 <img> 保证同源。

import type { Root } from 'mdast'
import { convertFileSrc } from '@tauri-apps/api/core'
import { renderKatexHtml } from '../katexHtml'
import { renderMermaidSvg } from '../mermaidHtml'
import { rasterizeSvgToPngDataUri, PELE_LIGHT_VARS } from '../svgRaster'
import { sanitizeHtml } from '../sanitizeHtml'
import { loadKatexCssWithFontsInlined } from '../katexCss'
import { resolveImageAssetAbsPath, extFromFileName, extToMime } from '@/utils/imagePath'
import { readFile } from '@/tauri/fs'
import { svgToPdf } from './svgToPdf'
import { finalizeFormulaVector, measureKatexVector, type MeasuredFormula } from './katexVector'
import editorCss from '../exportStyles.scss?inline'
import type { FragmentImage, PdfLayoutOptions, PdfSource, RichFragment } from './types'
import { PX_TO_PT } from './types'
import { tokensOf, type FormulaFontEntry, type Tokens } from './tokens'

export interface FragmentBuild {
  fragments: Record<string, RichFragment>
  /** mdast 节点对象 → fragment id（同一棵树，布局时用对象身份查表） */
  byNode: WeakMap<object, string>
  warnings: string[]
  /** 公式矢量用到的 KaTeX 子集族；index.ts 随文档缓存并 install 给 pdfWriter */
  formulaFonts: FormulaFontEntry[]
}

interface Found { node: any; kind: 'katex-inline' | 'katex-block' | 'mermaid' | 'image' | 'raw-html' }

/** 遍历 mdast，找出需要富片段的节点。blockContext 区分块级 / 行内 html。 */
function findNodes(nodes: any[], blockContext: boolean, out: Found[]): void {
  for (const n of nodes ?? []) {
    if (!n || typeof n !== 'object') continue
    switch (n.type) {
      case 'inlineMath': out.push({ node: n, kind: 'katex-inline' }); break
      case 'math': out.push({ node: n, kind: 'katex-block' }); break
      case 'image': out.push({ node: n, kind: 'image' }); break
      case 'code':
        if (String(n.lang ?? '').toLowerCase() === 'mermaid') out.push({ node: n, kind: 'mermaid' })
        break
      case 'html': {
        // preserveEmptyLine 会在每个空行处注入块级 `<br />` 占位节点，
        // 它不是用户内容，不能光栅化成一张 700px 位图。
        const v = String(n.value ?? '').trim()
        if (blockContext && v && !/^<br\s*\/?>$/i.test(v)) out.push({ node: n, kind: 'raw-html' })
        break
      }
      default: break
    }
    if (Array.isArray(n.children)) {
      // 只有这些「块容器」的直接 html 子节点才是块级 raw HTML。
      // 表格单元格 / 列表项首段里的 <kbd>、<sub> 等是行内 html，不能当片段
      // （否则每个 <kbd> 都会被光栅化成一整张 700px 位图）。
      const blockParent = ['blockquote', 'alert', 'listItem', 'footnoteDefinition'].includes(n.type)
      findNodes(n.children, blockContext && blockParent, out)
    }
  }
}

// ---- 通用浏览器侧工具 --------------------------------------------------------

let katexCssPromise: Promise<string> | null = null
/** KaTeX CSS（含 base64 内联字体）注入 <head> 一次，预览与光栅化共用。 */
export function ensurePreviewStyles(): Promise<string> {
  if (!katexCssPromise) {
    katexCssPromise = loadKatexCssWithFontsInlined().then(async css => {
      if (!document.getElementById('velo-pdf-katex-css')) {
        const style = document.createElement('style')
        style.id = 'velo-pdf-katex-css'
        style.textContent = css
        document.head.appendChild(style)
      }
      // @font-face 是 base64 data URI，注入后仍需一次解码才可用。不等待会让
      // 光栅化落到 fallback serif（公式变形、字宽偏差），显式 load 常用字体族。
      try {
        await Promise.all([
          'KaTeX_Main', 'KaTeX_Math', 'KaTeX_AMS',
          'KaTeX_Size1', 'KaTeX_Size2', 'KaTeX_Size3', 'KaTeX_Size4',
        ].map(family => document.fonts.load(`16px "${family}"`)))
        await document.fonts.ready
      } catch { /* 字体 API 不可用时不阻塞，像素裁剪仍会兜住尺寸 */ }
      return css
    })
  }
  return katexCssPromise
}

let measureHost: HTMLDivElement | null = null
function host(): HTMLDivElement {
  if (!measureHost) {
    measureHost = document.createElement('div')
    measureHost.style.cssText = 'position:fixed;left:-100000px;top:0;width:700px;font-size:16px;line-height:1.4;visibility:hidden;pointer-events:none;'
    measureHost.className = 'velo-editor velo-pdf-measure'
    document.body.appendChild(measureHost)
  }
  return measureHost
}

/** 返回真正的内容元素（不是测量用的外层 wrapper div，否则宽度恒为容器宽）。 */
function elementFromHtml(html: string): Element {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const wrapper = doc.body.firstElementChild
  return wrapper?.firstElementChild ?? wrapper ?? doc.body
}

/**
 * 只量元素自身在测量容器里的布局尺寸，作为宽松画布的基准。
 *
 * 不再试图用「后代 getBoundingClientRect 并集」推断视觉盒：KaTeX 的
 * .pstrut / .strut 是零宽零高却落在 top:-40~-60px 的纯布局撑杆，隐藏
 * MathML 与 SVG <path> 又各自带回几千 px 的假矩形；还有 base64 字体异步
 * 加载，测量瞬间量到的是 fallback 字宽（实测 69.7px vs 真实 74px）。
 * 这几类误差叠加，正是「预览 / 导出各自裁掉不同部分」的根因。
 * 现在尺寸一律由**真实渲染像素**裁剪得出，见 rasterizeTrimmed。
 */
function measureOwn(el: Element): { w: number; h: number } {
  const hostEl = host()
  const probe = el.cloneNode(true) as Element
  hostEl.appendChild(probe)
  const r = probe.getBoundingClientRect()
  hostEl.removeChild(probe)
  return { w: Math.max(1, r.width), h: Math.max(1, r.height) }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片加载失败'))
    img.src = src
  })
}

function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function uint8ToBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

async function canvasToJpeg(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, bg: string): Promise<FragmentImage | null> {
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  draw(ctx)
  return {
    jpeg: dataUrlToBytes(canvas.toDataURL('image/jpeg', 0.92)),
    pxW: canvas.width,
    pxH: canvas.height,
  }
}

const RASTER_SCALE = 2
const RASTER_BLEED = 40
const TRIM_PAD = 3

/**
 * A 档主路径：宽松画布渲染 → 扫描真实像素 → 精确裁剪。
 *
 * 预览与导出共用返回的这张 JPEG，因此不可能再出现「DOM 里看得见、位图里
 * 被裁掉」或两侧裁掉不同部分的情况。BLEED 足够覆盖 KaTeX 的上下标 /
 * 分式 / 积分限 / aligned 多行末行，字体异步加载的几 px 偏差也一并容下；
 * 最终尺寸由非背景像素决定，不依赖任何布局猜测。
 */
async function rasterizeTrimmed(
  el: Element,
  css: string,
  bg: string,
  ownW: number,
  ownH: number,
): Promise<{ image: FragmentImage; cssW: number; cssH: number } | null> {
  try {
    const cw = Math.ceil(ownW + RASTER_BLEED * 2)
    const ch = Math.ceil(ownH + RASTER_BLEED * 2)
    const pxW = cw * RASTER_SCALE
    const pxH = ch * RASTER_SCALE
    const xhtml = new XMLSerializer().serializeToString(el)
    // SVG 用 2 倍物理像素 + viewBox 映射：字体按 2x 光栅化而不是事后放大位图。
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="0 0 ${cw} ${ch}">`
      + `<foreignObject x="0" y="0" width="${cw}" height="${ch}">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${cw}px;height:${ch}px;overflow:visible;background:${bg};font-size:16px;color:#333;box-sizing:border-box;position:relative">`
      + `<style>${css.replace(/]]>/g, ']]&gt;')}</style>`
      // 固定宽度让 .katex-display 的 text-align:center 有确定参考宽度
      + `<div style="position:absolute;left:${RASTER_BLEED}px;top:${RASTER_BLEED}px;width:${Math.ceil(ownW)}px">${xhtml}</div>`
      + `</div></foreignObject></svg>`
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)

    const probe = document.createElement('canvas')
    probe.width = pxW
    probe.height = pxH
    const pctx = probe.getContext('2d')
    if (!pctx) return null
    pctx.fillStyle = bg
    pctx.fillRect(0, 0, pxW, pxH)
    pctx.drawImage(img, 0, 0, pxW, pxH)
    // 取左上角实际像素当背景基准，亮 / 暗色与任意 CSS 颜色写法都适用。
    const data = pctx.getImageData(0, 0, pxW, pxH).data
    const br = data[0], bgc = data[1], bb = data[2]
    let minX = pxW, minY = pxH, maxX = -1, maxY = -1
    for (let y = 0; y < pxH; y++) {
      for (let x = 0; x < pxW; x++) {
        const i = (y * pxW + x) * 4
        const diff = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgc) + Math.abs(data[i + 2] - bb)
        if (diff <= 36) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (maxX < 0) return null
    const padPx = TRIM_PAD * RASTER_SCALE
    const x0 = Math.max(0, minX - padPx)
    const y0 = Math.max(0, minY - padPx)
    const x1 = Math.min(pxW, maxX + 1 + padPx)
    const y1 = Math.min(pxH, maxY + 1 + padPx)
    const outW = Math.max(1, x1 - x0)
    const outH = Math.max(1, y1 - y0)
    const out = document.createElement('canvas')
    out.width = outW
    out.height = outH
    const octx = out.getContext('2d')
    if (!octx) return null
    octx.fillStyle = bg
    octx.fillRect(0, 0, outW, outH)
    octx.drawImage(probe, x0, y0, outW, outH, 0, 0, outW, outH)
    return {
      image: { jpeg: dataUrlToBytes(out.toDataURL('image/jpeg', 0.94)), pxW: outW, pxH: outH },
      cssW: outW / RASTER_SCALE,
      cssH: outH / RASTER_SCALE,
    }
  } catch {
    return null
  }
}

/**
 * A 档兜底：任意 DOM 元素 → JPEG。SVG foreignObject 里塞 XHTML + 内联 CSS，
 * 交给 Chromium 自己排版，公式字体由 base64 内联 @font-face 提供。
 */
async function rasterizeElement(
  el: Element,
  css: string,
  w: number,
  h: number,
  bg: string,
  contentSize: { w: number; h: number },
  contentOffset: { x: number; y: number },
): Promise<FragmentImage | null> {
  try {
    const xhtml = new XMLSerializer().serializeToString(el)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
      + `<foreignObject width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;font-size:16px;color:#333;box-sizing:border-box;position:relative">`
      + `<style>${css.replace(/]]>/g, ']]&gt;')}</style>`
      // 内容按溢出量平移，保证上下标 / 分母落在画布内；固定宽度让
      // .katex-display 的 text-align:center 有确定的参考宽度。
      + `<div style="position:absolute;left:${contentOffset.x}px;top:${contentOffset.y}px;width:${contentSize.w}px">${xhtml}</div>`
      + `</div></foreignObject></svg>`
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    return await canvasToJpeg(w, h, ctx => ctx.drawImage(img, 0, 0, w, h), bg)
  } catch {
    return null
  }
}

/** pele SVG 的 CSS 变量显式写进根 style，保证脱离外部 CSS 后颜色正确。 */
function fixPeleVars(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    if (!root || root.nodeName === 'parsererror') return svg
    for (const [name, value] of Object.entries(PELE_LIGHT_VARS)) root.style.setProperty(name, value)
    return new XMLSerializer().serializeToString(doc)
  } catch { return svg }
}

async function svgToJpeg(svg: string, bg: string): Promise<FragmentImage | null> {
  try {
    const png = await rasterizeSvgToPngDataUri(svg)
    if (!png) return null
    const img = await loadImage(png)
    const w = img.naturalWidth / 2, h = img.naturalHeight / 2
    return await canvasToJpeg(w, h, ctx => ctx.drawImage(img, 0, 0, w, h), bg)
  } catch { return null }
}

/** 图片 src → 可直接被 Image 加载的 URL；本地路径先读盘转 data URI。 */
async function imageSrcToUrl(url: string, src: PdfSource): Promise<string | null> {
  if (/^(data:|blob:|https?:|asset:|tauri:|file:)/i.test(url)) {
    if (/^(https?:)/i.test(url)) return url
    if (/^asset:/i.test(url)) return url.replace(/^asset:\/\/?/, 'http://asset.localhost/')
    return url
  }
  const abs = resolveImageAssetAbsPath(url, src.currentFilePath)
  try {
    const bytes = await readFile(abs)
    const mime = extToMime(extFromFileName(url))
    return `data:${mime};base64,${uint8ToBase64(bytes)}`
  } catch {
    // 非 Tauri / 读盘失败：退回 asset 协议，预览里仍可能显示
    try { return convertFileSrc(abs) } catch { return null }
  }
}

async function imageToJpeg(url: string, bg: string): Promise<{ image: FragmentImage; w: number; h: number } | null> {
  try {
    const img = await loadImage(url)
    const w = img.naturalWidth, h = img.naturalHeight
    if (!w || !h) return null
    const image = await canvasToJpeg(w, h, ctx => ctx.drawImage(img, 0, 0, w, h), bg)
    return image ? { image, w, h } : null
  } catch { return null }
}

/**
 * KaTeX / raw HTML 统一走「宽松画布 → 像素裁剪」，预览直接显示裁剪后的
 * JPEG（previewEl 是 <img>），导出也用同一份字节。两侧不再各自排版，
 * 因此不会再出现「预览被遮挡 / 导出被裁掉不同部分」的分叉。
 */
async function buildBitmapFragment(
  id: string,
  kind: RichFragment['kind'],
  el: Element,
  css: string,
  bg: string,
  alt: string,
): Promise<RichFragment> {
  const own = measureOwn(el)
  const got = await rasterizeTrimmed(el, css, bg, own.w, own.h)
  if (got) {
    const img = document.createElement('img')
    img.setAttribute('src', `data:image/jpeg;base64,${uint8ToBase64(got.image.jpeg)}`)
    img.setAttribute('alt', alt)
    return {
      id, kind,
      w: got.cssW * PX_TO_PT, h: got.cssH * PX_TO_PT,
      contentSize: { w: got.cssW, h: got.cssH }, contentOffset: { x: 0, y: 0 },
      previewEl: img,
      pdf: null, formula: null, srcW: 0, srcH: 0,
      image: got.image,
      fallbackText: alt,
    }
  }
  // foreignObject 不可用（少数 WebKit）时退回惰性光栅化 + 真实 DOM 预览。
  const w = own.w + 32, h = own.h + 32
  return {
    id, kind,
    w: w * PX_TO_PT, h: h * PX_TO_PT,
    contentSize: { w: own.w, h: own.h }, contentOffset: { x: 16, y: 16 },
    previewEl: el,
    pdf: null, formula: null, srcW: 0, srcH: 0,
    image: null,
    rasterize: () => rasterizeElement(el, css, w, h, bg, { w: own.w, h: own.h }, { x: 16, y: 16 }),
    fallbackText: alt,
  }
}

// ---- 主入口 ------------------------------------------------------------------

export async function buildFragments(
  tree: Root,
  src: PdfSource,
  opts: PdfLayoutOptions,
): Promise<FragmentBuild> {
  const warnings: string[] = []
  const found: Found[] = []
  findNodes(tree.children as any[], true, found)

  const tokens: Tokens = tokensOf(opts)
  const bg = tokens.pageBg
  const needsKatex = found.some(f => f.kind === 'katex-inline' || f.kind === 'katex-block')
  const katexCss = needsKatex ? await ensurePreviewStyles() : ''

  const fragments: Record<string, RichFragment> = {}
  const byNode = new WeakMap<object, string>()
  /** 公式矢量先行测量，字体子集化（异步、串行）后统一落定；失败回退位图 */
  const pendingFormula: MeasuredFormula[] = []
  const formulaEls = new Map<string, Element>()
  const formulaNodes = new Map<string, object>()

  await Promise.all(found.map(async (item, idx) => {
    const id = `fr${idx}`
    const node = item.node
    let frag: RichFragment | null = null

    if (item.kind === 'katex-inline' || item.kind === 'katex-block') {
      const display = item.kind === 'katex-block'
      const tex = String(node.value ?? '')
      const { html, error } = await renderKatexHtml(tex, display)
      if (error) warnings.push(`公式渲染失败: ${error}`)
      const el = elementFromHtml(html)
      if (error || !el.querySelector('.katex-html')) {
        // 语法错误占位 / 无 katex-html：保持旧的位图降级路径
        frag = await buildBitmapFragment(id, item.kind, el, katexCss, bg, tex)
      } else {
        const measured = await measureKatexVector(el as HTMLElement, opts.fontSize)
        if (!measured) {
          warnings.push(`公式矢量测量失败，已回退位图: ${tex.slice(0, 40)}`)
          frag = await buildBitmapFragment(id, item.kind, el, katexCss, bg, tex)
        } else {
          pendingFormula.push({ id, kind: item.kind, tex, box: measured.box, ops: measured.ops })
          formulaEls.set(id, el)
          formulaNodes.set(id, node as object)
          return
        }
      }
    } else if (item.kind === 'mermaid') {
      const { svg, error } = await renderMermaidSvg(String(node.value ?? ''))
      if (!svg) {
        warnings.push(`mermaid 渲染失败: ${error ?? '未知错误'}`)
        return
      }
      const v = svgToPdf(svg, tokens)
      if (v.warnings.length) warnings.push(...v.warnings.map(w => `mermaid 矢量降级: ${w}`))
      const sized = fixPeleVars(svg)
      const el = new DOMParser().parseFromString(sized, 'image/svg+xml').documentElement
      frag = {
        id, kind: 'mermaid',
        w: v.width * PX_TO_PT, h: v.height * PX_TO_PT,
        contentSize: { w: v.width, h: v.height }, contentOffset: { x: 0, y: 0 },
        previewEl: el,
        pdf: v.pdf && !v.warnings.length ? v.pdf : null,
        formula: null,
        srcW: v.width, srcH: v.height,
        image: null,
        rasterize: () => svgToJpeg(sized, bg),
        fallbackText: String(node.value ?? ''),
      }
    } else if (item.kind === 'raw-html') {
      const clean = sanitizeHtml(String(node.value ?? ''))
      const el = elementFromHtml(`<div class="velo-editor"><div class="velo-html-block">${clean}</div></div>`)
      // 复用导出 HTML 的同一份编辑器 CSS，让 details / summary / abbr / kbd /
      // mark 等自写标签的块级样式与 webview 一致；再重置 .velo-editor 的容器
      // 布局（max-width / padding / margin 只属于导出文档外壳，不该进片段）。
      const css = editorCss
        + '\n.velo-editor{max-width:none!important;margin:0!important;padding:0!important;background:transparent!important;}'
      frag = await buildBitmapFragment(id, 'image', el, css, bg, clean.replace(/<[^>]+>/g, ' ').trim())
    } else if (item.kind === 'image') {
      const url = await imageSrcToUrl(String(node.url ?? ''), src)
      if (!url) { warnings.push(`图片无法读取: ${node.url}`); return }
      const got = await imageToJpeg(url, bg)
      if (!got) { warnings.push(`图片无法加载: ${node.url}`); return }
      const el = document.createElement('img')
      el.setAttribute('src', url)
      el.setAttribute('alt', String(node.alt ?? ''))
      el.setAttribute('style', `width:${got.w}px;height:${got.h}px`)
      frag = {
        id, kind: 'image',
        w: got.w * PX_TO_PT, h: got.h * PX_TO_PT,
        contentSize: { w: got.w, h: got.h }, contentOffset: { x: 0, y: 0 },
        previewEl: el,
        pdf: null, formula: null, srcW: got.image.pxW, srcH: got.image.pxH,
        image: got.image,
        fallbackText: String(node.alt ?? ''),
      }
    }

    if (frag) {
      fragments[id] = frag
      byNode.set(node as object, id)
    }
  }))

  // 公式矢量落定：收集各族字符集 → 运行时子集化 → 解析 gid。
  let formulaFonts: FormulaFontEntry[] = []
  if (pendingFormula.length) {
    const finalized = await finalizeFormulaVector(pendingFormula)
    warnings.push(...finalized.warnings)
    formulaFonts = finalized.fonts
    for (const item of pendingFormula) {
      const content = finalized.contents.get(item.id)
      const el = formulaEls.get(item.id) ?? null
      if (content) {
        fragments[item.id] = {
          id: item.id,
          kind: item.kind,
          w: content.width,
          h: content.height + content.depth,
          previewEl: null,
          pdf: null,
          formula: content,
          srcW: content.width,
          srcH: content.height + content.depth,
          // 预览直接画 formula 算子，contentSize / offset 不参与（保留类型占位）
          contentSize: { w: content.width, h: content.height + content.depth },
          contentOffset: { x: 0, y: 0 },
          image: null,
          fallbackText: item.tex,
        }
      } else if (el) {
        // 缺字 / 未适配形状 → 与 mermaid 同策略回退位图，保证内容不丢
        fragments[item.id] = await buildBitmapFragment(
          item.id, item.kind, el, katexCss, bg, item.tex,
        )
      }
      byNode.set(formulaNodes.get(item.id) as object, item.id)
    }
  }

  return { fragments, byNode, warnings, formulaFonts }
}

// 内联 SVG → PNG data URI（浏览器 canvas 光栅化）。
//
// 为什么需要：`docx` 的 `htmlToContent` 把 SVG 原样写进 docx，但它给 SVG 的
// PNG fallback 是**1×1 透明占位符**（docx 自己不做光栅化 —— 见 node_modules/docx
// 的 `TRANSPARENT_PIXEL`）。也就是说 Word 以下、不支持 SVG 的查看器（含 WPS）
// 打开文档时图是空白的。Velo 主要用户在中文环境，WPS 占比高，所以 DOCX 导出前
// 把内联 SVG（目前只有 mermaid）光栅化成真 PNG。
//
// 颜色：pele 的 SVG 用 CSS 变量（`--pele-*`，定义在 `.velo-mermaid-block` 上）
// 着色。把 SVG 塞进 `<img>` 时外部 CSS 不参与，`var()` 只剩 fallback 值 ——
// 所以光栅化前把 `--pele-*` 显式写进 SVG 根元素的 style，固定走 light 主题
// （DOCX 通常白底查看，暗色图在 Word 里是一块黑底，不合适）。

/** pele light 主题变量，对齐 `styles/_mermaid.scss` 的 `.velo-mermaid-block`。 */
export const PELE_LIGHT_VARS: Readonly<Record<string, string>> = {
  '--pele-bg': '#ffffff',
  '--pele-fg': '#1f1f1f',
  '--pele-fg-on-light': '#1f1f1f',
  '--pele-fg-on-dark': '#ffffff',
  '--pele-muted': '#6e6e6e',
  '--pele-line': '#1f1f1f',
  '--pele-surface': '#f3f3f3',
  '--pele-surface-alt': '#e6e6e6',
  '--pele-border': '#8a8a8a',
  '--pele-accent': '#5b7bd5',
  '--pele-critical': '#e45756',
  '--pele-error': '#e45756',
  '--pele-radius': '4px',
}

export interface RasterizeOptions {
  /** 放大倍数，默认 2 —— 高清屏 / 打印都足够清晰。 */
  scale?: number
  /** canvas 底色，默认白。SVG 自身有 `--pele-bg`，铺底是防 SVG 无背景时透出页面。 */
  background?: string
}

/**
 * 把内联 SVG 光栅化成 PNG data URI。失败返回 `null`（调用方降级回内联 SVG）。
 *
 * 只在浏览器 / Tauri webview 里跑（用 `Image` + `canvas`）。SVG 来自 data URI，
 * 同源不污染 canvas，`toDataURL` 不会被 taint 拦。
 */
export async function rasterizeSvgToPngDataUri(
  svg: string,
  opts: RasterizeOptions = {},
): Promise<string | null> {
  const scale = opts.scale ?? 2
  const background = opts.background ?? '#ffffff'
  try {
    const withVars = applyCssVars(svg, PELE_LIGHT_VARS)
    const { width, height } = svgDimensions(withVars)
    if (!width || !height) return null

    const img = await loadImage(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withVars)}`,
    )

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = background
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }
  catch {
    return null
  }
}

/**
 * 把 CSS 变量显式写进 SVG 根元素的 style。
 *
 * `<img>` 渲染 SVG 时，外部文档的 CSS（`.velo-mermaid-block { --pele-bg: ... }`）
 * 不参与，SVG 根上 `var(--pele-bg,#fff)` 只能取 fallback。这里用 DOMParser 把
 * 变量直接 setProperty 到根元素，序列化后颜色就固定了。
 */
function applyCssVars(svg: string, vars: Readonly<Record<string, string>>): string {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    // parsererror 是 Firefox / 部分内核对非法 SVG 的返回形态
    if (!root || root.nodeName === 'parsererror') return svg
    for (const [name, value] of Object.entries(vars)) {
      root.style.setProperty(name, value)
    }
    return new XMLSerializer().serializeToString(doc)
  }
  catch {
    return svg
  }
}

/** 从 SVG 的 `width`/`height` 属性或 `viewBox` 推尺寸（px）。 */
function svgDimensions(svg: string): { width: number; height: number } {
  const w = lengthInPx(/width\s*=\s*"([^"]+)"/i.exec(svg)?.[1])
  const h = lengthInPx(/height\s*=\s*"([^"]+)"/i.exec(svg)?.[1])
  const viewBox = /viewBox\s*=\s*"([^"]+)"/i.exec(svg)?.[1]
  const parts = viewBox?.trim().split(/[\s,]+/).map(Number)
  const vbWidth = parts?.length === 4 ? parts[2] : undefined
  const vbHeight = parts?.length === 4 ? parts[3] : undefined

  if (w && h) return { width: w, height: h }
  if (w && vbHeight && vbWidth) return { width: w, height: (w * vbHeight) / vbWidth }
  if (h && vbWidth && vbHeight) return { width: (h * vbWidth) / vbHeight, height: h }
  if (vbWidth && vbHeight) return { width: vbWidth, height: vbHeight }
  return { width: 0, height: 0 }
}

/** SVG 长度 → px。支持 unitless / px / pt / in / cm / mm；其他单位返回 null。 */
function lengthInPx(value: string | undefined): number | null {
  if (!value) return null
  const m = /^([\d.]+)\s*(px|pt|in|cm|mm)?$/i.exec(value.trim())
  if (!m) return null
  const num = Number(m[1])
  if (!Number.isFinite(num) || num <= 0) return null
  switch ((m[2] ?? 'px').toLowerCase()) {
    case 'px': return num
    case 'pt': return num * (96 / 72)
    case 'in': return num * 96
    case 'cm': return (num * 96) / 2.54
    case 'mm': return (num * 96) / 25.4
    default: return num
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('SVG 加载失败'))
    img.src = src
  })
}

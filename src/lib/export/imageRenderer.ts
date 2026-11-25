// 图片导出（PNG / JPEG）—— 纯前端、跨平台、异步。
//
// 为什么不用 Rust 离屏窗口 + CapturePreview：那条路只支持 Windows、走 UI 线程
// 会卡住编辑器、且慢（~10s）。这里把渲染与编码全放前端 TS：
//   1. 自包含 export HTML（buildExportHtml + inlineAssets，字体 base64 / 图片 data URI）
//      塞进隐藏 iframe，用浏览器**原生 CSS** 渲染 —— 样式与主编辑器同源（@forward
//      编辑器 SCSS），像素级一致；
//   2. XMLSerializer 序列化成良构 XHTML，包进 SVG <foreignObject>，加载成 Image；
//   3. drawImage 到 canvas → toBlob 出 PNG / JPEG。
// 全程异步、不建 OS 窗口、不碰 Rust UI 线程，编辑器不卡；纯 Web API，WebView2 /
// WKWebView / WebKitGTK 都支持。
//
// **canvas 尺寸上限的跨平台陷阱**：Safari / 旧 WKWebView 桌面版 canvas 面积上限
// 长期是 16.7MP（4096×4096），超了 getContext 返回 null / 出空白；Chromium 桌面
// 宽松（~268MP / 32767 边）。所以不写死 2×，而是**自适应缩放**：先试 2×，引擎撑不下
// 就降倍率重试 —— Windows 拿满 2× 高清，受限引擎优雅降级但整篇完整（不裁切）。
//
// foreignObject 渲染 SVG-as-image 时**不加载外部资源**：字体 / 图片必须全内联
// （inlineAssets 已处理本地图；远程图这里 best-effort fetch 成 data URI），否则
// 空白或污染 canvas。

export interface RenderImageOptions {
  /** 自包含 export HTML（inlineAssets: true）。 */
  html: string
  format: 'png' | 'jpeg'
  /** 渲染 CSS 宽，对齐导出 body max-width，默认 880。 */
  width?: number
}

/** 首选光栅化倍率（2× 文字锐利）；引擎 canvas 撑不下时自适应下调。 */
const PREFERRED_SCALE = 2
/** 自适应下限：低于此值输出已过糊，宁可抛错。 */
const MIN_SCALE = 0.5
/** JPEG 编码质量。 */
const JPEG_QUALITY = 0.92

/** 把自包含 export HTML 渲染成 PNG / JPEG 字节。失败抛错由调用方兜底。 */
export async function renderExportImage(opts: RenderImageOptions): Promise<Uint8Array> {
  const width = opts.width ?? 880
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:1000px;border:0;`
  iframe.srcdoc = opts.html
  document.body.appendChild(iframe)
  try {
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve()
      iframe.onerror = () => reject(new Error('export iframe load failed'))
    })
    const doc = iframe.contentDocument
    if (!doc || !doc.body) throw new Error('export iframe has no document')
    await doc.fonts.ready
    await inlineRemoteImages(doc)
    await waitImages(doc)

    const height = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight)
    if (height <= 0) throw new Error('measured zero document height')
    if (!doc.documentElement.getAttribute('xmlns')) {
      doc.documentElement.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
    }
    const xhtml = new XMLSerializer().serializeToString(doc.documentElement)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
      + `<foreignObject width="100%" height="100%">${xhtml}</foreignObject></svg>`
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    return await encodeAdaptive(img, width, height, opts.format)
  }
  finally {
    iframe.remove()
  }
}

/** 自适应倍率编码：先试 2×，canvas 撑不下（ctx null / toBlob 空）就降倍率重试。 */
async function encodeAdaptive(
  img: HTMLImageElement,
  width: number,
  height: number,
  format: 'png' | 'jpeg',
): Promise<Uint8Array> {
  let scale = PREFERRED_SCALE
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  while (scale >= MIN_SCALE) {
    const outW = Math.round(width * scale)
    const outH = Math.round(height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, outW, outH)
      ctx.drawImage(img, 0, 0, outW, outH)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, JPEG_QUALITY))
      if (blob && blob.size > 0) {
        return new Uint8Array(await blob.arrayBuffer())
      }
    }
    scale *= 0.75
  }
  throw new Error('document too large to rasterize within canvas limits')
}

/** 远程图片 best-effort 内联成 data URI（foreignObject 不加载外部资源）。失败保留原样。 */
async function inlineRemoteImages(doc: Document): Promise<void> {
  const remotes = Array.from(doc.images).filter(im => /^https?:/i.test(im.src))
  await Promise.all(remotes.map(async (im) => {
    try {
      const res = await fetch(im.src)
      const blob = await res.blob()
      im.src = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error('read image blob failed'))
        fr.readAsDataURL(blob)
      })
    }
    catch {
      // 远程图取不到就保留原 src（渲染时可能空白），不中断整篇导出。
    }
  }))
}

function waitImages(doc: Document): Promise<void> {
  return Promise.all(Array.from(doc.images).map(im => im.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => { im.onload = () => resolve(); im.onerror = () => resolve() })))
    .then(() => undefined)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('export SVG image load failed'))
    img.src = src
  })
}
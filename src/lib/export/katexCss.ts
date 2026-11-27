// KaTeX CSS 自包含:按需把 woff2 字体转成 base64 data URI,strip woff/ttf 引用。
//
// 背景:
//  - 编辑器在 EditorInner.vue 走 `import 'katex/dist/katex.min.css'`(side-effect
//    import),Vite 把 url(fonts/KaTeX_*.woff2) 打到 dist/assets/。
//  - 导出 HTML 走 `?raw` 拿 CSS 原文,导出文件旁没有 fonts/ 目录,因此需要把
//    `@font-face` 的 woff2 内联为 base64 data URI 并 strip woff/ttf 引用。
//
// 为什么用 `?url` + 运行时 fetch + 内存缓存而非 `?inline`:
//  - `?inline` 会把 20 个 woff2 以 Base64 形式再打进 JS chunk(~345KB),与 dist/assets/
//    里的二进制 woff2 双份存储且无法跨格式去重。
//  - `?url` 复用同一批 .woff2 资产,首次导出时并行 fetch 本地 Tauri 内存资产(不走网络)
//    并缓存结果,后续导出零 I/O。

const katexWoff2Modules = import.meta.glob(
  '../../../node_modules/katex/dist/fonts/*.woff2',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>

// 抽出 filename → asset URL 的查找表。
// modulePath 形如 `'../../../node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2'`。
const katexWoff2Urls: Record<string, string> = {}
for (const [modulePath, url] of Object.entries(katexWoff2Modules)) {
  const filename = modulePath.split('/').at(-1) ?? ''
  katexWoff2Urls[filename] = url
}

const katexDataUriCache = new Map<string, string>()

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function dataUriToBytes(uri: string): Uint8Array {
  const b64 = uri.slice(uri.indexOf(',') + 1)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * 按文件名读取 KaTeX woff2 原始字节（供 pdfPreview 运行时子集化用）。
 * 如 `KaTeX_Main-Regular.woff2`。
 */
export async function loadKatexWoff2Bytes(filename: string): Promise<Uint8Array | undefined> {
  const url = katexWoff2Urls[filename]
  if (!url) return undefined
  if (url.startsWith('data:')) return dataUriToBytes(url)
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    return new Uint8Array(await res.arrayBuffer())
  }
  catch {
    return undefined
  }
}

async function loadKatexWoff2DataUri(filename: string): Promise<string | undefined> {
  const cached = katexDataUriCache.get(filename)
  if (cached) return cached

  const url = katexWoff2Urls[filename]
  if (!url) return undefined
  if (url.startsWith('data:')) {
    katexDataUriCache.set(filename, url)
    return url
  }

  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const bytes = new Uint8Array(await res.arrayBuffer())
    const dataUri = `data:font/woff2;base64,${uint8ToBase64(bytes)}`
    katexDataUriCache.set(filename, dataUri)
    return dataUri
  }
  catch {
    return undefined
  }
}

/**
 * 把 katex.min.css 里所有 `@font-face` 的 src 改写成 woff2 base64 data URI。
 *
 * katex.min.css 里每个字体的 @font-face src 形如:
 *   `src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),
 *         url(fonts/KaTeX_AMS-Regular.woff) format("woff"),
 *         url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")`
 *
 * 重写成:
 *   `src:url(data:font/woff2;base64,XXX) format("woff2")`
 *
 * 整个改写一次完成,保留原始格式声明、CSS 语法(逗号 / 大括号 / 引号)不动。
 *
 * 抽成纯函数以便测试 —— vitest 下 `?inline` import 与 prod build 行为不一致
 * (返回空),真正在 prod 走 prod 这条路,测试只验转换逻辑。
 *
 * url() 路径形式多样(必须都处理):
 *   - `url(fonts/KaTeX_AMS-Regular.woff2)` —— 原始 katex.min.css
 *   - `url(/node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2)` —— Vite dev
 *   - `url(/assets/KaTeX_AMS-Regular-Cx986IdX.woff2)` —— Vite prod build 带 hash
 *   - `url(C:/.../node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2)` —— Vite SSR 偶尔
 * 路径前缀千变万化,匹配按**basename**对齐:`KaTeX_<NAME>[-<HASH>].woff2` → 去掉可选
 * 8 字符 Vite hash → 在 `fontDataUris` 表里查 `KaTeX_<NAME>.woff2` → 拿到 data URI。
 */
export function inlineKatexWoff2Fonts(
  css: string,
  fontDataUris: Record<string, string>,
): string {
  // 整段 src 声明匹配:从 src: 到 ; 或 } 之前。
  // 内部再 grep 找 woff2 那条 url;不依赖前缀,所以各种 Vite 改写都能命中。
  const srcRe = /src:\s*([^;}]+)/g

  return css.replace(srcRe, (match, srcValue: string) => {
    // 找 src 里 woff2 那条 url(任意路径前缀都行)
    const woff2UrlMatch = srcValue.match(/url\(\s*(['"]?)([^'")]+?\.woff2)\1\s*\)\s*format\("woff2"\)/)
    if (!woff2UrlMatch) return match

    const woff2Path = woff2UrlMatch[2]
    // basename:取最后一段(去掉路径前缀),再剥 Vite 8 字符 hash
    const basename = woff2Path.split('/').pop() ?? woff2Path
    const keyNoHash = basename.replace(/-[A-Za-z0-9_-]{8}\.woff2$/, '.woff2')

    const dataUri = fontDataUris[keyNoHash] ?? fontDataUris[basename]
    if (!dataUri) {
      // 不应发生:glob 应当覆盖 katex.min.css 引用的所有 woff2。
      // 失败时保留原 src,导出 HTML 仍能在能访问原 URL 的环境(开发 webview)工作。
      return match
    }
    return `src:url(${dataUri}) format("woff2")`
  })
}

let cachedInlinedCss: string | null = null

/**
 * 生产路径:走 Vite `?raw` 拿 katex.min.css 原文,并行 fetch 20 个 woff2 转 base64
 * 后走 `inlineKatexWoff2Fonts` 改写 src,结果缓存在模块级变量中。
 * **用 `?raw` 而非 `?inline`**:Vite 的 `?inline` 会把 CSS 中 url() 改成绝对路径或
 * `new URL(...)` 表达式,只有 `?raw` 保留原文件 byte-for-byte 文本。
 */
export async function loadKatexCssWithFontsInlined(): Promise<string> {
  if (cachedInlinedCss !== null) return cachedInlinedCss

  const css = (await import('katex/dist/katex.min.css?raw')).default
  const filenames = Object.keys(katexWoff2Urls)
  const loaded = await Promise.all(
    filenames.map(async (name) => [name, await loadKatexWoff2DataUri(name)] as const),
  )
  const fontDataUris: Record<string, string> = {}
  for (const [name, uri] of loaded) {
    if (uri) fontDataUris[name] = uri
  }
  const inlined = inlineKatexWoff2Fonts(css, fontDataUris)
  if (Object.keys(fontDataUris).length > 0) {
    cachedInlinedCss = inlined
  }
  return inlined
}

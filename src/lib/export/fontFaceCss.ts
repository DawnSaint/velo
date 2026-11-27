// 内嵌字体自包含:按需把命中的 woff2 转成 base64 data URI,让导出 HTML
// 不依赖外部 /fonts/... 路径(外部浏览器 / 打印机 webview 都解析不到),视觉与
// Tauri webview 内一致。
//
// ── 运行时 ?url + fetch + 内存缓存 ──
// 编辑器已在 _fonts.scss 通过 CSS url() 把 src/fonts/**/*.woff2 打包到 dist/assets/。
// 此前用 `?inline` eager glob 会在 htmlRenderer chunk 里再存一份 ~5MB Base64 副本,
// 与 .woff2 二进制资产双份占体积(无法被 Brotli/LZMA 去重)。
// 改为 `?url` 引用同一份资产 URL,导出时仅对命中的字体族并行 fetch(Tauri 本地内存协议,
// 不走网络,耗时数 ms)并转 base64 + 模块级缓存,彻底消除双份存储。
//
// 字体放 src/fonts/ 而非 public/:Vite 禁止 JS glob/import public/ 下资产。
//
// ── 按需内联 ──
// `buildFontFaceCss(fontFamily, fontMono)` 从两个 CSS font-family 栈里解析出实际命中的
// 内嵌字体族,只拉取并生成这些字体的 @font-face。
// **已知取舍**:HTML 导出换一台没装该字体的机器打开时,会回退到系统字体;PDF / DOCX 不受影响。

// ── 字体注册表 ──
// 每个内嵌字体的 font-family 名 + woff2 文件名 → 字重/样式映射。
// 没有斜体字形的字体(Fira Code / Inconsolata)只注册 normal 字重,
// 浏览器会通过 font-synthesis 自动合成斜体。

interface FontFaceEntry {
  family: string
  filename: string
  weight: number
  style: 'normal' | 'italic'
}

interface BundledFont {
  /** font-family 名称,与 @font-face 和 fontStacks 中的名称一致 */
  family: string
  /** src/fonts/ 下的子目录名 */
  dir: string
  entries: FontFaceEntry[]
}

const BUNDLED_FONTS: readonly BundledFont[] = [
  {
    family: 'JetBrains Mono',
    dir: 'jetbrainsmono',
    entries: [
      { family: 'JetBrains Mono', filename: 'JetBrainsMono-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'JetBrains Mono', filename: 'JetBrainsMono-Bold.woff2', weight: 700, style: 'normal' },
      { family: 'JetBrains Mono', filename: 'JetBrainsMono-Italic.woff2', weight: 400, style: 'italic' },
      { family: 'JetBrains Mono', filename: 'JetBrainsMono-BoldItalic.woff2', weight: 700, style: 'italic' },
    ],
  },
  {
    family: 'Fira Code',
    dir: 'firacode',
    entries: [
      { family: 'Fira Code', filename: 'FiraCode-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'Fira Code', filename: 'FiraCode-Bold.woff2', weight: 700, style: 'normal' },
    ],
  },
  {
    family: 'Hack',
    dir: 'hack',
    entries: [
      { family: 'Hack', filename: 'Hack-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'Hack', filename: 'Hack-Bold.woff2', weight: 700, style: 'normal' },
      { family: 'Hack', filename: 'Hack-Italic.woff2', weight: 400, style: 'italic' },
      { family: 'Hack', filename: 'Hack-BoldItalic.woff2', weight: 700, style: 'italic' },
    ],
  },
  {
    family: 'IBM Plex Mono',
    dir: 'ibmplexmono',
    entries: [
      { family: 'IBM Plex Mono', filename: 'IBMPlexMono-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'IBM Plex Mono', filename: 'IBMPlexMono-Bold.woff2', weight: 700, style: 'normal' },
      { family: 'IBM Plex Mono', filename: 'IBMPlexMono-Italic.woff2', weight: 400, style: 'italic' },
      { family: 'IBM Plex Mono', filename: 'IBMPlexMono-BoldItalic.woff2', weight: 700, style: 'italic' },
    ],
  },
  {
    family: 'Inconsolata',
    dir: 'inconsolata',
    entries: [
      { family: 'Inconsolata', filename: 'Inconsolata-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'Inconsolata', filename: 'Inconsolata-Bold.woff2', weight: 700, style: 'normal' },
    ],
  },
  {
    family: 'Source Code Pro',
    dir: 'sourcecodepro',
    entries: [
      { family: 'Source Code Pro', filename: 'SourceCodePro-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'Source Code Pro', filename: 'SourceCodePro-Bold.woff2', weight: 700, style: 'normal' },
      { family: 'Source Code Pro', filename: 'SourceCodePro-Italic.woff2', weight: 400, style: 'italic' },
      { family: 'Source Code Pro', filename: 'SourceCodePro-BoldItalic.woff2', weight: 700, style: 'italic' },
    ],
  },
  {
    family: 'DejaVu Sans Mono',
    dir: 'dejavu',
    entries: [
      { family: 'DejaVu Sans Mono', filename: 'DejaVuSansMono-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'DejaVu Sans Mono', filename: 'DejaVuSansMono-Bold.woff2', weight: 700, style: 'normal' },
      { family: 'DejaVu Sans Mono', filename: 'DejaVuSansMono-Italic.woff2', weight: 400, style: 'italic' },
      { family: 'DejaVu Sans Mono', filename: 'DejaVuSansMono-BoldItalic.woff2', weight: 700, style: 'italic' },
    ],
  },
  {
    family: 'Noto Sans SC',
    dir: 'notosanssc',
    entries: [
      { family: 'Noto Sans SC', filename: 'NotoSansSC-Regular.woff2', weight: 400, style: 'normal' },
      { family: 'Noto Sans SC', filename: 'NotoSansSC-Bold.woff2', weight: 700, style: 'normal' },
    ],
  },
] as const

// ── 批量收集所有 woff2 的构建产物 URL(与 _fonts.scss 复用同一批 .woff2 资产) ──
const allWoff2Modules = import.meta.glob(
  '../../fonts/**/*.woff2',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>

const woff2Urls: Record<string, string> = {}
for (const [modulePath, url] of Object.entries(allWoff2Modules)) {
  const filename = modulePath.split('/').at(-1) ?? ''
  woff2Urls[filename] = url
}

const dataUriCache = new Map<string, string>()

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function loadWoff2DataUri(filename: string): Promise<string | undefined> {
  const cached = dataUriCache.get(filename)
  if (cached) return cached

  const url = woff2Urls[filename]
  if (!url) return undefined
  if (url.startsWith('data:')) {
    dataUriCache.set(filename, url)
    return url
  }

  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const bytes = new Uint8Array(await res.arrayBuffer())
    const dataUri = `data:font/woff2;base64,${uint8ToBase64(bytes)}`
    dataUriCache.set(filename, dataUri)
    return dataUri
  }
  catch {
    return undefined
  }
}

async function buildFontFacesForEntries(entries: readonly FontFaceEntry[]): Promise<string> {
  const dataUris = await Promise.all(entries.map(e => loadWoff2DataUri(e.filename)))
  const lines: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const dataUri = dataUris[i]
    if (!dataUri) continue
    const entry = entries[i]
    lines.push(
      `@font-face{font-family:'${entry.family}';font-style:${entry.style};font-weight:${entry.weight};font-display:swap;src:url(${dataUri}) format("woff2")}`,
    )
  }
  return lines.join('\n')
}

// ── 构建导出 HTML 的 @font-face CSS ──

/** 内嵌字体族名 → BundledFont 的查找表,用于从 font-family 栈解析命中族。 */
const BUNDLED_BY_FAMILY: ReadonlyMap<string, (typeof BUNDLED_FONTS)[number]> = new Map(
  BUNDLED_FONTS.map((f) => [f.family, f]),
)

/**
 * 从 CSS font-family 栈字符串里解析出实际引用的内嵌字体族(按出现顺序去重)。
 *
 * `stack` 形如 `'JetBrains Mono', ui-monospace, Consolas, monospace` —— 逗号分隔、
 * 名字可带引号。只返回在 `BUNDLED_FONTS` 里注册过的族;系统字体(ui-monospace /
 * Consolas / PingFang SC 等)原样跳过。
 *
 * 大小写敏感匹配:字体族名是 CSS 标识符,`'jetbrains mono'` 与 `'JetBrains Mono'`
 * 不是同一个族。fontStacks.ts 生成的栈用的是 verbatim 注册名,一致。
 */
export function resolveBundledFamilies(...stacks: readonly string[]): string[] {
  const found: string[] = []
  for (const stack of stacks) {
    for (const part of stack.split(',')) {
      const name = part.trim().replace(/^['"]|['"]$/g, '').trim()
      if (!name) continue
      if (BUNDLED_BY_FAMILY.has(name) && !found.includes(name)) found.push(name)
    }
  }
  return found
}

/**
 * 为**所有**内嵌字体生成 @font-face CSS 字符串(全量,不管用户选了什么)。
 *
 * 当前导出链路走按需的 `buildFontFaceCss`;本函数保留作为:
 * 1. 测试里的对照基准(验按需确实只命中所选族)
 * 2. 未来若要在设置里提供「导出时内联全部字体」选项的挂载点
 *
 * 体积:8 款字体共 ~5.2MB base64。
 */
export async function buildAllFontFaceCss(): Promise<string> {
  const entries = BUNDLED_FONTS.flatMap(f => f.entries)
  return buildFontFacesForEntries(entries)
}

/**
 * 为指定 font-family 栈生成按需的 @font-face CSS 字符串。
 *
 * 只内联 `fontFamily` / `fontMono` 两个栈里实际命中的内嵌字体族 —— 用户没选中的
 * 字体不进导出 HTML。两个参数都传空串时返回空串(等价于"不内联任何内嵌字体")。
 *
 * @param fontFamily - 正文字体栈(对应 `--md-font-family`)
 * @param fontMono - 等宽字体栈(对应 `--font-mono`)
 */
export async function buildFontFaceCss(fontFamily: string, fontMono: string): Promise<string> {
  const families = resolveBundledFamilies(fontFamily, fontMono)
  if (families.length === 0) return ''
  const entries: FontFaceEntry[] = []
  for (const family of families) {
    const font = BUNDLED_BY_FAMILY.get(family)
    if (font) entries.push(...font.entries)
  }
  return buildFontFacesForEntries(entries)
}

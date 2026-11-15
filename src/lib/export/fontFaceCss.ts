// 内嵌字体自包含:把所有 woff2 inline 成 base64 data URI,让导出 HTML
// 不依赖外部 /fonts/... 路径(外部浏览器 / 打印机 webview 都解析不到),视觉与
// Tauri webview 内一致。
//
// 同 katexCss.ts 范式:走 Vite ?inline 在 build 期把 woff2 拿成 base64 data URI
// 字符串。字体必须放 src/fonts/ 而非 public/ —— public/ 资源只能按 URL 引用,
// Vite 禁止从 JS import(?inline glob 会报 "Assets in public directory cannot be
// imported from JavaScript")。放 src/ 与 katexCss(走 node_modules)同范式,Vite 正常处理。
//
// ── 按需内联(v0.7.16) ──
// 原先 `buildAllFontFaceCss()` 无条件内联全部 8 款字体(~5.19MB base64),不管用户
// 选了哪一款。改成 `buildFontFaceCss(fontFamily, fontMono)`:从两个 CSS font-family
// 栈里解析出实际命中的内嵌字体族,只生成这些字体的 @font-face。极端情况(选 JetBrains
// Mono + 系统 CJK)从 5.19MB 降到 ~0.8MB。
//
// **已知取舍**:HTML 导出换一台没装该字体的机器打开时,会回退到系统字体(原先全量
// 内联能保证跨机器一致)。PDF / DOCX 不受此取舍影响 —— PDF 渲染的就是用户本机;DOCX
// 的 `htmlToContent` 显式丢弃 @font-face(见 docx/dist/html.mjs 注释),本来只用
// font-family 名字,内联字体对 DOCX 从不生效。
//
// bundle 体积不变:`woff2DataUris` 是模块顶层 eager glob,所有字体仍进导出 chunk
// (按需内联减少的是**导出 HTML 产物**体积,不是 bundle 体积)。真要减 bundle 得改
// 惰性 fetch,代价是每次导出多 20+ 次 fetch + 转码,见 katexCss.ts 同段取舍说明。

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

// ── 批量加载所有 woff2 为 base64 data URI ──
// 用一个大的 glob 匹配 src/fonts/ 下所有子目录的 woff2 文件。
const allWoff2Modules = import.meta.glob(
  '../../fonts/**/*.woff2',
  { query: '?inline', import: 'default', eager: true },
) as Record<string, string>

const woff2DataUris: Record<string, string> = {}
for (const [modulePath, dataUri] of Object.entries(allWoff2Modules)) {
  const filename = modulePath.split('/').at(-1) ?? ''
  woff2DataUris[filename] = dataUri
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
export function buildAllFontFaceCss(): string {
  const lines: string[] = []
  for (const font of BUNDLED_FONTS) {
    for (const entry of font.entries) {
      const dataUri = woff2DataUris[entry.filename]
      if (!dataUri) continue
      lines.push(
        `@font-face{font-family:'${entry.family}';font-style:${entry.style};font-weight:${entry.weight};font-display:swap;src:url(${dataUri}) format("woff2")}`,
      )
    }
  }
  return lines.join('\n')
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
export function buildFontFaceCss(fontFamily: string, fontMono: string): string {
  const families = resolveBundledFamilies(fontFamily, fontMono)
  const lines: string[] = []
  for (const family of families) {
    const font = BUNDLED_BY_FAMILY.get(family)
    if (!font) continue
    for (const entry of font.entries) {
      const dataUri = woff2DataUris[entry.filename]
      if (!dataUri) continue
      lines.push(
        `@font-face{font-family:'${entry.family}';font-style:${entry.style};font-weight:${entry.weight};font-display:swap;src:url(${dataUri}) format("woff2")}`,
      )
    }
  }
  return lines.join('\n')
}

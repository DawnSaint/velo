// 内嵌字体自包含:把所有 woff2 inline 成 base64 data URI,让导出 HTML
// 不依赖外部 /fonts/... 路径(外部浏览器 / 打印机 webview 都解析不到),视觉与
// Tauri webview 内一致。
//
// 同 katexCss.ts 范式:走 Vite ?inline 在 build 期把 woff2 拿成 base64 data URI
// 字符串。fontsource 子集化后的 latin 子集体积可控(14~140KB/文件),总计约
// 1.5MB raw / ~2MB base64 常驻主 bundle。export 功能必用这些字体,体积可接受。
//
// 字体必须放 src/fonts/ 而非 public/ —— public/ 资源只能按 URL 引用,Vite 禁止
// 从 JS import(?inline glob 会报 "Assets in public directory cannot be imported
// from JavaScript")。放 src/ 与 katexCss(走 node_modules)同范式,Vite 正常处理。

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

/** 为所有内嵌字体生成 @font-face CSS 字符串,用于导出 HTML 内联。 */
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

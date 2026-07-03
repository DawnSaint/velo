// JetBrains Mono 字体自包含:把 woff2 inline 成 base64 data URI,让导出 HTML
// 不依赖外部 /fonts/... 路径(外部浏览器 / 打印机 webview 都解析不到),视觉与
// Tauri webview 内一致。
//
// 同 katexCss.ts 范式:走 Vite ?inline 在 build 期把 4 个 woff2 拿成 base64
// data URI 字符串(共 ~380KB raw / ~500KB base64,常驻主 bundle)。export 功能
// 必用 JetBrains Mono 字体,体积可接受;懒加载会让首份 PDF 导出多几百 ms race。

const jetbrainsWoff2Modules = import.meta.glob(
  '../../../public/fonts/jetbrainsmono/*.woff2',
  { query: '?inline', import: 'default', eager: true },
) as Record<string, string>

const jetbrainsWoff2DataUris: Record<string, string> = {}
for (const [modulePath, dataUri] of Object.entries(jetbrainsWoff2Modules)) {
  const filename = modulePath.split('/').pop()!
  jetbrainsWoff2DataUris[filename] = dataUri
}

export function buildJetbrainsFontFaceCss(): string {
  const entries: Array<{ filename: string, weight: number, style: 'normal' | 'italic' }> = [
    { filename: 'JetBrainsMono-Regular.woff2', weight: 400, style: 'normal' },
    { filename: 'JetBrainsMono-Bold.woff2', weight: 700, style: 'normal' },
    { filename: 'JetBrainsMono-Italic.woff2', weight: 400, style: 'italic' },
    { filename: 'JetBrainsMono-BoldItalic.woff2', weight: 700, style: 'italic' },
  ]

  return entries
    .map(({ filename, weight, style }) => {
      const dataUri = jetbrainsWoff2DataUris[filename]
      if (!dataUri) return null
      return `@font-face{font-family:'JetBrains Mono';font-style:${style};font-weight:${weight};font-display:swap;src:url(${dataUri}) format("woff2")}`
    })
    .filter(Boolean)
    .join('\n')
}

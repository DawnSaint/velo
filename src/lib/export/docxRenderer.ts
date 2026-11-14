// Markdown → DOCX（OOXML）导出。
//
// 路线：mdast → HTML（复用 `htmlRenderer.buildExportHtml`，`inlineAssets` 自包含）
// → docx.js `htmlToContent` → docx.js `Document` → `Packer.toBlob`。
//
// 关键取舍：
// 1. **HTML 是唯一中间态** —— htmlRenderer 的 walker 已处理 Velo 全部自定义
//    节点（alert / highlight / mermaid / 脚注 / TOC），`htmlToContent` 读
//    `<style>` + 内联 `style`，样式自动带过去。不重写 walker。
// 2. **资源必须自包含** —— `htmlToContent` 不下载任何东西，所以走
//    `inlineAssets`：本地图片转 data URI、mermaid SVG 光栅化成 PNG（见
//    `svgRaster.ts`，docx 给 SVG 的 fallback 是 1×1 透明占位）。
// 3. **CSS 驱动格式** —— `htmlToContent` 会解析 `<style>`（含 `var()`），
//    Velo 的 editorCss 已把字体 / 字号 / 颜色写进 CSS，docx 侧不再设一套。
//    `@media print` 块被采用（强制 light，适合 Word），`@media
//    (prefers-color-scheme: dark)` 被忽略 —— 见 html.d.ts 的 stylesheet 说明。
// 4. **`notes: 'footnotes'`** —— 把 Velo 的 `<sup class="footnote-ref">` +
//    `.footnote-definition` 识别成真正的 Word 脚注。
//
// 浏览器兼容：docx.js 是 isomorphic（`fflate` + `nanoid`，无 Node 专有 API），
// `htmlToContent` 只用全局 `document`，Tauri webview 天然满足。

import { Document, Packer } from 'docx'
import { htmlToContent } from 'docx/html'

import { buildExportHtml } from './htmlRenderer'
import type { ExportOptions } from './htmlRenderer'

export interface DocxExportResult {
  /** 生成的 docx 字节（`PK` 魔数开头的合法 zip）。 */
  bytes: Uint8Array
  /** 渲染 / 转换过程中的警告（mermaid 失败、htmlToContent 丢弃的元素等）。 */
  warnings: string[]
}

/**
 * 把 markdown 源导出成 docx 字节。
 *
 * 复用 `buildExportHtml` 的完整渲染管线（含 mermaid / shiki / KaTeX），再交给
 * `htmlToContent` 转成 Word 的 Paragraph / Table。失败不抛（htmlToContent
 * 对不认识的 HTML 只 warn），资源缺失降级见 warnings。
 */
export async function buildExportDocx(opts: ExportOptions): Promise<DocxExportResult> {
  const warnings: string[] = []

  const { html, warnings: renderWarnings } = await buildExportHtml({
    ...opts,
    inlineAssets: true,
  })
  warnings.push(...renderWarnings)

  const content = htmlToContent(html, {
    notes: 'footnotes',
    onWarning: (w) => warnings.push(`[${w.code}] ${w.message}`),
  })

  const doc = new Document({
    creator: 'Velo',
    title: opts.fileName,
    description: 'Exported from Velo',
    sections: [{ children: content }],
  })

  const blob = await Packer.toBlob(doc)
  return { bytes: new Uint8Array(await blob.arrayBuffer()), warnings }
}

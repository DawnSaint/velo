// PDF 预览 / 导出统一入口（懒加载边界）。
//
//   buildPdf(source, opts)  →  PdfBuild { doc, relayout }
//   serializePdf(doc)      →  Uint8Array
//   renderAllPages(...)    →  DOM 预览
//
// buildPdf 只做一次：解析 mdast + 渲染 KaTeX / mermaid / shiki / 图片 + 生成块级 IR。
// 之后改页边距 / 字号 / 行距 / 页眉页脚只调同步的 relayout，不重跑任何异步渲染。
// 正文内容变化才重新 buildPdf（按内容 hash 命中缓存，切回来不重复付代价）。

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import type { Root } from 'mdast'
import { remarkPreserveEmptyLine } from '@/components/ProseMirrorEditor/plugins/preserveEmptyLine'
import { remarkAlert } from '@/components/ProseMirrorEditor/plugins/remarkAlert'
import { remarkEncodeLinkUrls } from '@/components/ProseMirrorEditor/plugins/remarkEncodeLinkUrls'
import { remarkHighlight } from '@/components/ProseMirrorEditor/plugins/remarkHighlight'
import { remarkStrictMath } from '@/components/ProseMirrorEditor/plugins/strictMath'
import { remarkEmoji } from '@/components/ProseMirrorEditor/plugins/remarkEmoji'
import { buildFragments } from './fragmentBuilder'
import { buildBlocks, relayout, type BlockIR } from './layoutEngine'
import { ensurePreviewDomStyles } from './previewRenderer'
import { writePdf } from './pdfWriter'
import { buildFontSet, collectCharset, type FontSet } from './fontSubset'
import { installFontSet } from './tokens'
import type { PdfDocument, PdfLayoutOptions, PdfSource, RichFragment } from './types'

export { renderAllPages, renderPageDom, ensurePreviewDomStyles } from './previewRenderer'
export { opsSummary } from './pdfWriter'
export { DEFAULT_PDF_LAYOUT_OPTIONS, MM_TO_PT, PDF_PAPER_SIZES } from './types'
export type { PdfDocument, PdfLayoutOptions, PdfMargins, PdfPaperSize, PdfSource } from './types'

export interface PdfBuild {
  doc: PdfDocument
  /** 同步重排：返回新的 PdfDocument（共享同一份 fragments / IR） */
  relayout: (opts: PdfLayoutOptions) => PdfDocument
  /** 构建耗时（ms），面板里显示 */
  buildMs: number
  /** 首次布局耗时（ms） */
  layoutMs: number
}

interface Cached {
  ir: BlockIR
  fragments: Record<string, RichFragment>
  warnings: string[]
  /** 构建这份 IR 时用的字体集；relayout 前重新 install，防止多文档缓存交错时度量串台 */
  fonts: FontSet
}

const CACHE_LIMIT = 4
const cache = new Map<string, Cached>()

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

function parse(content: string): Root {
  // 与 htmlRenderer.ts 同一份 pipeline：transformer 插件必须走 runSync 才生效，
  // 只 parse 会丢 alert / highlight / 严格数学节点。
  const processor = unified()
    .use(remarkParse)
    .use(remarkPreserveEmptyLine)
    .use(remarkEncodeLinkUrls)
    .use(remarkGfm)
    .use(remarkStrictMath)
    .use(remarkAlert)
    .use(remarkHighlight)
    .use(remarkEmoji)
    .use(remarkFrontmatter, ['yaml', 'toml'])
  return processor.runSync(processor.parse(content) as Root) as Root
}

export async function buildPdf(source: PdfSource, opts: PdfLayoutOptions): Promise<PdfBuild> {
  const t0 = performance.now()
  // 字体先行：运行时子集化 + 度量注入必须在任何 glyph()/measure 之前完成。
  // 字符集 = 文档全文 + 版式字面量（页眉文字 / 目录标题 / alert 标签等）。
  // buildFontSet 内部按字符集缓存，与下面的 IR 缓存互不依赖。
  const key = hash(`${source.content}\u0000${source.currentFilePath}\u0000${source.lightTheme}\u0000${source.darkTheme}`)
  let entry = cache.get(key)
  if (!entry) {
    // 字符集 = 文档全文 + 版式字面量（页眉 / 目录标题 / alert 标签 / 页码）。
    // 注意顺序：buildFragments 里 mermaid 的 svgToPdf 会调 glyph()/measureMixed，
    // 必须先 installFontSet 再渲染富片段，不能并行。
    const tree = parse(source.content)
    // ↩ 是脚注回链字符（layoutEngine footnote 分支），必须进子集否则会缺字成 '?'。
    const charset = collectCharset(source.content, `${opts.headerText}目录NOTETIPIMPORTANTWARNINGCAUTION↩ /0123456789`)
    const fonts = await buildFontSet(charset)
    installFontSet(fonts)
    const fb = await buildFragments(tree, source, opts)
    const ir = await buildBlocks(tree, source, fb)
    entry = { ir, fragments: fb.fragments, warnings: fb.warnings, fonts }
    cache.set(key, entry)
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  }
  installFontSet(entry.fonts)
  ensurePreviewDomStyles()
  const buildMs = performance.now() - t0

  const layout = (o: PdfLayoutOptions): PdfDocument => {
    // 缓存命中可能来自另一份文档（另一套子集字体），先恢复对应度量与 @font-face。
    installFontSet(entry!.fonts)
    ensurePreviewDomStyles()
    const doc = relayout(entry!.ir, entry!.fragments, o)
    doc.warnings.push(...entry!.warnings)
    return doc
  }
  const t1 = performance.now()
  const doc = layout(opts)
  return { doc, relayout: layout, buildMs, layoutMs: performance.now() - t1 }
}

/** Display List → PDF 字节（内部会惰性光栅化剩余 A 档片段并加载字体子集）。 */
export function serializePdf(doc: PdfDocument): Promise<Uint8Array> {
  return writePdf(doc)
}

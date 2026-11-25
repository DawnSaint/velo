// 公式矢量（DOM 实测提取）回归：pdfWriter 的公式内容流发射 + previewRenderer 的公式绘制。
//
// 提取本身依赖真实浏览器布局（getBoundingClientRect / Range），jsdom 量不出几何，
// 只能在真实 WebView / Chrome 里验证（开发期用临时 puppeteer 端到端样张做过像素级核对）；
// 这里锁住两侧的「消费端」契约：
//   1. writePdf 把 RichFragment.formula 的文本 / 路径 / 矩形发成真 PDF 算子，
//      按需子集字体作为 F4+ 资源嵌入（正文仍是 F1-F3）。
//   2. renderPageDom 直接画同一份 formula 算子（预览 / 导出同源），
//      PDF 路径算子能正确转成 SVG path d（绝对命令、无 NaN）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PdfDocument, RichFragment } from '../types'
import { DEFAULT_PDF_LAYOUT_OPTIONS } from '../types'

// 与 fontSubset.test.ts 同款：?url 资产 mock 成标识串，fetch 返回真实字节，
// 子集化走真实 wasm（这里只需要正文字体给公式字体占位用）。
const HB_URL = 'velo-test:hb-subset.wasm'
const WOFF2_URLS = {
  sans: 'velo-test:sans.woff2',
  bold: 'velo-test:bold.woff2',
  mono: 'velo-test:mono.woff2',
} as const

vi.mock('harfbuzzjs/dist/harfbuzz-subset.wasm?url', () => ({ default: HB_URL }))
vi.mock('../../../../fonts/notosanssc/NotoSansSC-Regular.woff2?url', () => ({ default: WOFF2_URLS.sans }))
vi.mock('../../../../fonts/notosanssc/NotoSansSC-Bold.woff2?url', () => ({ default: WOFF2_URLS.bold }))
vi.mock('../../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2?url', () => ({ default: WOFF2_URLS.mono }))

function disk(rel: string): Uint8Array {
  const p = fileURLToPath(new URL(rel, import.meta.url))
  const b = readFileSync(p)
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
}

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const bytes = {
    [HB_URL]: disk('../../../../../node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'),
    [WOFF2_URLS.sans]: disk('../../../../fonts/notosanssc/NotoSansSC-Regular.woff2'),
    [WOFF2_URLS.bold]: disk('../../../../fonts/notosanssc/NotoSansSC-Bold.woff2'),
    [WOFF2_URLS.mono]: disk('../../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2'),
  }[url]
  if (!bytes) throw new Error(`unexpected fetch: ${url}`)
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}))

const { installFormulaFonts, installFontSet } = await import('../tokens')
const { buildFontSet, collectCharset } = await import('../fontSubset')
const { writePdf } = await import('../pdfWriter')
const { renderPageDom } = await import('../previewRenderer')

const FORMULA_FONT_KEY = 'Main-Regular'

beforeAll(async () => {
  const set = await buildFontSet(collectCharset('公式矢量测试 ABC'))
  installFontSet(set)
  // 借正文字体的子集 TTF 当公式字体占位：结构（Type0/CIDFontType2/FontFile2）完全一致，
  // 只是键名不同，足以验证「按需第 N 套字体」的注册与引用链路。
  installFormulaFonts([{ key: FORMULA_FONT_KEY, meta: set.sans.meta, ttf: set.sans.ttf }])
}, 60_000)

function formulaDoc(): PdfDocument {
  const fragment: RichFragment = {
    id: 'fr0',
    kind: 'katex-inline',
    w: 20,
    h: 10,
    previewEl: null,
    pdf: null,
    formula: {
      width: 20,
      height: 8,
      depth: 2,
      texts: [
        { ch: 'x', font: FORMULA_FONT_KEY, gid: 42, x: 1, y: 0, size: 14.52, color: '#333333' },
      ],
      paths: [
        { ops: '1.5 2.5 m 3 4 l 5 6 c h ', fill: '#000000', stroke: null, strokeWidth: undefined, clip: { x: 0, y: 1, w: 8, h: 6 } },
      ],
      rects: [{ x: 2, y: 3, w: 4, h: 0.6, color: '#333333' }],
    },
    srcW: 20,
    srcH: 10,
    contentSize: { w: 20, h: 10 },
    contentOffset: { x: 0, y: 0 },
    image: null,
  }
  return {
    pages: [{
      ops: [{ op: 'fragment', x: 30, y: 20, w: 20, h: 10, id: 'fr0' }],
    }],
    fragments: { fr0: fragment },
    destinations: {},
    warnings: [],
    missingGlyphs: [],
    pageWidth: 100,
    pageHeight: 200,
    options: { ...DEFAULT_PDF_LAYOUT_OPTIONS },
  }
}

describe('writePdf 公式矢量', () => {
  it('公式字体注册为 F4 资源，正文仍为 F1-F3', async () => {
    const bytes = await writePdf(formulaDoc())
    const latin = new TextDecoder().decode(bytes)
    expect(latin).toContain('/F4 ')
    expect(latin).toContain('/BaseFont /VeloKatexMainRegular')
    // 正文三套 + 公式一套 = 4 个 Type0
    const type0 = latin.match(/\/Subtype \/Type0/g) ?? []
    expect(type0.length).toBe(4)
  })

  it('公式文字走 /F4 文本算子，路径/矩形各按算子类型发射', async () => {
    const bytes = await writePdf(formulaDoc())
    const latin = new TextDecoder().decode(bytes)
    expect(latin).toContain(`BT /F4 14.52 Tf 1 0 0 1 1 0 Tm <002A> Tj ET`)
    // 矩形：y 向上 → 页面坐标翻转
    expect(latin).toContain('re f\n')
    // 路径带裁剪盒（hide-tail 语义），closepath 后接填充结束符
    expect(latin).toContain('re W n\n')
    expect(latin).toContain('h f\n')
  })
})

describe('renderPageDom 公式矢量', () => {
  it('直接画 formula 算子：SVG path 用绝对命令、文本用 KaTeX 字体族', () => {
    const root = renderPageDom(formulaDoc(), 0, 1)
    const svg = root.querySelector('svg')
    expect(svg).not.toBeNull()
    const path = svg?.querySelector('path')
    expect(path?.getAttribute('d')?.startsWith('M ')).toBe(true)
    expect(path?.getAttribute('d')).not.toContain('NaN')
    // 裁剪盒落在预览坐标系（y 向下）
    expect(svg?.querySelector('clipPath rect')).not.toBeNull()

    const spans = [...root.querySelectorAll('span')] as HTMLElement[]
    const glyph = spans.find(s => s.textContent === 'x')
    expect(glyph?.style.fontFamily).toContain('KaTeX_Main')
    expect(glyph?.style.fontSize).toBe('14.52px')
    expect(glyph?.style.left).toBe('1px')
    // 基线在盒内 (h - depth) = 8：top = 8 - 0 - 14.52 * 0.82
    expect(Number.parseFloat(glyph?.style.top ?? '0')).toBeCloseTo(8 - 14.52 * 0.82, 6)
  })
})

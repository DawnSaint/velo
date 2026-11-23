// 脚注版式回归：ts 导出 PDF 的脚注必须对齐 webview（导出 HTML + _footnote.scss）。
//
// 2026-11-22：ts 侧引用端画成 `[label]`（带方括号、与正文同基线、link 色），
// 定义端整体缩进 12pt、字号 0.9、label 用「主色 0.6 透明」的浅蓝、↩ 紧跟描述
// 之后而不是贴右缘 —— 与 webview 的 `.footnote-ref` / `.footnote-definition`
// flex 布局差一整圈。这里按 webview 的计算样式锁死关键量：
//   引用端 = label 原文、主色、0.85em、加粗、上标抬高 0.5em
//   定义端 = label 与文中引用同款（主色加粗）、描述正文色 0.6、↩ 主色 0.6 且右对齐首行基线

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'

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

const BYTES: Record<string, Uint8Array> = {
  [HB_URL]: disk('../../../../../node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm'),
  [WOFF2_URLS.sans]: disk('../../../../fonts/notosanssc/NotoSansSC-Regular.woff2'),
  [WOFF2_URLS.bold]: disk('../../../../fonts/notosanssc/NotoSansSC-Bold.woff2'),
  [WOFF2_URLS.mono]: disk('../../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2'),
}

vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const bytes = BYTES[url]
  if (!bytes) throw new Error(`unexpected fetch: ${url}`)
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}))

const { buildPdf } = await import('../index')
const { DEFAULT_PDF_LAYOUT_OPTIONS } = await import('../types')
const { layoutGeometry, measureMixed, tokensOf } = await import('../tokens')
type TextOp = import('../types').TextOp

const BODY = DEFAULT_PDF_LAYOUT_OPTIONS.fontSize
const GEO = layoutGeometry(DEFAULT_PDF_LAYOUT_OPTIONS)
/** 内容右缘（pt） */
const RIGHT = GEO.pageWidth - GEO.marginRight

const MD = [
  '正文引用[^syntax]，再次引用[^reuse]。',
  '',
  '[^syntax]: CommonMark 本身不包含脚注，但 GFM 扩展了它。',
  '',
  '[^reuse]: 同一个脚注被多次引用，编号保持不变。',
  '',
].join('\n')

async function build() {
  const src = { content: MD, currentFilePath: null, lightTheme: 'vitesse-light', darkTheme: 'vitesse-dark' }
  return buildPdf(src, { ...DEFAULT_PDF_LAYOUT_OPTIONS })
}

describe('脚注引用端对齐 .footnote-ref', () => {
  let ops: TextOp[]
  beforeAll(async () => {
    const { doc } = await build()
    ops = doc.pages.flatMap(p => p.ops).filter((o): o is TextOp => o.op === 'text')
  }, 60_000)

  it('输出 label 原文，不再包方括号', () => {
    expect(ops.some(o => o.text === 'syntax')).toBe(true)
    expect(ops.some(o => o.text === '[syntax]')).toBe(false)
  })

  it('主色 + 0.85em + 加粗', () => {
    const ref = ops.find(o => o.text === 'syntax')
    expect(ref).toBeTruthy()
    expect(ref!.size).toBeCloseTo(BODY * 0.85, 5)
    expect(ref!.font).toBe('bold')
    expect(ref!.color.toLowerCase()).toBe(tokensOf(DEFAULT_PDF_LAYOUT_OPTIONS).primary.toLowerCase())
  })

  it('上标抬高 0.5em（y 比同行正文 baseline 小）', () => {
    const ref = ops.find(o => o.text === 'syntax')!
    const bodyRun = ops.find(o => o.text === '正文引用' && o.size === BODY)!
    expect(ref.y).toBeCloseTo(bodyRun.y - ref.size * 0.5, 5)
  })

  it('左右各留 2px 内边距（.footnote-ref 是 inline-block + padding）', () => {
    const ref = ops.find(o => o.text === 'syntax')!
    const prev = ops.find(o => o.text === '正文引用' && o.size === BODY)!
    const prevEnd = prev.x + measureMixed(prev.text, 'sans', prev.size)
    // 2px @96dpi = 1.5pt
    expect(ref.x - prevEnd).toBeCloseTo(2 * 0.75, 1)
  })
})

describe('脚注定义端对齐 .footnote-definition', () => {
  let ops: TextOp[]
  beforeAll(async () => {
    const { doc } = await build()
    ops = doc.pages.flatMap(p => p.ops).filter((o): o is TextOp => o.op === 'text')
  }, 60_000)

  it('label 在内容左缘（= 左页边距，无缩进），与文中引用同款主色加粗', () => {
    const label = ops.find(o => o.text === 'syntax' && o.size === BODY)
    expect(label).toBeTruthy()
    expect(label!.x).toBeCloseTo(GEO.marginLeft, 3)
    expect(label!.color.toLowerCase()).toBe(tokensOf(DEFAULT_PDF_LAYOUT_OPTIONS).primary.toLowerCase())
    expect(label!.font).toBe('bold')
  })

  it('描述用正文色 0.6 预混（footnoteInk）', () => {
    const desc = ops.find(o => o.text.includes('CommonMark') && o.size === BODY)
    expect(desc).toBeTruthy()
    expect(desc!.color.toLowerCase()).toBe(tokensOf(DEFAULT_PDF_LAYOUT_OPTIONS).footnoteInk.toLowerCase())
  })

  it('↩ 右对齐到内容右缘，颜色是主色 0.6 预混（footnoteBack）', () => {
    const back = ops.find(o => o.text === '↩')
    expect(back).toBeTruthy()
    const backW = Math.max(measureMixed('↩', 'bold', BODY), BODY * 0.6)
    expect(back!.x + backW).toBeCloseTo(RIGHT, 1)
    expect(back!.color.toLowerCase()).toBe(tokensOf(DEFAULT_PDF_LAYOUT_OPTIONS).footnoteBack.toLowerCase())
  })

  it('↩ 与定义首行同基线（比描述文字的 baseline 相同）', () => {
    const back = ops.find(o => o.text === '↩')!
    const desc = ops.find(o => o.text.includes('CommonMark') && o.size === BODY)!
    expect(back.y).toBeCloseTo(desc.y, 3)
  })
})

describe('sub / sup 基线偏移方向', () => {
  // 回归：drawLine 曾用 `baseline - shiftEm * size`，而引擎 y 向下，
  // 导致 sup 落到基线下方、sub 落到上方（与 CSS top 相反）。
  it('sup 在基线上方、sub 在基线下方', async () => {
    const { doc } = await buildPdf({
      content: 'x<sup>2</sup>y H<sub>2</sub>O',
      currentFilePath: null, lightTheme: 'vitesse-light', darkTheme: 'vitesse-dark',
    }, { ...DEFAULT_PDF_LAYOUT_OPTIONS })
    const ops = doc.pages.flatMap(p => p.ops).filter((o): o is TextOp => o.op === 'text')
    const base = ops.find(o => o.text === 'x')!
    const sup = ops.find(o => o.text === '2' && o.x > base.x && o.x < base.x + 20)!
    const sub = ops.find(o => o.text === '2' && o.x > base.x + 20)!
    expect(sup.y).toBeLessThan(base.y)
    expect(sub.y).toBeGreaterThan(base.y)
  }, 60_000)
})

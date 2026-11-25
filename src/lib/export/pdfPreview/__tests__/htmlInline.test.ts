// 自写 HTML 行内标签（kbd / mark / sub / sup）在 PDF 里的底衬回归。
//
// 2026-11-20：ts PDF 链路对行内 raw HTML 只做 stripTags —— `<kbd>Mod</kbd>`
// 变成裸文本 "Mod"，用户自写的 kbd 样式整块丢失（webview 版靠 SCSS 有边框 +
// 圆角 + 底色）。这里把标签语义翻译成显式 deco 算子（底衬 + 圆角边框），
// 并允许 inline style 覆盖颜色。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DecoOp } from '../types'

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

const { buildPdf, serializePdf } = await import('../index')
const { DEFAULT_PDF_LAYOUT_OPTIONS } = await import('../types')
type TextOp = import('../types').TextOp

const MD = [
  '# 快捷键',
  '',
  '按 <kbd>Mod</kbd>+<kbd>B</kbd> 加粗，<kbd>Mod</kbd>+<kbd>I</kbd> 斜体。',
  '',
  '<mark>重点</mark> 与 H<sub>2</sub>O、x<sup>2</sup>。',
  '',
].join('\n')

async function build() {
  const src = { content: MD, currentFilePath: null, lightTheme: 'vitesse-light', darkTheme: 'vitesse-dark' }
  return buildPdf(src, DEFAULT_PDF_LAYOUT_OPTIONS)
}

describe('行内自写 HTML 标签', () => {
  let ops: (DecoOp | TextOp)[]
  beforeAll(async () => {
    const { doc } = await build()
    ops = doc.pages.flatMap(p => p.ops).filter((o): o is DecoOp | TextOp => o.op === 'deco' || o.op === 'text')
  }, 60_000)

  it('kbd 产出带底衬 + 边框的 deco，且文字保留', () => {
    const decos = ops.filter((o): o is DecoOp => o.op === 'deco')
    // Mod / B / Mod / I 四个 kbd + 一个 mark，共 5 个
    expect(decos.length).toBe(5)
    const kbds = decos.slice(0, 4)
    for (const d of kbds) {
      expect(d.fill).toBeTruthy()
      expect(d.stroke).toBeTruthy()
      expect(d.radius).toBeGreaterThan(0)
    }
    // mark：只有底色、无边框
    const mark = decos[4]
    expect(mark.fill).toBeTruthy()
    expect(mark.stroke ?? null).toBeNull()
    const texts = ops.filter((o): o is TextOp => o.op === 'text').map(o => o.text)
    expect(texts).toContain('Mod')
    expect(texts).toContain('B')
  })

  it('sub/sup 只缩放基线偏移，不产生底衬算子', () => {
    // H<sub>2</sub>O / x<sup>2</sup> 的 2 是纯文字 run（scale=0.75 + shiftEm），
    // 不应该出现第三个「无 fill 无 stroke」的框。
    const decos = ops.filter((o): o is DecoOp => o.op === 'deco')
    expect(decos.every(d => d.fill || d.stroke)).toBe(true)
  })

  it('inline style 能覆盖 kbd 颜色', async () => {
    const src = {
      content: '按 <kbd style="background:#ffe4e6;color:#c0392b;border-color:#c0392b">Del</kbd> 删除。',
      currentFilePath: null, lightTheme: 'vitesse-light', darkTheme: 'vitesse-dark',
    }
    const { doc } = await buildPdf(src, DEFAULT_PDF_LAYOUT_OPTIONS)
    const decos = doc.pages.flatMap(p => p.ops).filter((o): o is DecoOp => o.op === 'deco')
    expect(decos.length).toBe(1)
    expect(decos[0].fill?.toLowerCase()).toBe('#ffe4e6')
    expect(decos[0].stroke?.toLowerCase()).toBe('#c0392b')
  }, 60_000)

  it('产物可正常序列化成 PDF 字节', async () => {
    const { doc } = await build()
    const bytes = await serializePdf(doc)
    expect(bytes.length).toBeGreaterThan(1000)
  }, 60_000)
})

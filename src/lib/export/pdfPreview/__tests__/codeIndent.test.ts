// 代码块缩进回归。
//
// 2026-11-20：ts PDF 链路的代码块缩进整体消失。根因是 wrap() 把行首空白
// 当 Markdown 正文缩进折叠掉（正文语义正确，但代码块复用了同一个 wrap）。
// 伴生问题：glyph() 把空格宽度恒按 sans(224/1000) 量，而 JetBrainsMono 是
// 等宽 600/1000 —— 即使保留空格，缩进也只有正确宽度的 37%，和代码字符错位。
//
// 这里直接对 relayout 断言：缩进行相对无缩进行的 x 偏移 = 8 个 mono 空格宽。

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

const { relayout } = await import('../layoutEngine')
const { installFontSet } = await import('../tokens')
const { buildFontSet } = await import('../fontSubset')
const { DEFAULT_PDF_LAYOUT_OPTIONS } = await import('../types')
const { buildPdf, serializePdf } = await import('../index')
type Run = import('../layoutEngine').Run
type BlockIR = import('../layoutEngine').BlockIR
type TextOp = import('../types').TextOp

const mono = (text: string): Run => ({ text, font: 'mono', scale: 0.86, colorKey: 'ink' })

const IR: BlockIR = {
  blocks: [{
    kind: 'code',
    codeLines: [
      [mono('function main() {')],
      [mono('    const x = 1;')],
      [mono('        console.log(x)')],
      [mono('}')],
    ],
  }],
  headings: [],
}

describe('代码块缩进', () => {
  let ops: TextOp[]

  beforeAll(async () => {
    const fonts = await buildFontSet('function main() {    const x = 1;        console.log(x)} 目录')
    installFontSet(fonts)
    const doc = relayout(IR, {}, DEFAULT_PDF_LAYOUT_OPTIONS)
    ops = doc.pages.flatMap(p => p.ops).filter((o): o is TextOp => o.op === 'text')
  }, 60_000)

  /** 某段文字所在行的最小 x（行首文字的落点）。 */
  const lineMinX = (needle: string): number =>
    Math.min(...ops.filter(o => o.text.includes(needle)).map(o => o.x))

  it('缩进行确实带前导空白（不是被折叠掉）', () => {
    // 缩进在 wrap 里是独立的纯空白 piece，不会和后面的代码并成一条算子。
    expect(ops.some(o => /^ {4,}$/.test(o.text))).toBe(true)
  })

  it('缩进宽度按 mono 度量：8 空格 = 8 × 600/1000 × 字号', () => {
    const body = DEFAULT_PDF_LAYOUT_OPTIONS.fontSize
    const size = body * 0.86
    const expectIndent = 8 * 0.6 * size
    const actual = lineMinX('console.log') - lineMinX('function')
    expect(actual).toBeGreaterThan(expectIndent * 0.9)
    expect(actual).toBeLessThan(expectIndent * 1.1)
  })

  it('4 空格缩进同样生效', () => {
    const body = DEFAULT_PDF_LAYOUT_OPTIONS.fontSize
    const size = body * 0.86
    const expectIndent = 4 * 0.6 * size
    const actual = lineMinX('const') - lineMinX('function')
    expect(actual).toBeGreaterThan(expectIndent * 0.9)
    expect(actual).toBeLessThan(expectIndent * 1.1)
  })
})

// 真实链路：shiki 高亮后的代码块（token 化 + 前导空格）也必须带缩进。
describe('代码块缩进（shiki 真实链路）', () => {
  const MD = [
    '# T', '',
    '```ts',
    'function main() {',
    '    const x = 1',
    '    if (x) {',
    '        console.log(x)',
    '    }',
    '}', '```', '',
  ].join('\n')

  it('高亮后的缩进行进入 DisplayOp，且 PDF 可序列化', async () => {
    const src = { content: MD, currentFilePath: null, lightTheme: 'vitesse-light', darkTheme: 'vitesse-dark' }
    const { doc } = await buildPdf(src, DEFAULT_PDF_LAYOUT_OPTIONS)
    const ops = doc.pages.flatMap(p => p.ops)
    const texts = ops.filter((o): o is TextOp => o.op === 'text').map(o => o.text)
    // shiki 把缩进空格切成独立的纯空白 token
    expect(texts.some(t => /^ {4,}$/.test(t))).toBe(true)
    // 缩进体现为真实 x 偏移（代码块左内边距 ≈ 45.35 + 7 pt）
    const codeLeft = 45.354 + 7
    expect(ops.filter(o => o.op === 'text' && o.x - codeLeft > 40).length).toBeGreaterThan(0)
    // 产物仍可正常序列化
    expect((await serializePdf(doc)).length).toBeGreaterThan(1000)
  }, 120_000)
})

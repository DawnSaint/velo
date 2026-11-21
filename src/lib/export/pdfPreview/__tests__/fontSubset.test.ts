// 运行时字体子集化链路回归测试（fontSubset / tokens / pdfWriter）。
//
// jsdom 没有 fetch 本地文件的能力，这里把 ?url 资产 import mock 成标识字符串，
// fetch 按标识返回真实文件字节（woff2 / hb-subset wasm 都从磁盘读）。
// wawoff2 与 harfbuzz wasm 在 Node 下真实执行 —— 测的是真子集化，不是 stub。
//
// 覆盖：
//   1. collectCharset：保底字符 / 文档用字 / 空白剔除 / 去重排序
//   2. buildFontSet：三套子集非空、meta 与字符集自洽、生僻字覆盖、缓存命中
//   3. tokens.glyph：回退链（sans→mono→同形替换→'?'）与缺字记账、宽度同源
//   4. writePdf：Type0/Identity-H 结构、FontFile2 字节同源、ToUnicode 可逆

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { FontSet } from '../fontSubset'
import type { PdfDocument } from '../types'
import { DEFAULT_PDF_LAYOUT_OPTIONS } from '../types'

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

// 动态 import：确保上面的 vi.mock / stubGlobal 先生效
const { collectCharset, buildFontSet } = await import('../fontSubset')
const { installFontSet, glyph, measure, measureMixed, encodeMixed, resetMissingGlyphs, drainMissingGlyphs, loadFontBytes } = await import('../tokens')
const { writePdf } = await import('../pdfWriter')

const RARE = '龘靐齉爨彧翀昪祎'
// NotoSansSC 完整字库实际覆盖的 5 个（靐齉翀昪 不在字库内，属字库覆盖边界）
const RARE_IN_FONT = '龘爨彧翀祎'

let fonts: FontSet
let rareFonts: FontSet

beforeAll(async () => {
  fonts = await buildFontSet(collectCharset('中文测试文档 ABC 0123，。？！'))
  installFontSet(fonts)
  rareFonts = await buildFontSet(collectCharset(RARE))
}, 60_000)

describe('collectCharset', () => {
  it('包含保底字符与 ASCII，剔除空白，去重且有序', () => {
    const cs = collectCharset('中文\n\r\t中')
    expect(cs).toContain('中')
    expect(cs).toContain('文')
    expect(cs).toContain('☐') // 保底：任务列表勾选符
    expect(cs).toContain('∑') // 保底：数学符号
    expect(cs).toContain('A')
    expect(cs).toContain(' ')
    expect(cs).not.toContain('\n')
    expect(cs).not.toContain('\r')
    expect(cs).not.toContain('\t')
    expect([...cs]).toEqual([...new Set([...cs])].sort())
  })

  it('extra 字面量并入字符集（页眉 / 目录等版式用字）', () => {
    const cs = collectCharset('正文', '目录CAUTION')
    for (const ch of '目录CAUTION') expect(cs).toContain(ch)
  })
})

describe('buildFontSet（真实 wasm 子集化）', () => {
  it('三套字体都有合法 TTF 与自洽 meta', () => {
    for (const k of ['sans', 'bold', 'mono'] as const) {
      const { meta, ttf } = fonts[k]
      // sfnt 版本号 0x00010000（TrueType）
      expect(Array.from(ttf.slice(0, 4))).toEqual([0, 1, 0, 0])
      expect(ttf.byteLength).toBeGreaterThan(1000)
      expect(meta.upem).toBeGreaterThan(0)
      expect(meta.glyphCount).toBe(meta.widths.length)
      expect(meta.ascent).toBeGreaterThan(0)
      expect(meta.descent).toBeLessThan(0)
      // chars 里的 gid 必须落在 widths 范围内且宽度一致
      for (const [gid, w] of Object.values(meta.chars)) {
        expect(gid).toBeGreaterThan(0)
        expect(gid).toBeLessThan(meta.glyphCount)
        expect(meta.widths[gid]).toBe(w)
      }
    }
    // 中文字库 upem=1000，垂直度量与 fontTools 静态子集一致（spike 2026-11-19）
    expect(fonts.sans.meta.ascent).toBe(1160)
    expect(fonts.sans.meta.descent).toBe(-288)
    expect(fonts.sans.meta.chars['中']).toBeDefined()
    expect(fonts.sans.meta.chars['文']).toBeDefined()
  })

  it('子集只含文档用字：未收录字符不在 meta 里', () => {
    // '龘' 不在第一份字符集里
    expect(fonts.sans.meta.chars['龘']).toBeUndefined()
  })

  it('生僻字（GB2312 一级之外）按文档字符集收录，不再缺字', () => {
    for (const ch of RARE_IN_FONT) {
      expect(rareFonts.sans.meta.chars[ch]).toBeDefined()
    }
    // 字库本身没有的字仍然缺（三套字库覆盖边界，非子集化丢失）
    for (const ch of '靐齉昪') {
      expect(rareFonts.sans.meta.chars[ch]).toBeUndefined()
    }
  })

  it('同字符集命中缓存（返回同一对象）', async () => {
    const again = await buildFontSet(collectCharset('中文测试文档 ABC 0123，。？！'))
    expect(again).toBe(fonts)
  })

  it('loadFontBytes 与 FontSet 字节同源', async () => {
    const bytes = await loadFontBytes()
    expect(bytes.sans).toBe(fonts.sans.ttf)
    expect(bytes.bold).toBe(fonts.bold.ttf)
    expect(bytes.mono).toBe(fonts.mono.ttf)
  })
})

describe('tokens.glyph 回退链', () => {
  it('常规字符命中首选字体', () => {
    const g = glyph('中', 'sans')
    expect(g.font).toBe('sans')
    expect(g.ch).toBe('中')
    expect(g.gid).toBe(fonts.sans.meta.chars['中'][0])
    expect(g.w).toBe(fonts.sans.meta.chars['中'][1])
  })

  it('☐☑ 同形替换为 mono 的 □✓（NotoSansSC 无 U+2610/2611）', () => {
    const a = glyph('☐', 'sans')
    expect(a.font).toBe('mono')
    expect(a.ch).toBe('□')
    expect(a.gid).toBe(fonts.mono.meta.chars['□'][0])
    const b = glyph('☑', 'sans')
    expect(b.font).toBe('mono')
    expect(b.ch).toBe('✓')
  })

  it('⌘ 只在 mono 字库，单独兜底', () => {
    const g = glyph('⌘', 'sans')
    expect(g.font).toBe('mono')
    expect(g.gid).toBe(fonts.mono.meta.chars['⌘'][0])
  })

  it('mono 首选的中文回退 sans', () => {
    const g = glyph('中', 'mono')
    expect(g.font).toBe('sans')
  })

  it('三套都没有 → ? 并记账 warnings', () => {
    resetMissingGlyphs()
    const g = glyph('靐', 'sans') // 完整字库就没有
    expect(g.ch).toBe('?')
    expect(g.font).toBe('sans')
    expect(drainMissingGlyphs()).toContain('靐')
    resetMissingGlyphs()
  })

  it('空白统一按空格，不进缺字统计', () => {
    resetMissingGlyphs()
    for (const ch of ['\n', '\t', ' ']) {
      const g = glyph(ch, 'sans')
      expect(g.ch).toBe(' ')
      expect(g.font).toBe('sans')
    }
    expect(drainMissingGlyphs()).toEqual([])
  })

  it('measure / measureMixed / encodeMixed 宽度同源', () => {
    const text = '中文☑⌘ABC'
    const size = 12
    expect(measureMixed(text, 'sans', size)).toBeCloseTo(measure(text, 'sans', size), 6)
    const runs = encodeMixed(text, 'sans')
    const units = runs.reduce((s, r) => s + r.units, 0)
    expect(units / 1000 * size).toBeCloseTo(measure(text, 'sans', size), 6)
    // 混排必须按实际解析字体切段（☑⌘ 落 mono）
    expect(runs.some(r => r.font === 'mono')).toBe(true)
    for (const r of runs) {
      expect(r.gids.length).toBe([...r.text].length)
    }
  })
})

describe('writePdf 端到端（最小文档）', () => {
  function minimalDoc(): PdfDocument {
    const runs = encodeMixed('中文☑ABC', 'sans')
    let x = 50
    const ops = runs.map(r => {
      const op = {
        op: 'text' as const, x, y: 700, size: 12, color: '#000000',
        font: r.font, gids: r.gids, text: r.text,
      }
      x += r.units / 1000 * 12
      return op
    })
    return {
      pages: [{ ops }],
      fragments: {},
      destinations: {},
      warnings: [],
      missingGlyphs: [],
      pageWidth: 595,
      pageHeight: 842,
      options: { ...DEFAULT_PDF_LAYOUT_OPTIONS },
    }
  }

  it('产出合法 PDF：Type0/Identity-H + FontFile2 字节同源', async () => {
    const bytes = await writePdf(minimalDoc())
    expect(bytes.byteLength).toBeGreaterThan(5000)
    const head = new TextDecoder().decode(bytes.slice(0, 8))
    expect(head.startsWith('%PDF-1.')).toBe(true)
    const tail = new TextDecoder().decode(bytes.slice(-32))
    expect(tail).toContain('%%EOF')

    // 三套字体各一个 Type0 + CIDFontType2 + Identity CIDToGIDMap
    const latin = new TextDecoder().decode(bytes)
    expect(latin).toContain('/Subtype /Type0')
    expect(latin).toContain('/Encoding /Identity-H')
    expect(latin).toContain('/Subtype /CIDFontType2')
    expect(latin).toContain('/CIDToGIDMap /Identity')
    expect(latin).toContain('/FontFile2')

    // FontFile2 流字节 === 子集 TTF（预览 / 导出同源的核心不变量）
    for (const k of ['sans', 'bold', 'mono'] as const) {
      const ttf = fonts[k].ttf
      const sig = Array.from(ttf.slice(0, 16))
      let found = -1
      outer: for (let i = 0; i + sig.length <= bytes.length; i++) {
        for (let j = 0; j < sig.length; j++) {
          if (bytes[i + j] !== sig[j]) continue outer
        }
        found = i
        break
      }
      expect(found, `${k} TTF 应原样嵌入 PDF`).toBeGreaterThan(-1)
    }
  })

  it('ToUnicode 反查：gid → 原字符（文本可选中 / 可搜索）', async () => {
    const bytes = await writePdf(minimalDoc())
    const latin = new TextDecoder().decode(bytes)
    // sans 的 '中'：chars['中'] = [gid, w] → ToUnicode 里应有 <gid> <4E2D>
    const [gid] = fonts.sans.meta.chars['中']
    const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
    expect(latin).toContain(`<${hex4(gid)}> <4E2D>`)
    // mono 的 '□'（☐ 的同形替换目标）
    const [gidSq] = fonts.mono.meta.chars['□']
    expect(latin).toContain(`<${hex4(gidSq)}> <25A1>`)
  })
})
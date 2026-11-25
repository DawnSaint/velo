// 运行时字体子集化 + 度量提取（替代已删除的 scripts/gen-pdf-fonts.py + 静态 fontmap.json）。
//
// 链路：项目自带 woff2 ─ wawoff2(wasm) → sfnt ─ hb-subset(wasm) → 按字符集子集 TTF
//       ─ opentype.js → cmap / hmtx / head / hhea / OS2 → FontMeta（运行时 fontmap）
//
// 为什么运行时而不是构建期静态子集：
//   1. 字符集不再焊死在 GB2312 一级 —— 按「当前文档实际用字 + 保底常用字」子集化，
//      生僻字不再缺字，导出 PDF 内嵌字体也只含文档用字（几十 KB 级）。
//   2. fontmap 是从子集 TTF 现算的派生数据，不存在「TTF 与 map 人工同步」的漂移。
//   3. 零 Python / 零提交资产；换字库只需换 woff2 文件。
//
// 三个库都可在浏览器跑：wawoff2 的 wasm base64 内嵌（经 woff2Decode.ts 受控加载，
// 绕开其官方包装在 Vite 预构建下的回调悬挂 bug）；hb-subset 用 ?url 拿字节后
// WebAssembly.instantiate（协议与 subset-font 包一致，但该包用了 node:fs，故这里
// 自写 ~80 行胶水）；opentype.js 本身 browser-first。
//
// 本模块只能被懒加载链路 import（pdfPreview/index.ts 是边界）—— wasm 与完整
// woff2 都不进主 bundle。

import { parse as parseFont } from 'opentype.js'
import { katexWoff2DataUri } from '../katexCss'
import { decompressWoff2 } from './woff2Decode'
import hbSubsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url'
// 完整 woff2（与 fontFaceCss.ts 同一批文件）；?url 懒加载，构建期只拷资产不内联。
import sansWoff2Url from '../../../fonts/notosanssc/NotoSansSC-Regular.woff2?url'
import boldWoff2Url from '../../../fonts/notosanssc/NotoSansSC-Bold.woff2?url'
import monoWoff2Url from '../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2?url'
import type { FontKey } from './types'

export interface FontMeta {
  upem: number
  chars: Record<string, [number, number]>
  widths: number[]
  bbox: number[]
  ascent: number
  descent: number
  capHeight: number
  glyphCount: number
}

export interface SubsetFont {
  meta: FontMeta
  /** 子集 TTF 字节：PDF FontFile2 嵌入 + 预览 @font-face 共用同一份 */
  ttf: Uint8Array
}

export type FontSet = Record<FontKey, SubsetFont>

const WOFF2_URLS: Record<FontKey, string> = {
  sans: sansWoff2Url, bold: boldWoff2Url, mono: monoWoff2Url,
}

/**
 * 保底字符集：ASCII + 常用中文标点 / 数学符号 + 任务列表勾选符。
 * 正文汉字由 collectCharset() 从文档收集，这里只保证「文档没用到但版式会用到」
 * 的字符（页码数字、目录标题、缺字回退的 '?' 等）永远在子集里。
 */
const BASE_CHARS =
  '　、。，．；：？！「」『』（）【】《》〈〉—…·～￥％＋－×÷＝≠≤≥∈∉' +
  '∑∏∫∞√∂≈≡←→↑↓⇐⇒∀∃∅∩∪⊂⊃⊆⊇⌈⌉⌊⌋' +
  'αβγδεζηθικλμνξοπρστυφχψωΓΔΘΛΞΠΣΦΨΩ' +
  '•·✓✗■□▲△▪◦§¶†‡※℃°±′″ℓ↔⇔①②③④⑤⑥⑦⑧⑨⑩⌘☐☑'

/** 从文档内容 + 版式字面量收集字符集（含 BASE_CHARS）。 */
export function collectCharset(content: string, extra = ''): string {
  const set = new Set<string>(BASE_CHARS)
  for (let i = 32; i < 127; i++) set.add(String.fromCharCode(i))
  for (const ch of content) set.add(ch)
  for (const ch of extra) set.add(ch)
  // 空白统一按空格渲染（tokens.glyph），不占字形
  set.delete('\n'); set.delete('\r'); set.delete('\t')
  return [...set].sort().join('')
}

// ---- hb-subset wasm 胶水（协议对齐 subset-font 包，去掉其 node:fs 依赖）--------

interface HbExports {
  memory: WebAssembly.Memory
  malloc(n: number): number
  free(p: number): void
  _initialize(): void
  hb_blob_create(data: number, len: number, mode: number, u1: number, u2: number): number
  hb_blob_destroy(blob: number): void
  hb_blob_get_data(blob: number, out: number): number
  hb_blob_get_length(blob: number): number
  hb_face_create(blob: number, index: number): number
  hb_face_destroy(face: number): void
  hb_face_reference_blob(face: number): number
  hb_set_clear(set: number): void
  hb_set_add(set: number, cp: number): void
  hb_set_invert(set: number): void
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(input: number): void
  hb_subset_input_unicode_set(input: number): number
  hb_subset_input_set(input: number, what: number): number
  hb_subset_input_get_flags(input: number): number
  hb_subset_input_set_flags(input: number, flags: number): void
  hb_subset_or_fail(face: number, input: number): number
}

const HB_MEMORY_MODE_WRITABLE = 2
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6
const HB_SUBSET_FLAGS_NO_HINTING = 0x00000001
const HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE = 0x00000200

let hbPromise: Promise<HbExports> | null = null
function loadHb(): Promise<HbExports> {
  if (!hbPromise) {
    hbPromise = fetch(hbSubsetWasmUrl)
      .then(r => {
        if (!r.ok) throw new Error(`hb-subset wasm 加载失败: ${r.status}`)
        return r.arrayBuffer()
      })
      .then(async buf => {
        const { instance } = await WebAssembly.instantiate(buf)
        const e = instance.exports as unknown as HbExports
        e._initialize()
        return e
      })
  }
  return hbPromise
}

/** sfnt + 字符集 → 子集 sfnt（TTF）。串行调用即可（wasm 堆共享，避免并发踩踏）。 */
async function hbSubset(sfnt: Uint8Array, text: string): Promise<Uint8Array> {
  const hb = await loadHb()
  // wasm 内存可能增长导致旧视图 detach，每次现取
  const heap = () => new Uint8Array(hb.memory.buffer)

  const input = hb.hb_subset_input_create_or_fail()
  if (!input) throw new Error('hb_subset_input_create_or_fail 失败')
  const fontBuffer = hb.malloc(sfnt.byteLength)
  // heap() 必须在 malloc 之后现取：ALLOW_MEMORY_GROWTH 下 malloc 可能增长
  // 内存并 detach 旧 ArrayBuffer，提前取的视图会失效。
  heap().set(sfnt, fontBuffer)
  const blob = hb.hb_blob_create(fontBuffer, sfnt.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0)
  const face = hb.hb_face_create(blob, 0)
  hb.hb_blob_destroy(blob)

  try {
    // 与 gen-pdf-fonts.py 的 opts.layout_features=[] 等价：丢全部 layout feature
    // （PDF 文本算子不做 shaping，GSUB/GPOS 用不上，丢掉显著缩小体积）。
    const layoutFeatures = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG)
    hb.hb_set_clear(layoutFeatures)
    const flags = hb.hb_subset_input_get_flags(input)
    hb.hb_subset_input_set_flags(input, flags | HB_SUBSET_FLAGS_NO_HINTING | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE)

    const unicodes = hb.hb_subset_input_unicode_set(input)
    for (const ch of text) hb.hb_set_add(unicodes, ch.codePointAt(0) ?? 0)

    const subset = hb.hb_subset_or_fail(face, input)
    if (!subset) throw new Error('hb_subset_or_fail 失败（字体损坏或字符集为空）')
    try {
      const result = hb.hb_face_reference_blob(subset)
      const offset = hb.hb_blob_get_data(result, 0)
      const len = hb.hb_blob_get_length(result)
      if (!len) throw new Error('子集字体为空')
      const out = heap().slice(offset, offset + len)
      hb.hb_blob_destroy(result)
      return out
    } finally {
      hb.hb_face_destroy(subset)
    }
  } finally {
    hb.hb_subset_input_destroy(input)
    hb.hb_face_destroy(face)
    hb.free(fontBuffer)
  }
}

// ---- 度量提取 ----------------------------------------------------------------

function extractMeta(ttf: Uint8Array, text: string): FontMeta {
  const buf = ttf.buffer.slice(ttf.byteOffset, ttf.byteOffset + ttf.byteLength) as ArrayBuffer
  const font = parseFont(buf)
  const upem = font.unitsPerEm
  const chars: Record<string, [number, number]> = {}
  for (const ch of text) {
    const g = font.charToGlyph(ch)
    if (!g || g.index === 0) continue
    chars[ch] = [g.index, Math.round((g.advanceWidth ?? 0) / upem * 1000)]
  }
  const widths = new Array<number>(font.numGlyphs).fill(0)
  for (let i = 0; i < font.numGlyphs; i++) {
    widths[i] = Math.round((font.glyphs.get(i).advanceWidth ?? 0) / upem * 1000)
  }
  const head = font.tables.head as unknown as { xMin: number; yMin: number; xMax: number; yMax: number }
  const os2 = font.tables.os2 as unknown as { sCapHeight?: number } | undefined
  return {
    upem,
    chars,
    widths,
    bbox: [head.xMin, head.yMin, head.xMax, head.yMax],
    ascent: Math.round(font.ascender / upem * 1000),
    descent: Math.round(font.descender / upem * 1000),
    capHeight: Math.round((os2?.sCapHeight ?? font.ascender) / upem * 1000),
    glyphCount: font.numGlyphs,
  }
}

// ---- 主入口 ------------------------------------------------------------------

let fullSfntPromise: Promise<Record<FontKey, Uint8Array>> | null = null
/** 完整 woff2 → sfnt，只做一次（三套合计 ~100ms，wasm 初始化占大头）。 */
function loadFullSfnt(): Promise<Record<FontKey, Uint8Array>> {
  if (!fullSfntPromise) {
    fullSfntPromise = (async () => {
      const out = {} as Record<FontKey, Uint8Array>
      // wawoff2 是单 wasm 实例、共享堆：并行 decompress 会让先完成者的输出
      // 缓冲区被后续调用覆盖（实测首套 sfnt 头部变垃圾数据）。必须串行，
      // 且每套完成后立刻 slice 出独立副本，脱离 wasm 堆。
      for (const k of Object.keys(WOFF2_URLS) as FontKey[]) {
        const res = await fetch(WOFF2_URLS[k])
        if (!res.ok) throw new Error(`字体加载失败: ${k}`)
        const woff2 = new Uint8Array(await res.arrayBuffer())
        const sfnt = await decompressWoff2(woff2)
        out[k] = sfnt.slice()
      }
      return out
    })()
  }
  return fullSfntPromise
}

const subsetCache = new Map<string, FontSet>()
const CACHE_LIMIT = 4

/**
 * 按字符集生成三套子集字体 + 运行时 fontmap。
 * 结果按字符集 hash 缓存（同一文档反复开面板 / 切主题不重算）。
 * 实测（Node spike，2026-11-19）：3888 字全流程首次 ~250ms、热态 ~130ms；
 * 产物 gid / 字宽 / ascent / descent 与 fontTools 静态子集完全一致。
 */
export async function buildFontSet(text: string): Promise<FontSet> {
  const key = text.length + ':' + text.slice(0, 64) + ':' + hash(text)
  const hit = subsetCache.get(key)
  if (hit) return hit

  const full = await loadFullSfnt()
  const out = {} as FontSet
  // hb wasm 堆共享，三套串行子集化
  for (const k of ['sans', 'bold', 'mono'] as FontKey[]) {
    const ttf = await hbSubset(full[k], text)
    out[k] = { meta: extractMeta(ttf, text), ttf }
  }
  subsetCache.set(key, out)
  while (subsetCache.size > CACHE_LIMIT) subsetCache.delete(subsetCache.keys().next().value as string)
  return out
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(36)
}

// ---- KaTeX 专用字体族（公式矢量用，按需子集）--------------------------------

/** 完整 KaTeX woff2 → sfnt 缓存（按文件名；每族一次解压） */
const katexFullySfnt = new Map<string, Uint8Array>()

async function katexFullSfnt(filename: string): Promise<Uint8Array> {
  const hit = katexFullySfnt.get(filename)
  if (hit) return hit
  const uri = katexWoff2DataUri(filename)
  if (!uri) throw new Error(`KaTeX 字体未内联: ${filename}`)
  const b64 = uri.slice(uri.indexOf(',') + 1)
  const bin = atob(b64)
  const woff2 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) woff2[i] = bin.charCodeAt(i)
  const sfnt = (await decompressWoff2(woff2)).slice()
  katexFullySfnt.set(filename, sfnt)
  return sfnt
}

/**
 * 按「文档公式实际用到的族 → 字符集」生成 KaTeX 子集字体。
 *
 * 与正文三套同链路（woff2 → wawoff2 → hb-subset → opentype.js），只是字体源换成
 * `katexCss` 已内联的 20 个 woff2 data URI —— 不新增打包资产。串行调用：
 * wawoff2 / hb-subset 都是单实例共享堆。
 *
 * @param charsetByFamily 族名用 KaTeX 文件后缀（如 `Main-Regular` → `KaTeX_Main-Regular.woff2`）
 */
export async function buildKatexFontSet(
  charsetByFamily: Record<string, string>,
): Promise<Record<string, SubsetFont>> {
  const out: Record<string, SubsetFont> = {}
  for (const family of Object.keys(charsetByFamily)) {
    const sfnt = await katexFullSfnt(`KaTeX_${family}.woff2`)
    const text = charsetByFamily[family]
    const ttf = await hbSubset(sfnt, text)
    out[family] = { meta: extractMeta(ttf, text), ttf }
  }
  return out
}
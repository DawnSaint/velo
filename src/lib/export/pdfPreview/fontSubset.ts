// 运行时字体子集化 + 度量提取（#pdf-font-fidelity：支持用户字体设置 + 系统字体 + 兜底）。
//
// 双通道字体源：
//   1. 打包字体（src/fonts/*.woff2）：wawoff2(wasm) → sfnt → hb-subset(wasm) → opentype.js
//      产物保留 cmap，PDF 嵌入与预览 @font-face 共用同一份子集 TTF。
//   2. 系统字体（微软雅黑 / 苹方 / Cambria / Consolas / 缺字兜底等）：
//      经 src/tauri/fonts.ts 调 Rust fontdb + ttf-parser + subsetter 直接按文档字符集
//      子集化（~1ms、~30–140KB），避免跨 IPC 传 18–70MB 完整字体；DOM 预览直接用
//      系统 font-family（与编辑器 100% 同源），PDF 嵌入用 Rust 子集 TTF。
//
// 本模块只能被懒加载链路 import（pdfPreview/index.ts 是边界）—— wasm 与完整
// woff2 都不进主 bundle。

import { parse as parseFont } from 'opentype.js'
import { fallbackSubsetSystemFonts, resolveAndSubsetSystemFont } from '@/tauri/fonts'
import { loadKatexWoff2Bytes } from '../katexCss'
import { decompressWoff2 } from './woff2Decode'
import hbSubsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url'
// 默认三套显式 ?url 导入（保留单测 vi.mock 入口，同时作为无设置 / 非 Tauri 的保底源）。
import sansWoff2Url from '../../../fonts/notosanssc/NotoSansSC-Regular.woff2?url'
import boldWoff2Url from '../../../fonts/notosanssc/NotoSansSC-Bold.woff2?url'
import monoWoff2Url from '../../../fonts/jetbrainsmono/JetBrainsMono-Regular.woff2?url'
import type { FontRole } from './types'

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

export interface PreviewCssFont {
  family: string
  weight: number
  italic?: boolean
}

export interface SubsetFont {
  meta: FontMeta
  /** 子集 TTF 字节：PDF FontFile2 嵌入用（打包字体同时供预览 @font-face） */
  ttf: Uint8Array
  /**
   * 系统字体 DOM 预览声明。
   * Rust subsetter 为最小化 PDF 体积移除 cmap 表，不适合 @font-face；
   * 系统字体在 WebView 本机已安装，预览直接走系统 font-family，与编辑器同源。
   */
  previewCss?: PreviewCssFont
}

export interface FontSet {
  /** 所有已装载字体槽位（slotKey → SubsetFont）。始终含 'sans' / 'bold' / 'mono'。 */
  slots: Record<string, SubsetFont>
  /** 每个逻辑角色（sans / bold / mono）的解析优先链（按 CSS 栈顺序 + 系统兜底） */
  chains: Record<FontRole, string[]>
  /** 向后兼容：三个逻辑角色的首选字体 */
  sans: SubsetFont
  bold: SubsetFont
  mono: SubsetFont
}

export interface FontStackPrefs {
  fontFamily?: string
  fontMono?: string
}

// 批量收集 src/fonts/**/*.woff2 的构建产物 URL（与 fontFaceCss.ts / _fonts.scss 复用同一批资产）
const allWoff2Modules = import.meta.glob(
  '../../../fonts/**/*.woff2',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>

const woff2UrlByFile: Record<string, string> = {}
for (const [modulePath, url] of Object.entries(allWoff2Modules)) {
  const filename = modulePath.split('/').at(-1) ?? ''
  if (filename) woff2UrlByFile[filename] = url
}
// 显式 import 优先，保证单元测试对默认三套 ?url 的 vi.mock 生效
woff2UrlByFile['NotoSansSC-Regular.woff2'] = sansWoff2Url
woff2UrlByFile['NotoSansSC-Bold.woff2'] = boldWoff2Url
woff2UrlByFile['JetBrainsMono-Regular.woff2'] = monoWoff2Url

/** 打包字体族名 → { regular, bold } 文件名映射 */
const BUNDLED_FONT_FILES: Record<string, { regular: string; bold: string }> = {
  'Noto Sans SC': { regular: 'NotoSansSC-Regular.woff2', bold: 'NotoSansSC-Bold.woff2' },
  'Google Sans': { regular: 'GoogleSans-Regular.woff2', bold: 'GoogleSans-Bold.woff2' },
  'JetBrains Mono': { regular: 'JetBrainsMono-Regular.woff2', bold: 'JetBrainsMono-Bold.woff2' },
  'Fira Code': { regular: 'FiraCode-Regular.woff2', bold: 'FiraCode-Bold.woff2' },
  'Hack': { regular: 'Hack-Regular.woff2', bold: 'Hack-Bold.woff2' },
  'IBM Plex Mono': { regular: 'IBMPlexMono-Regular.woff2', bold: 'IBMPlexMono-Bold.woff2' },
  'Inconsolata': { regular: 'Inconsolata-Regular.woff2', bold: 'Inconsolata-Bold.woff2' },
  'Source Code Pro': { regular: 'SourceCodePro-Regular.woff2', bold: 'SourceCodePro-Bold.woff2' },
  'DejaVu Sans Mono': { regular: 'DejaVuSansMono-Regular.woff2', bold: 'DejaVuSansMono-Bold.woff2' },
  'Google Sans Code': { regular: 'GoogleSansCode-Regular.woff2', bold: 'GoogleSansCode-Bold.woff2' },
}

const SKIP_GENERICS = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'ui-serif', 'ui-sans-serif', 'ui-rounded', 'math', 'emoji', 'fangsong',
])

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

/** 解析 CSS font-family 栈字符串为去重后的族名列表（跳过纯 generic family）。 */
export function parseCssFontStack(stack?: string): string[] {
  if (!stack) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of stack.split(',')) {
    const name = part.trim().replace(/^['"]|['"]$/g, '').trim()
    if (!name) continue
    const lower = name.toLowerCase()
    if (SKIP_GENERICS.has(lower) || seen.has(lower)) continue
    seen.add(lower)
    out.push(name)
  }
  return out
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

// ---- 打包字体按需解压缓存 ----------------------------------------------------

const bundledSfntCache = new Map<string, Uint8Array>()

/** 按文件名加载并解压打包 woff2（wawoff2 共享堆，调用方保持串行）。 */
async function loadBundledSfnt(filename: string): Promise<Uint8Array | null> {
  const hit = bundledSfntCache.get(filename)
  if (hit) return hit
  const url = woff2UrlByFile[filename]
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) return null
  const woff2 = new Uint8Array(await res.arrayBuffer())
  const sfnt = (await decompressWoff2(woff2)).slice()
  bundledSfntCache.set(filename, sfnt)
  return sfnt
}

async function subsetBundled(filename: string, text: string): Promise<SubsetFont | null> {
  const sfnt = await loadBundledSfnt(filename)
  if (!sfnt) return null
  try {
    const ttf = await hbSubset(sfnt, text)
    const meta = extractMeta(ttf, text)
    if (Object.keys(meta.chars).length === 0) return null
    return { meta, ttf }
  } catch {
    return null
  }
}

// ---- 主入口 ------------------------------------------------------------------

const subsetCache = new Map<string, FontSet>()
const CACHE_LIMIT = 4

function buildDefaultCandidates(role: FontRole, prefs?: FontStackPrefs): { families: string[]; weight: number; defaultFile: string } {
  if (role === 'mono') {
    const user = parseCssFontStack(prefs?.fontMono)
    const families = [...user]
    if (!families.includes('JetBrains Mono')) families.push('JetBrains Mono')
    if (!families.includes('Noto Sans SC')) families.push('Noto Sans SC')
    return { families, weight: 400, defaultFile: 'JetBrainsMono-Regular.woff2' }
  }
  const weight = role === 'bold' ? 700 : 400
  const user = parseCssFontStack(prefs?.fontFamily)
  const families = [...user]
  if (!families.includes('Noto Sans SC')) families.push('Noto Sans SC')
  return {
    families,
    weight,
    defaultFile: role === 'bold' ? 'NotoSansSC-Bold.woff2' : 'NotoSansSC-Regular.woff2',
  }
}

/**
 * 按字符集与用户字体偏好生成子集字体集 + 运行时 fontmap。
 *
 * - 未传 `fontPrefs` 时走默认三套打包字体（Noto Sans SC Regular/Bold + JetBrains Mono），
 *   与旧行为完全一致；Tauri 环境下对仍缺失的字符追加系统兜底字体。
 * - 传入 `fontPrefs`（编辑器 fontFamily / fontMono）时按 CSS 栈顺序逐族解析：
 *   打包字体走 woff2 → hb-subset，系统字体走 Rust fontdb + subsetter（~1ms / ~30–140KB），
 *   剩余缺字走 Rust fallback 补齐。
 */
export async function buildFontSet(text: string, fontPrefs?: FontStackPrefs): Promise<FontSet> {
  const famKey = `${fontPrefs?.fontFamily ?? ''}\u0000${fontPrefs?.fontMono ?? ''}`
  const key = `${text.length}:${text.slice(0, 64)}:${hash(text)}:${hash(famKey)}`
  const hit = subsetCache.get(key)
  if (hit) return hit

  const slots: Record<string, SubsetFont> = {}
  const chains: Record<FontRole, string[]> = { sans: [], bold: [], mono: [] }

  // 每个字符集拆分为去重数组便于按已覆盖剔除
  const allChars = [...new Set(text)]
  const coveredAny = new Set<string>()

  const hasCustomPrefs = Boolean(fontPrefs?.fontFamily || fontPrefs?.fontMono)

  if (!hasCustomPrefs) {
    // 默认快速路径：固定三套打包字体，保证单测与无偏好调用行为零偏差
    for (const [role, filename] of [
      ['sans', 'NotoSansSC-Regular.woff2'],
      ['bold', 'NotoSansSC-Bold.woff2'],
      ['mono', 'JetBrainsMono-Regular.woff2'],
    ] as const) {
      const sfnt = await loadBundledSfnt(filename)
      if (!sfnt) throw new Error(`字体加载失败: ${role}`)
      const ttf = await hbSubset(sfnt, text)
      const meta = extractMeta(ttf, text)
      slots[role] = { meta, ttf }
      chains[role] = [role]
      for (const ch of Object.keys(meta.chars)) coveredAny.add(ch)
    }
  } else {
    // 动态路径：按用户 CSS 字体栈顺序逐族子集化
    for (const role of ['sans', 'bold', 'mono'] as const) {
      const { families, weight, defaultFile } = buildDefaultCandidates(role, fontPrefs)
      const remaining = new Set<string>(allChars)
      let seq = 0

      for (const fam of families) {
        if (remaining.size === 0) break
        // 空格始终保留一份在首个命中的字体里，确保空白宽度取自该角色主字体
        const reqChars = seq === 0 ? [...remaining].join('') : [...remaining].filter(c => c !== ' ').join('')
        if (!reqChars) break

        let sub: SubsetFont | null = null
        const bundled = BUNDLED_FONT_FILES[fam]
        if (bundled) {
          const file = weight >= 600 ? bundled.bold : bundled.regular
          sub = await subsetBundled(file, reqChars)
        } else {
          const sys = await resolveAndSubsetSystemFont([fam], weight, false, reqChars)
          if (sys) {
            sub = {
              meta: sys.meta,
              ttf: sys.ttf,
              previewCss: { family: sys.family, weight: sys.weight, italic: sys.italic },
            }
          }
        }
        if (!sub) continue

        const slotKey = seq === 0 ? role : `${role}:${seq}`
        seq++
        slots[slotKey] = sub
        chains[role].push(slotKey)
        for (const ch of Object.keys(sub.meta.chars)) {
          remaining.delete(ch)
          coveredAny.add(ch)
        }
      }

      // 保底：若用户栈全部未命中（如纯系统字体在非 Tauri web 环境），回退默认打包字体
      if (chains[role].length === 0) {
        const sfnt = await loadBundledSfnt(defaultFile)
        if (!sfnt) throw new Error(`字体加载失败: ${role}`)
        const ttf = await hbSubset(sfnt, text)
        const meta = extractMeta(ttf, text)
        slots[role] = { meta, ttf }
        chains[role] = [role]
        for (const ch of Object.keys(meta.chars)) coveredAny.add(ch)
      }
    }
  }

  // 系统缺字兜底（仅 Tauri 环境生效；非 Tauri 返回 []）
  const stillMissing = allChars.filter(ch => !/\s/.test(ch) && !coveredAny.has(ch)).join('')
  if (stillMissing.length > 0) {
    const fallbacks = await fallbackSubsetSystemFonts(stillMissing, 400)
    fallbacks.forEach((sys, idx) => {
      const slotKey = `fb:${idx}`
      slots[slotKey] = {
        meta: sys.meta,
        ttf: sys.ttf,
        previewCss: { family: sys.family, weight: sys.weight, italic: sys.italic },
      }
      chains.sans.push(slotKey)
      chains.bold.push(slotKey)
      chains.mono.push(slotKey)
    })
  }

  const out: FontSet = {
    slots,
    chains,
    sans: slots.sans,
    bold: slots.bold,
    mono: slots.mono,
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
  const woff2 = await loadKatexWoff2Bytes(filename)
  if (!woff2) throw new Error(`KaTeX 字体未找到: ${filename}`)
  const sfnt = (await decompressWoff2(woff2)).slice()
  katexFullySfnt.set(filename, sfnt)
  return sfnt
}

/**
 * 按「文档公式实际用到的族 → 字符集」生成 KaTeX 子集字体。
 *
 * 与正文同链路（woff2 → wawoff2 → hb-subset → opentype.js），只是字体源换成
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

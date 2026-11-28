// 版式设计令牌与字体度量。
//
// 颜色 / 字号 / 行高的值取自 exportStyles.scss 与 _editor-*.scss，
// PDF 预览也必须从同一份令牌派生，不能另写一套常量（否则必然漂移）。
//
// 字体度量（FONT_META）不再是静态资产：由 fontSubset.ts 在 buildPdf() 阶段
// 按文档字符集运行时子集化 + 解析注入（installFontSet）。布局 / 序列化开始前
// 必须已注入；未注入时 glyph() 会抛错而不是静默画错字。

import type { FontKey, FontRole, PdfLayoutOptions } from './types'
import type { FontMeta, FontSet } from './fontSubset'
import { MM_TO_PT, PDF_PAPER_SIZES } from './types'

export type { FontMeta } from './fontSubset'

let activeFonts: FontSet | null = null
/** 当前字体集槽位 → PDF 资源名（F1..Fn）。默认三套固定占 F1/F2/F3，扩展槽位顺延。 */
export const FONT_RES: Record<FontKey, string> = { sans: 'F1', bold: 'F2', mono: 'F3' }
/** 预览侧 @font-face 的字体族名（仅打包字体用；系统字体由 SubsetFont.previewCss 直出）。 */
export const FONT_FAMILY: Record<FontKey, string> = {
  sans: 'VeloPdfSans', bold: 'VeloPdfBold', mono: 'VeloPdfMono',
}

function rebuildFontMaps(set: FontSet): void {
  for (const k of Object.keys(FONT_RES)) delete FONT_RES[k]
  for (const k of Object.keys(FONT_FAMILY)) delete FONT_FAMILY[k]
  const ordered = [
    ...(['sans', 'bold', 'mono'].filter(k => k in set.slots)),
    ...Object.keys(set.slots).filter(k => k !== 'sans' && k !== 'bold' && k !== 'mono'),
  ]
  ordered.forEach((slotKey, idx) => {
    FONT_RES[slotKey] = `F${idx + 1}`
    if (slotKey === 'sans') FONT_FAMILY[slotKey] = 'VeloPdfSans'
    else if (slotKey === 'bold') FONT_FAMILY[slotKey] = 'VeloPdfBold'
    else if (slotKey === 'mono') FONT_FAMILY[slotKey] = 'VeloPdfMono'
    else FONT_FAMILY[slotKey] = `VeloPdfSlot_${idx + 1}`
  })
}

/** 注入运行时子集字体（buildPdf 调）。同一份字节供预览 @font-face 与 PDF 嵌入。 */
export function installFontSet(set: FontSet): void {
  activeFonts = set
  rebuildFontMaps(set)
}

export function fontSet(): FontSet {
  if (!activeFonts) throw new Error('字体未就绪：请先 buildPdf()')
  return activeFonts
}

/** 当前字体集全部槽位键（与 FONT_RES 分配顺序一致）。 */
export function fontSlotKeys(): FontKey[] {
  const s = fontSet()
  return [
    ...(['sans', 'bold', 'mono'].filter(k => k in s.slots)),
    ...Object.keys(s.slots).filter(k => k !== 'sans' && k !== 'bold' && k !== 'mono'),
  ]
}

export function fontMeta(): Record<FontKey, FontMeta> {
  const s = fontSet()
  const out: Record<string, FontMeta> = {}
  for (const [k, v] of Object.entries(s.slots)) out[k] = v.meta
  return out
}

/** 当前子集 TTF 字节（PDF FontFile2 嵌入用）。 */
export function loadFontBytes(): Promise<Record<FontKey, Uint8Array>> {
  const s = fontSet()
  const out: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(s.slots)) out[k] = v.ttf
  return Promise.resolve(out)
}

/**
 * 公式矢量用的 KaTeX 子集族（按需，见 katexVector.ts）。
 * 与正文三套一样走全局注入：多文档缓存命中时由 layout() 重新 install。
 */
export interface FormulaFontEntry {
  /** 族名（Main-Regular / Math-Italic / Size2-Regular ...） */
  key: string
  meta: FontMeta
  ttf: Uint8Array
}

let activeFormulaFonts: FormulaFontEntry[] = []

export function installFormulaFonts(list: FormulaFontEntry[]): void {
  activeFormulaFonts = list
}

export function formulaFontList(): FormulaFontEntry[] {
  return activeFormulaFonts
}

export interface GlyphHit {
  ch: string
  font: FontKey
  gid: number
  /** 1000 单位字宽 */
  w: number
}

const missing = new Set<string>()

export function resetMissingGlyphs(): void { missing.clear() }
export function drainMissingGlyphs(): string[] { return [...missing] }

/**
 * 任务列表勾选符：NotoSansSC 没有 U+2610/U+2611，JetBrainsMono 有同形的
 * □ / ✓。不做替换会整片出现 '?'。
 */
const SUBSTITUTES: Record<string, [string, FontKey]> = {
  '☐': ['□', 'mono'], '☑': ['✓', 'mono'],
  '■': ['■', 'mono'], '▲': ['▲', 'mono'], '●': ['●', 'mono'], '○': ['○', 'mono'],
}

/**
 * 字符 → glyph。
 *
 * 解析顺序：
 *   1. preferred 对应的字体链（按用户 CSS 栈顺序 + 系统兜底）
 *   2. 其余逻辑角色链（sans → mono）
 *   3. 同形替换（如非 Tauri 环境下 ☑→✓）
 *   4. '?' 并记账给 missingGlyphs
 */
export function glyph(ch: string, preferred: FontKey): GlyphHit {
  const s = fontSet()
  const slots = s.slots

  const chainOf = (roleOrKey: FontKey): string[] => {
    if (roleOrKey === 'sans' || roleOrKey === 'bold' || roleOrKey === 'mono') {
      return s.chains[roleOrKey]
    }
    return roleOrKey in slots ? [roleOrKey] : s.chains.sans
  }

  // 空白 / 控制字符统一当空格，不进缺字统计，也不污染 ToUnicode。
  // 宽度必须取**所在角色主字体**的空格：等宽字体空格通常 600/1000，
  // 比例字体约 224–330/1000，避免代码块缩进错位。
  if (/\s/.test(ch)) {
    const primary = chainOf(preferred)[0] ?? 'sans'
    const own = slots[primary]?.meta.chars[' ']
    if (own) return { ch: ' ', font: primary, gid: own[0], w: own[1] }
    for (const k of s.chains.sans) {
      const sp = slots[k]?.meta.chars[' ']
      if (sp) return { ch: ' ', font: k, gid: sp[0], w: sp[1] }
    }
    return { ch: ' ', font: primary, gid: 1, w: 250 }
  }

  // 1. 先按首选角色链查找（含用户字体栈 + Rust 兜底字体）
  for (const slotKey of chainOf(preferred)) {
    const hit = slots[slotKey]?.meta.chars[ch]
    if (hit) return { ch, font: slotKey, gid: hit[0], w: hit[1] }
  }

  // 2. 跨角色兜底（sans → mono）
  const fallbackRoles: FontRole[] = preferred === 'sans'
    ? ['mono']
    : preferred === 'mono'
      ? ['sans']
      : ['sans', 'mono']
  for (const role of fallbackRoles) {
    for (const slotKey of s.chains[role]) {
      const hit = slots[slotKey]?.meta.chars[ch]
      if (hit) return { ch, font: slotKey, gid: hit[0], w: hit[1] }
    }
  }

  // 3. 同形替换（如非 Tauri 环境下 ☑ → ✓）
  const sub = SUBSTITUTES[ch]
  if (sub) {
    for (const slotKey of chainOf(sub[1])) {
      const hit = slots[slotKey]?.meta.chars[sub[0]]
      if (hit) return { ch: sub[0], font: slotKey, gid: hit[0], w: hit[1] }
    }
  }

  // 4. 实在没有：记入缺字并画 '?'
  missing.add(ch)
  for (const slotKey of s.chains.sans) {
    const q = slots[slotKey]?.meta.chars['?']
    if (q) return { ch: '?', font: slotKey, gid: q[0], w: q[1] }
  }
  return { ch: '?', font: s.chains.sans[0] ?? 'sans', gid: 1, w: 500 }
}

/** 字符串宽度（pt） */
export function measure(text: string, font: FontKey, size: number): number {
  let total = 0
  for (const ch of text) total += glyph(ch, font).w / 1000 * size
  return total
}

export interface EncodedRun {
  font: FontKey
  gids: number[]
  text: string
  /** 未乘字号的 1000 单位宽度 */
  units: number
}

/**
 * 字符串 → 按「实际解析到的字体」分组的 gid 序列。
 *
 * 不能直接 `encode(text, preferred)`：glyph() 遇到缺字会回退 sans，遇到 ⌘
 * 会切 mono。若整段都标成 preferred，PDF 用 preferred 字体画回退字符的 gid
 * 就是错字。这里把连续同源字符切段，layoutEngine 一段产一个 TextOp。
 */
export function encodeMixed(text: string, preferred: FontKey): EncodedRun[] {
  const runs: EncodedRun[] = []
  for (const ch of text) {
    const g = glyph(ch, preferred)
    const last = runs[runs.length - 1]
    if (last && last.font === g.font) {
      last.gids.push(g.gid); last.text += g.ch; last.units += g.w
    } else {
      runs.push({ font: g.font, gids: [g.gid], text: g.ch, units: g.w })
    }
  }
  return runs
}

/** 与 encodeMixed 完全同源的宽度（含缺字回退差异） */
export function measureMixed(text: string, preferred: FontKey, size: number): number {
  let units = 0
  for (const ch of text) units += glyph(ch, preferred).w
  return units / 1000 * size
}

/** CSS 颜色 → PDF "r g b" 三分量。支持 #rgb / #rrggbb / rgb(...) */
export function colorToRgb(value: string): string {
  const s = value.trim()
  let r: number, g: number, b: number
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1]
    const v = parseInt(h, 16)
    r = (v >> 16) & 255; g = (v >> 8) & 255; b = v & 255
  } else {
    const nums = /^rgba?\(([^)]+)\)/i.exec(s)?.[1]
    if (!nums) return '0 0 0'
    const parts = nums.split(',').map(n => parseFloat(n))
    r = parts[0] || 0; g = parts[1] || 0; b = parts[2] || 0
  }
  const f = (n: number) => (Math.round(n / 255 * 1000) / 1000).toString()
  return `${f(r)} ${f(g)} ${f(b)}`
}

export interface Tokens {
  ink: string
  muted: string
  link: string
  codeBg: string
  codeInk: string
  quoteBorder: string
  hr: string
  h2Border: string
  tocBorder: string
  tocBg: string
  tableBorder: string
  highlight: string
  inlineBg: string
  pageBg: string
  /**
   * 脚注描述色。webview 侧 `.footnote-content` 是正文色 opacity:0.6，
   * 这里按 pageBg 预混出等价实色，避免 PDF 额外 alpha。
   */
  footnoteInk: string
  /** 脚注回链 ↩：webview 侧是主色 opacity:0.6，同样预混成实色。 */
  footnoteBack: string
  /** 主题主色（脚注引用端 / 回链；编辑器 primaryColor）。 */
  primary: string
}

/** 对齐 _editor-typography.scss / _editor-code.scss / _editor-alerts.scss 的导出侧取值 */
const LIGHT: Tokens = {
  ink: '#333333', muted: '#666666', link: '#576b95',
  codeBg: '#f6f6f6', codeInk: '#24292e', quoteBorder: '#cccccc',
  hr: '#dddddd', h2Border: '#eeeeee', tocBorder: '#0F4C81',
  tocBg: '#fcfcfc', tableBorder: '#dddddd', highlight: '#fff3a3',
  inlineBg: '#f0f0f0', pageBg: '#ffffff',
  footnoteInk: '#848484', footnoteBack: '#78aae8', primary: '#1F71D9',
}

const DARK: Tokens = {
  ink: '#d4d4d4', muted: '#9a9a9a', link: '#8ab4f8',
  codeBg: '#252526', codeInk: '#d4d4d4', quoteBorder: '#555555',
  hr: '#444444', h2Border: '#3a3a3a', tocBorder: '#4a90d9',
  tocBg: '#1f1f1f', tableBorder: '#444444', highlight: '#6b5a15',
  inlineBg: '#333333', pageBg: '#1e1e1e',
  footnoteInk: '#959595', footnoteBack: '#416fa5', primary: '#6aa3e0',
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** 把 color 按 alpha 叠到 bg 上返回实色（PDF 没有 CSS alpha，必须预混）。 */
function mixOn(color: string, bg: string, alpha: number): string {
  const c = hexToRgb(color)
  const b = hexToRgb(bg)
  if (!c || !b) return color
  const ch = (i: number) => Math.round(c[i] * alpha + b[i] * (1 - alpha))
  return `#${[ch(0), ch(1), ch(2)].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

export function tokensOf(opts: PdfLayoutOptions): Tokens {
  const base = opts.dark ? DARK : LIGHT
  const primary = opts.primaryColor || base.primary
  return {
    ...base,
    primary,
    // webview 的 opacity:0.6 是相对 pageBg 的，主色可配 → 这里实时预混。
    footnoteInk: mixOn(base.ink, base.pageBg, 0.6),
    footnoteBack: mixOn(primary, base.pageBg, 0.6),
  }
}

export const ALERT_COLORS: Record<string, string> = {
  note: '#0969da', tip: '#1a7f37', important: '#8250df',
  warning: '#bf8700', caution: '#cf222e',
}

/** 用户面板值（mm）→ 布局用 pt；纸张尺寸由 opts.paperSize 决定（默认 A4） */
export function layoutGeometry(opts: PdfLayoutOptions) {
  const m = opts.margins
  const paper = PDF_PAPER_SIZES[opts.paperSize ?? 'a4'] ?? PDF_PAPER_SIZES.a4
  return {
    pageWidth: paper.width,
    pageHeight: paper.height,
    marginTop: m.vertical * MM_TO_PT,
    marginRight: m.horizontal * MM_TO_PT,
    marginBottom: m.vertical * MM_TO_PT,
    marginLeft: m.horizontal * MM_TO_PT,
    bodySize: opts.fontSize,
    lineHeight: opts.fontSize * opts.lineHeight,
  }
}

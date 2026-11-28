// 系统字体查询与子集化 Tauri 封装层(#pdf-font-fidelity)
//
// 薄封装 invoke 调用 Rust 端 fonts 命令,与 git.ts / workspace.ts 同模式:
// 单一入口 + tauriOnly() 守门,非 Tauri 环境(dev web / vitest)静默返回 null / []。
// 测试 mock 统一打本模块,不散布 @tauri-apps/api/core。

import { invoke } from '@tauri-apps/api/core'
import { tauriOnly } from './fs'

export interface SystemFontMeta {
  upem: number
  chars: Record<string, [number, number]>
  widths: number[]
  bbox: number[]
  ascent: number
  descent: number
  capHeight: number
  glyphCount: number
}

interface Type3ImageRaw {
  name: string
  width: number
  height: number
  rgbFlateBase64: string
  alphaFlateBase64?: string
}

export interface Type3Image {
  name: string
  width: number
  height: number
  rgbFlate: Uint8Array
  alphaFlate?: Uint8Array
}

export interface Type3Shading {
  name: string
  pdfDict: string
}

export interface Type3SoftMask {
  name: string
  shadingDict: string
  bbox: [number, number, number, number]
}

interface Type3FontDataRaw {
  charProcs: Record<string, string>
  alphas: [string, number][]
  softMasks?: Type3SoftMask[]
  shadings: Type3Shading[]
  images: Type3ImageRaw[]
}

export interface Type3FontData {
  charProcs: Record<number, string>
  alphas: [string, number][]
  softMasks: Type3SoftMask[]
  shadings: Type3Shading[]
  images: Type3Image[]
}

interface SystemSubsetFontRaw {
  family: string
  weight: number
  italic: boolean
  meta: SystemFontMeta
  ttfBase64?: string
  type3?: Type3FontDataRaw
}

export interface ResolvedSystemFont {
  /** 实际命中的系统字体族名(DOM 预览直接用系统 font-family,与编辑器同源) */
  family: string
  weight: number
  italic: boolean
  meta: SystemFontMeta
  /** 子集 TTF 字节(由 Rust subsetter 生成,供 PDF CIDFontType2 嵌入);纯 Type3 彩色字体时为空 */
  ttf?: Uint8Array
  /** PDF Type3 彩色字形数据(COLR v0/v1 矢量或 sbix/CBDT 位图) */
  type3?: Type3FontData
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function toType3(raw: Type3FontDataRaw): Type3FontData {
  const charProcs: Record<number, string> = {}
  for (const [k, v] of Object.entries(raw.charProcs)) {
    const code = Number(k)
    if (Number.isInteger(code) && code >= 1 && code <= 255) charProcs[code] = v
  }
  return {
    charProcs,
    alphas: raw.alphas,
    softMasks: raw.softMasks ?? [],
    shadings: raw.shadings,
    images: raw.images.map(img => ({
      name: img.name,
      width: img.width,
      height: img.height,
      rgbFlate: decodeBase64(img.rgbFlateBase64),
      alphaFlate: img.alphaFlateBase64 ? decodeBase64(img.alphaFlateBase64) : undefined,
    })),
  }
}

function toResolved(raw: SystemSubsetFontRaw): ResolvedSystemFont {
  return {
    family: raw.family,
    weight: raw.weight,
    italic: raw.italic,
    meta: raw.meta,
    ttf: raw.ttfBase64 ? decodeBase64(raw.ttfBase64) : undefined,
    type3: raw.type3 ? toType3(raw.type3) : undefined,
  }
}

/**
 * 按 CSS 字体族候选列表查找第一个命中的系统字体,并在 Rust 侧按 chars 子集化。
 * 非 Tauri 环境或未命中 / 零字符覆盖时返回 null。
 */
export async function resolveAndSubsetSystemFont(
  families: string[],
  weight: number,
  italic: boolean,
  chars: string,
): Promise<ResolvedSystemFont | null> {
  if (!tauriOnly() || families.length === 0 || !chars) return null
  try {
    const raw = await invoke<SystemSubsetFontRaw | null>('resolve_and_subset_system_font', {
      families,
      weight,
      italic,
      chars,
    })
    return raw ? toResolved(raw) : null
  }
  catch {
    return null
  }
}

/**
 * 为主字体栈均未覆盖的剩余字符查找系统兜底字体并子集化。
 * 非 Tauri 环境返回空数组。
 */
export async function fallbackSubsetSystemFonts(
  missingChars: string,
  weight = 400,
): Promise<ResolvedSystemFont[]> {
  if (!tauriOnly() || !missingChars) return []
  try {
    const list = await invoke<SystemSubsetFontRaw[]>('fallback_subset_system_fonts', {
      missingChars,
      weight,
    })
    return list.map(toResolved)
  }
  catch {
    return []
  }
}

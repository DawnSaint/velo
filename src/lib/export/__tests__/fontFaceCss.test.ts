// fontFaceCss 按需内联逻辑测试。
//
// 测 `resolveBundledFamilies` / `buildFontFaceCss` / `buildAllFontFaceCss`:
// - `resolveBundledFamilies`:从 CSS font-family 栈解析出命中的内嵌字体族
// - `buildFontFaceCss`:按命中族 fetch 对应 .woff2 并生成 @font-face,验"按需 vs 全量"体积差异
//
// jsdom 下没有针对 Vite `?url` 本地路径的 fetch 实现,这里 stub fetch 按路径从磁盘读真实 woff2。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveBundledFamilies, buildFontFaceCss, buildAllFontFaceCss } from '../fontFaceCss'

const PROJECT_ROOT = resolve(__dirname, '../../../..')

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const raw = String(input)
    // Vite dev/vitest `?url` 返回形如 `/src/fonts/.../xxx.woff2` 的相对根路径
    const clean = raw.replace(/^\/+/, '').split('?')[0]
    const bytes = readFileSync(resolve(PROJECT_ROOT, clean))
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }))
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('resolveBundledFamilies', () => {
  it('从单个栈里挑出内嵌族,跳过系统字体', () => {
    const stacks = [`'JetBrains Mono', ui-monospace, Consolas, Menlo, monospace`]
    expect(resolveBundledFamilies(...stacks)).toEqual(['JetBrains Mono'])
  })

  it('跨多个栈合并去重,保持首次出现顺序', () => {
    const sans = `'Google Sans', 'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif`
    const mono = `'Google Sans Code', 'JetBrains Mono', ui-monospace, monospace`
    expect(resolveBundledFamilies(sans, mono)).toEqual([
      'Google Sans',
      'Noto Sans SC',
      'Google Sans Code',
      'JetBrains Mono',
    ])
  })

  it('同一族在两个栈里重复出现时只保留一次', () => {
    expect(
      resolveBundledFamilies(`'Hack', monospace`, `'Hack', Consolas, monospace`),
    ).toEqual(['Hack'])
  })

  it('不带引号的族名也能解析', () => {
    expect(resolveBundledFamilies('DejaVu Sans Mono, monospace')).toEqual([
      'DejaVu Sans Mono',
    ])
  })

  it('全部是系统字体时返回空数组', () => {
    expect(
      resolveBundledFamilies(`'PingFang SC', 'Microsoft YaHei', sans-serif`, `Consolas, monospace`),
    ).toEqual([])
  })

  it('大小写敏感:小写拼写不算命中', () => {
    // 字体族名是 CSS 标识符,'jetbrains mono' ≠ 'JetBrains Mono'
    expect(resolveBundledFamilies(`'jetbrains mono', monospace`)).toEqual([])
  })

  it('空栈不报错', () => {
    expect(resolveBundledFamilies('', '')).toEqual([])
  })

  it('栈里有连续逗号 / 首尾空白时仍正确解析', () => {
    expect(resolveBundledFamilies(`  'Fira Code' , ,  monospace `)).toEqual(['Fira Code'])
  })
})

describe('buildFontFaceCss', () => {
  it('命中族时只生成该族的 @font-face', async () => {
    const css = await buildFontFaceCss(`'JetBrains Mono', ui-monospace, monospace`, 'monospace')
    // 4 个 JetBrains Mono 字重(regular/bold/italic/bold-italic)
    expect(css.match(/@font-face/g)).toHaveLength(4)
    expect(css).toContain("font-family:'JetBrains Mono'")
    // 未选中的字体不该出现
    expect(css).not.toContain('Hack')
    expect(css).not.toContain('Noto Sans SC')
  })

  it('未命中任何内嵌族时返回空串', async () => {
    expect(await buildFontFaceCss(`'PingFang SC', sans-serif`, `Consolas, monospace`)).toBe('')
  })

  it('两个栈都为空时返回空串', async () => {
    expect(await buildFontFaceCss('', '')).toBe('')
  })

  it('按需产出显著小于全量产出', async () => {
    // 典型场景:用户选 JetBrains Mono + 系统 CJK(不命中 Noto Sans SC)
    const picked = await buildFontFaceCss(
      `'PingFang SC', 'Microsoft YaHei', sans-serif`,
      `'JetBrains Mono', ui-monospace, Consolas, monospace`,
    )
    const all = await buildAllFontFaceCss()
    // 按需只含 JetBrains Mono(~500KB b64),全量含 8 款(~5.2MB b64)
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.length).toBeLessThan(all.length / 4)
  })
})

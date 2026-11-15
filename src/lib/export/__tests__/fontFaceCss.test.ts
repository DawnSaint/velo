// fontFaceCss 按需内联逻辑测试。
//
// 只测纯函数 `resolveBundledFamilies` / `buildFontFaceCss`:
// - `resolveBundledFamilies`:从 CSS font-family 栈解析出命中的内嵌字体族
// - `buildFontFaceCss`:按命中族生成 @font-face,并验"按需 vs 全量"的体积差异
//
// 注:vitest 下 Vite 的 `?inline` glob **会**返回真实 base64(与 katexCss.ts
// 注释里"`?inline` 返回空"的说法不同),所以这里能验到真实产出与体积差异。

import { describe, expect, it } from 'vitest'
import { resolveBundledFamilies, buildFontFaceCss, buildAllFontFaceCss } from '../fontFaceCss'

describe('resolveBundledFamilies', () => {
  it('从单个栈里挑出内嵌族,跳过系统字体', () => {
    const stacks = [`'JetBrains Mono', ui-monospace, Consolas, Menlo, monospace`]
    expect(resolveBundledFamilies(...stacks)).toEqual(['JetBrains Mono'])
  })

  it('跨多个栈合并去重,保持首次出现顺序', () => {
    const sans = `'Noto Sans SC', 'Source Han Sans SC", 'Microsoft YaHei', sans-serif`
    const mono = `'JetBrains Mono', ui-monospace, monospace`
    expect(resolveBundledFamilies(sans, mono)).toEqual(['Noto Sans SC', 'JetBrains Mono'])
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
  it('命中族时只生成该族的 @font-face', () => {
    const css = buildFontFaceCss(`'JetBrains Mono', ui-monospace, monospace`, 'monospace')
    // 4 个 JetBrains Mono 字重(regular/bold/italic/bold-italic)
    expect(css.match(/@font-face/g)).toHaveLength(4)
    expect(css).toContain("font-family:'JetBrains Mono'")
    // 未选中的字体不该出现
    expect(css).not.toContain('Hack')
    expect(css).not.toContain('Noto Sans SC')
  })

  it('未命中任何内嵌族时返回空串', () => {
    expect(buildFontFaceCss(`'PingFang SC', sans-serif`, `Consolas, monospace`)).toBe('')
  })

  it('两个栈都为空时返回空串', () => {
    expect(buildFontFaceCss('', '')).toBe('')
  })

  it('按需产出显著小于全量产出', () => {
    // 典型场景:用户选 JetBrains Mono + 系统 CJK(不命中 Noto Sans SC)
    const picked = buildFontFaceCss(
      `'PingFang SC', 'Microsoft YaHei', sans-serif`,
      `'JetBrains Mono', ui-monospace, Consolas, monospace`,
    )
    const all = buildAllFontFaceCss()
    // 按需只含 JetBrains Mono(~500KB b64),全量含 8 款(~5.2MB b64)
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.length).toBeLessThan(all.length / 4)
  })
})

// 语言图标归一化测试。
//
// 背景:文档 code fence 常用简写(js/py/md)或大小写变体(Python),shiki 路径
// 自带 lowercase + alias 路由,高亮正常;但图标层(langIconSvg)做的是裸字符串
// 查表,不归一化会 miss → fallback 图标,出现"高亮对、图标错"。langIconSvg
// 内部 normalizeLang(小写 + LANG_ALIASES 别名解析)修复此问题。
//
// 测行为不测实现:只断言"别名 / 大小写变体产出的 svg 与规范名一致"、
// "未注册 lang 走 fallback 且不崩",不耦合内部表的具体键。

import { describe, expect, it } from 'vitest'
import { langIconSvg } from '../nodes/langIcons'

describe('langIconSvg 别名 / 大小写归一化', () => {
  it('常见简写别名命中同一图标(与规范名产出完全相同)', () => {
    expect(langIconSvg('js', 16)).toBe(langIconSvg('javascript', 16))
    expect(langIconSvg('ts', 16)).toBe(langIconSvg('typescript', 16))
    expect(langIconSvg('py', 16)).toBe(langIconSvg('python', 16))
    expect(langIconSvg('md', 16)).toBe(langIconSvg('markdown', 16))
    expect(langIconSvg('sh', 16)).toBe(langIconSvg('bash', 16))
    expect(langIconSvg('yml', 16)).toBe(langIconSvg('yaml', 16))
    expect(langIconSvg('golang', 16)).toBe(langIconSvg('go', 16))
    expect(langIconSvg('docker', 16)).toBe(langIconSvg('dockerfile', 16))
    expect(langIconSvg('c++', 16)).toBe(langIconSvg('cpp', 16))
    expect(langIconSvg('c#', 16)).toBe(langIconSvg('csharp', 16))
  })

  it('大小写无关:Python==python、JS==javascript、MD==markdown', () => {
    expect(langIconSvg('Python', 16)).toBe(langIconSvg('python', 16))
    expect(langIconSvg('JS', 16)).toBe(langIconSvg('javascript', 16))
    expect(langIconSvg('MD', 16)).toBe(langIconSvg('markdown', 16))
    expect(langIconSvg('Rust', 16)).toBe(langIconSvg('rust', 16))
    expect(langIconSvg('TypeScript', 16)).toBe(langIconSvg('typescript', 16))
  })

  it('别名带品牌色:js 的图标 fill 用 javascript 品牌色 #F7DF1E', () => {
    // 别名归一化后查到 javascript 的品牌色,与直接传 javascript 完全一致
    expect(langIconSvg('js', 14)).toBe(langIconSvg('javascript', 14))
    expect(langIconSvg('js', 14)).toContain('#F7DF1E')
    expect(langIconSvg('Python', 14)).toContain('#3776AB')
  })

  it('未注册 lang 走 fallback code 图标(不崩溃,且与品牌图标不同)', () => {
    const fallback = langIconSvg('xyz-not-registered', 14)
    const brand = langIconSvg('javascript', 14)
    expect(fallback.startsWith('<svg')).toBe(true)
    // fallback body 与任何品牌图标都不同
    expect(fallback).not.toBe(brand)
  })

  it('plain text 别名(text/txt/plaintext)命中 note 图标,与空 lang 一致', () => {
    expect(langIconSvg('text', 16)).toBe(langIconSvg('', 16))
    expect(langIconSvg('txt', 16)).toBe(langIconSvg('', 16))
    expect(langIconSvg('plaintext', 16)).toBe(langIconSvg('', 16))
    // 大小写变体也归一化到 plain text
    expect(langIconSvg('Text', 16)).toBe(langIconSvg('', 16))
  })
})

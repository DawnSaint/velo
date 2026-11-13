// 字符实体引用保真:parse 阶段标注 → PM char_ref mark → toMarkdown 原样写回,
// 以及查找后端能在「解码后的字符」上命中「实体字面量」(全局搜索点击跳转的前提)。

import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'
import { findMatchesInDoc } from '../findreplace/findMatches'
import { getCharRefSegments, scanCharRefs } from '../editor/charRef'

const OPTS = { caseSensitive: false, wholeWord: false, regex: false }

function charRefNodes(doc: PMNode): Array<{ text: string, raws: string[] }> {
  const out: Array<{ text: string, raws: string[] }> = []
  doc.descendants(n => {
    const segments = getCharRefSegments(n)
    if (segments) out.push({ text: n.text ?? '', raws: segments.map(s => s.raw) })
  })
  return out
}

describe('字符实体 parse / stringify 保真', () => {
  it('数字 / 命名实体带 char_ref mark,toMarkdown 原样写回(不退化成普通空格)', () => {
    const md = '实体 &#x20; 与 &nbsp; 及 &amp;'
    const doc = fromMarkdown(md, schema)
    expect(charRefNodes(doc).map(x => x.raws)).toEqual([['&#x20;'], ['&nbsp;'], ['&amp;']])
    expect(toMarkdown(doc).trim()).toBe(md)
  })

  it('strong 边界的实体不被 wrapAttention 移出界定符(用户报告的 &#x20;/&#x20; 场景)', () => {
    const md = '**&#x20;/ &#x20;**'
    const doc = fromMarkdown(md, schema)
    expect(charRefNodes(doc).map(x => x.raws)).toEqual([['&#x20;'], ['&#x20;']])
    expect(toMarkdown(doc).trim()).toBe(md)
  })

  it('连写实体合成一个 text 节点,segments 保序,往返不丢', () => {
    const md = '首尾&#x20;&#8203;相邻'
    const doc = fromMarkdown(md, schema)
    expect(charRefNodes(doc)).toEqual([{ text: ' \u200B', raws: ['&#x20;', '&#8203;'] }])
    expect(toMarkdown(doc).trim()).toBe(md)
  })

  it('标题 / 链接 / 列表里的实体同样保真', () => {
    const md = '# 标题&#x20;结尾\n\n[链接&#x20;名](/a) 与 - 列表&#x20;项\n'
    const doc = fromMarkdown(md, schema)
    expect(charRefNodes(doc).map(x => x.raws)).toEqual([['&#x20;'], ['&#x20;'], ['&#x20;']])
    expect(toMarkdown(doc)).toContain('标题&#x20;结尾')
    expect(toMarkdown(doc)).toContain('[链接&#x20;名](/a)')
  })

  it('行内代码 / 围栏代码块里的字面实体不标注,也不被改写', () => {
    const md = '`代码 &#x20;`\n\n```md\n代码 &#x20;\n```\n'
    const doc = fromMarkdown(md, schema)
    expect(charRefNodes(doc)).toEqual([])
    expect(toMarkdown(doc)).toContain('`代码 &#x20;`')
  })

  it('普通文本 / 裸 & / 反斜杠转义不产生 mark', () => {
    const doc = fromMarkdown('普通 & 符号与 \\* 转义及无实体文本', schema)
    expect(charRefNodes(doc)).toEqual([])
    expect(toMarkdown(doc)).toContain('\\*')
  })

  it('scanCharRefs 解码串对不上时返回 null(宁可不标注也不错位)', () => {
    expect(scanCharRefs('&#x20;', 'x')).toBeNull()
    expect(scanCharRefs('a\\*b', 'a*b')).toEqual([])
  })

  it('往返幂等:toMarkdown(fromMarkdown(toMarkdown(doc))) 与首次输出一致', () => {
    const md = '**&#x20;/ &#x20;** 与 &nbsp; 及 &amp;'
    const once = toMarkdown(fromMarkdown(md, schema))
    expect(toMarkdown(fromMarkdown(once, schema))).toBe(once)
  })
})

describe('查找后端命中字符实体', () => {
  it('搜实体字面量落到解码字符的 PM 坐标(全局搜索点击可跳转)', () => {
    const doc = fromMarkdown('a &#x20; b', schema)
    expect(findMatchesInDoc(doc, '&#x20;', OPTS)).toEqual([{ from: 3, to: 4 }])
  })

  it('搜解码后的空格仍命中(不丢原有语义)', () => {
    const doc = fromMarkdown('a &#x20; b', schema)
    expect(findMatchesInDoc(doc, ' ', OPTS)).toEqual([
      { from: 2, to: 3 }, { from: 3, to: 4 }, { from: 4, to: 5 },
    ])
  })

  it('多处实体按 doc 顺序 / ordinal 对齐', () => {
    const doc = fromMarkdown('**&#x20;/ &#x20;**', schema)
    expect(findMatchesInDoc(doc, '&#x20;', OPTS)).toEqual([
      { from: 1, to: 2 }, { from: 4, to: 5 },
    ])
  })

  it('只覆盖字面量一部分的查询夹到整个实体,不产零宽区间', () => {
    const doc = fromMarkdown('a &#x20; b', schema)
    expect(findMatchesInDoc(doc, 'x20', OPTS)).toEqual([{ from: 3, to: 4 }])
  })

  it('代码块里的字面实体仍按原文命中(与 raw 逐行扫描计数对齐)', () => {
    const doc = fromMarkdown('```md\n代码 &#x20;\n```\n', schema)
    expect(findMatchesInDoc(doc, '&#x20;', OPTS)).toEqual([{ from: 4, to: 10 }])
  })
})

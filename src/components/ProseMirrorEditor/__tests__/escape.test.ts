// 反斜杠转义（escape mark）与 `**_xxx_**` 粗斜体解析的 markdownIO / 查找回归测试。

import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from 'prosemirror-model'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'
import { hasEscapeMark } from '../editor/escape'
import { findMatchesInDoc } from '../findreplace/findMatches'

const OPTS = { caseSensitive: false, wholeWord: false, regex: false }

function escapedTexts(doc: PMNode): string[] {
  const out: string[] = []
  doc.descendants((n) => {
    if (hasEscapeMark(n)) out.push(n.text ?? '')
  })
  return out
}

function collectMarks(doc: PMNode, text: string): string[] {
  const marks: string[] = []
  doc.descendants((n) => {
    if (n.isText && n.text === text) {
      marks.push(...n.marks.map(m => m.type.name))
    }
  })
  return marks
}

describe('反斜杠转义 parse / stringify 保真', () => {
  it('用户场景：第一个 * 前加 \\ 后整段不再解析为斜体，且 \\* 与 \\[ 均带 escape mark', () => {
    const md = '以一张128\\*128图像为例（如人脸图像），展示数世界到底有多复杂。遍历每一个像素（特征）将其在区间\\[0,255]上连续取值，保持其余(128*-1）个特征不变。'
    const doc = fromMarkdown(md, schema)

    let hasEmphasis = false
    doc.descendants((n) => {
      if (n.isText && n.marks.some(m => m.type.name === 'emphasis')) hasEmphasis = true
    })
    expect(hasEmphasis).toBe(false)
    expect(escapedTexts(doc)).toEqual(['*', '['])
    expect(doc.textContent).toContain('128*128')
    expect(doc.textContent).toContain('[0,255]')

    // round-trip 稳定且不产出斜体
    const once = toMarkdown(doc)
    expect(once).toContain('128\\*128')
    expect(once).toContain('\\[0,255]')
    expect(toMarkdown(fromMarkdown(once, schema))).toBe(once)
  })

  it('转义后的 ** / == / ^ / ~ / :smile: / [TOC] 均不触发对应语法', () => {
    const cases = [
      { md: '\\*\\*not bold\\*\\*', forbiddenMark: 'strong' },
      { md: '中文\\*\\*not bold\\*\\*中文', forbiddenMark: 'strong' },
      { md: '\\==not highlight\\==', forbiddenMark: 'highlight' },
      { md: '\\^sup\\^', forbiddenMark: 'superscript' },
      { md: '\\~sub\\~', forbiddenMark: 'subscript' },
    ]
    for (const { md, forbiddenMark } of cases) {
      const doc = fromMarkdown(md, schema)
      let found = false
      doc.descendants((n) => {
        if (n.isText && n.marks.some(m => m.type.name === forbiddenMark)) found = true
      })
      expect(found, md).toBe(false)
      const back = toMarkdown(doc)
      expect(toMarkdown(fromMarkdown(back, schema)), md).toBe(back)
    }

    const emojiDoc = fromMarkdown('\\:smile:', schema)
    let hasEmoji = false
    emojiDoc.descendants((n) => { if (n.type.name === 'emoji') hasEmoji = true })
    expect(hasEmoji).toBe(false)
    expect(escapedTexts(emojiDoc)).toEqual([':'])

    const tocDoc = fromMarkdown('\\[TOC]', schema)
    expect(tocDoc.firstChild!.type.name).toBe('paragraph')
    expect(escapedTexts(tocDoc)).toEqual(['['])
  })

  it('行内代码与代码块里的 \\* 不带 escape mark 且原文保真', () => {
    const md = '`a \\* b`\n\n```md\na \\* b\n```\n'
    const doc = fromMarkdown(md, schema)
    expect(escapedTexts(doc)).toEqual([])
    expect(toMarkdown(doc)).toContain('`a \\* b`')
    expect(toMarkdown(doc)).toContain('a \\* b')
  })

  it('粗体内部包含转义符号 **a \\* b** 往返保真', () => {
    const md = '**a \\* b**'
    const doc = fromMarkdown(md, schema)
    expect(escapedTexts(doc)).toEqual(['*'])
    expect(toMarkdown(doc).trim()).toBe(md)
  })

  it('转义反斜杠 \\\\ 往返幂等', () => {
    const md = 'a \\\\ b'
    const doc = fromMarkdown(md, schema)
    expect(doc.textContent).toBe('a \\ b')
    expect(escapedTexts(doc)).toEqual(['\\'])
    expect(toMarkdown(doc).trim()).toBe(md)
  })
})

describe('查找后端命中反斜杠转义', () => {
  it('搜源码 \\* 与搜解码字符 * 都能命中对应位置', () => {
    const doc = fromMarkdown('128\\*128', schema)
    expect(findMatchesInDoc(doc, '\\*', OPTS)).toEqual([{ from: 4, to: 5 }])
    expect(findMatchesInDoc(doc, '*', OPTS)).toEqual([{ from: 4, to: 5 }])
  })
})

describe('**_xxx_** 粗斜体解析与往返', () => {
  it.each([
    '**_xxx_**',
    '中文**_xxx_**中文',
    '这是**_xxx_**。',
    'a**_xxx_**b',
    '中文**_xxx_**',
    '**_xxx_**中文',
    '中文**（_xxx_）**中文',
  ])('解析 %s 时 xxx 同时带 strong 与 emphasis', (md) => {
    const doc = fromMarkdown(md, schema)
    const marks = collectMarks(doc, 'xxx')
    expect(marks).toContain('strong')
    expect(marks).toContain('emphasis')
    // 不残留字面 **
    expect(doc.textContent).not.toContain('**')
    // 往返保真（marker 仍为 ** 与 _）
    const back = toMarkdown(doc).trim()
    expect(back).toBe(md)
  })

  it('同一行多个跨节点 **_a_** 与 **_b_** 均正确解析', () => {
    const md = '前**_a_**中**_b_**后'
    const doc = fromMarkdown(md, schema)
    expect(collectMarks(doc, 'a')).toEqual(expect.arrayContaining(['strong', 'emphasis']))
    expect(collectMarks(doc, 'b')).toEqual(expect.arrayContaining(['strong', 'emphasis']))
    expect(toMarkdown(doc).trim()).toBe(md)
  })

  it('转义的中文 \\*\\*_xxx_\\*\\*中文 保持斜体但不加粗', () => {
    const md = '中文\\*\\*_xxx_\\*\\*中文'
    const doc = fromMarkdown(md, schema)
    const marks = collectMarks(doc, 'xxx')
    expect(marks).toContain('emphasis')
    expect(marks).not.toContain('strong')
  })
})

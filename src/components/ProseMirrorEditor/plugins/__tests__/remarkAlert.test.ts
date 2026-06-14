// remarkAlert visitor 单元测试
//
// 走纯 mdast 输入输出:visit 一个手构 blockquote 的 Root,断言 type 改为 'alert'、
// 加了 variant 字段、首行 [!TYPE] 被剥掉。无需真实 markdown / unified pipeline。

import { describe, expect, it } from 'vitest'
import type { Root, Blockquote, Paragraph, Text } from 'mdast'
import { remarkAlert } from '../remarkAlert'

function blockquoteWithFirstLine(firstLine: string, restChildren: Paragraph['children'] = []): Root {
  const para: Paragraph = {
    type: 'paragraph',
    children: [{ type: 'text', value: firstLine }, ...restChildren],
  }
  const blockquote: Blockquote = { type: 'blockquote', children: [para] }
  return { type: 'root', children: [blockquote] }
}

function runAlert(tree: Root): Root {
  remarkAlert()(tree)
  return tree
}

describe('remarkAlert', () => {
  it.each([
    ['NOTE', 'note'],
    ['TIP', 'tip'],
    ['IMPORTANT', 'important'],
    ['WARNING', 'warning'],
    ['CAUTION', 'caution'],
  ])('[!%s] → variant=%s', (label, expectedVariant) => {
    const tree = blockquoteWithFirstLine(`[!${label}]\nbody text`)
    runAlert(tree)
    const node = tree.children[0] as unknown as { type: string, variant: string, children: Paragraph[] }
    expect(node.type).toBe('alert')
    expect(node.variant).toBe(expectedVariant)
    // 首行的 [!TYPE] 被剥掉,正文保留
    const firstParaText = (node.children[0].children[0] as Text).value
    expect(firstParaText).toBe('body text')
  })

  it('小写 [!note] 也能识别(case-insensitive)', () => {
    const tree = blockquoteWithFirstLine('[!note]\nbody')
    runAlert(tree)
    const node = tree.children[0] as unknown as { type: string, variant: string }
    expect(node.type).toBe('alert')
    expect(node.variant).toBe('note')
  })

  it('未知 type [!FOO] 不变', () => {
    const tree = blockquoteWithFirstLine('[!FOO]\nbody')
    runAlert(tree)
    expect(tree.children[0].type).toBe('blockquote')
  })

  it('普通 blockquote(无 [!TYPE])不变', () => {
    const tree = blockquoteWithFirstLine('regular quote text')
    runAlert(tree)
    expect(tree.children[0].type).toBe('blockquote')
  })

  it('[!TYPE] 在第二行不识别(必须首行)', () => {
    const tree = blockquoteWithFirstLine('not alert\n[!NOTE]\nmore')
    runAlert(tree)
    expect(tree.children[0].type).toBe('blockquote')
  })

  it('[!TYPE] 单独成段(无正文)→ 首段被掏空,正常处理', () => {
    const tree = blockquoteWithFirstLine('[!NOTE]')
    runAlert(tree)
    const node = tree.children[0] as unknown as { type: string, variant: string, children: Paragraph[] }
    expect(node.type).toBe('alert')
    expect(node.variant).toBe('note')
    // 首段空了,会被去掉;blockquote 可能没 children(正常,后续会兜底)
    expect(node.children.length).toBe(0)
  })
})
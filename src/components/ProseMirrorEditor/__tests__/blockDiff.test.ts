import { describe, it, expect } from 'vitest'
import { schema as veloSchema, type VeloSchema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import {
  collectBlocks,
  diffBlocks,
  diffInlineMarkRanges,
  nodeTypeLabel,
} from '../plugins/blockDiff'

function makeDoc(md: string) {
  return fromMarkdown(md, veloSchema as VeloSchema)
}

describe('collectBlocks', () => {
  it('收集顶层 block 及位置 / 文本', () => {
    const doc = makeDoc('# Title\n\nHello world.')
    const blocks = collectBlocks(doc)
    expect(blocks.length).toBe(2)
    expect(blocks[0].node.type.name).toBe('heading')
    expect(blocks[0].pos).toBe(0)
    expect(blocks[1].node.type.name).toBe('paragraph')
    expect(blocks[1].text).toBe('Hello world.')
  })

  it('key 包含 marks 签名:仅加粗就改变 key', () => {
    const a = collectBlocks(makeDoc('Hello world.'))[0]
    const b = collectBlocks(makeDoc('Hello **world**.'))[0]
    expect(a.text).toBe(b.text) // 文本相同
    expect(a.key).not.toBe(b.key) // 但 key 不同(marks 签名)
  })

  it('key 包含非文本 leaf:图片存在与否改变 key', () => {
    const a = collectBlocks(makeDoc('text'))[0]
    const b = collectBlocks(makeDoc('text ![pic](a.png)'))[0]
    expect(a.key).not.toBe(b.key)
  })
})

describe('diffBlocks', () => {
  it('完全相同 → 全部 equal', () => {
    const md = '# Title\n\nHello.'
    const { ops } = diffBlocks(makeDoc(md), makeDoc(md))
    expect(ops.every(o => o.kind === 'equal')).toBe(true)
  })

  it('整段新增 → insert;整段删除 → delete', () => {
    const add = diffBlocks(makeDoc('a'), makeDoc('a\n\nb'))
    expect(add.ops.map(o => o.kind)).toEqual(['equal', 'insert'])

    const del = diffBlocks(makeDoc('a\n\nb'), makeDoc('a'))
    expect(del.ops.map(o => o.kind)).toEqual(['equal', 'delete'])
  })

  it('段落文本修改 → pair', () => {
    const { ops } = diffBlocks(makeDoc('hello world'), makeDoc('hello earth'))
    expect(ops.map(o => o.kind)).toEqual(['pair'])
  })

  it('仅格式变更(文本相同)→ pair(同文异 key 由装饰层标 changed)', () => {
    const { ops, oldBlocks, newBlocks } = diffBlocks(
      makeDoc('Hello world.'),
      makeDoc('Hello **world**.'),
    )
    expect(ops.map(o => o.kind)).toEqual(['pair'])
    const pair = ops[0]
    if (pair.kind !== 'pair') throw new Error('unreachable')
    expect(oldBlocks[pair.oldIndex].text).toBe(newBlocks[pair.newIndex].text)
    expect(oldBlocks[pair.oldIndex].key).not.toBe(newBlocks[pair.newIndex].key)
  })

  it('节点类型变更(段落 → 标题,文本相同)→ pair', () => {
    const { ops } = diffBlocks(makeDoc('Hello'), makeDoc('# Hello'))
    expect(ops.map(o => o.kind)).toEqual(['pair'])
  })

  it('空旧文档(空段落) vs 新内容 → 纯 insert(空块配对退化)', () => {
    const { ops } = diffBlocks(makeDoc(''), makeDoc('Hello world.'))
    expect(ops.map(o => o.kind)).toEqual(['insert'])
  })

  it('新文档为空 → 纯 delete(空块配对退化)', () => {
    const { ops } = diffBlocks(makeDoc('Hello world.'), makeDoc(''))
    expect(ops.map(o => o.kind)).toEqual(['delete'])
  })

  it('图片删除 → delete(非文本节点可见)', () => {
    const { ops } = diffBlocks(makeDoc('![pic](a.png)'), makeDoc(''))
    expect(ops.map(o => o.kind)).toEqual(['delete'])
  })

  it('段落拆分(1 → 2,去空白后文本相同)→ split', () => {
    const { ops } = diffBlocks(makeDoc('hello world'), makeDoc('hello\n\nworld'))
    expect(ops.map(o => o.kind)).toEqual(['split'])
    const op = ops[0]
    if (op.kind !== 'split') throw new Error('unreachable')
    expect(op.oldIndex).toBe(0)
    expect(op.newIndices).toEqual([0, 1])
  })

  it('段落合并(2 → 1,去空白后文本相同)→ merge', () => {
    const { ops } = diffBlocks(makeDoc('hello\n\nworld'), makeDoc('hello world'))
    expect(ops.map(o => o.kind)).toEqual(['merge'])
    const op = ops[0]
    if (op.kind !== 'merge') throw new Error('unreachable')
    expect(op.oldIndices).toEqual([0, 1])
    expect(op.newIndex).toBe(0)
  })

  it('拆分且文本有改动 → 不识别为 split,退化为 pair + insert', () => {
    const { ops } = diffBlocks(makeDoc('hello world'), makeDoc('hello\n\nearth!'))
    expect(ops.map(o => o.kind)).toEqual(['pair', 'insert'])
  })

  it('多段修改逐对 pair', () => {
    const { ops } = diffBlocks(makeDoc('old1\n\nold2'), makeDoc('new1\n\nnew2'))
    expect(ops.map(o => o.kind)).toEqual(['pair', 'pair'])
  })
})

describe('diffInlineMarkRanges', () => {
  it('仅加粗 → 返回加粗文本的区间', () => {
    const oldDoc = makeDoc('Hello world.')
    const newDoc = makeDoc('Hello **world**.')
    const ranges = diffInlineMarkRanges(oldDoc.child(0), newDoc.child(0))
    // 'world' 在 'Hello world.' 中的 offset 是 6..11
    expect(ranges).toEqual([{ from: 6, to: 11 }])
  })

  it('多段格式变化 → 多个区间', () => {
    const oldDoc = makeDoc('a b c')
    const newDoc = makeDoc('**a** b **c**')
    const ranges = diffInlineMarkRanges(oldDoc.child(0), newDoc.child(0))
    expect(ranges).toEqual([{ from: 0, to: 1 }, { from: 4, to: 5 }])
  })

  it('marks 完全相同 → 空数组', () => {
    const doc = makeDoc('Hello **world**.')
    expect(diffInlineMarkRanges(doc.child(0), doc.child(0))).toEqual([])
  })

  it('链接 attrs(href)变化 → 标记区间', () => {
    const oldDoc = makeDoc('[text](https://a.com)')
    const newDoc = makeDoc('[text](https://b.com)')
    const ranges = diffInlineMarkRanges(oldDoc.child(0), newDoc.child(0))
    expect(ranges).toEqual([{ from: 0, to: 4 }])
  })
})

describe('nodeTypeLabel', () => {
  it('常见类型标签', () => {
    expect(nodeTypeLabel(makeDoc('text').child(0))).toBe('段落')
    expect(nodeTypeLabel(makeDoc('## t').child(0))).toBe('标题 2')
    expect(nodeTypeLabel(makeDoc('```js\nx\n```').child(0))).toBe('代码块(js)')
    expect(nodeTypeLabel(makeDoc('a\n\n---\n\nb').child(1))).toBe('分割线')
  })

  it('同类型不同级别(标题 1 vs 标题 2)标签不同 → 可区分 attrs 变更', () => {
    expect(nodeTypeLabel(makeDoc('# t').child(0))).not.toBe(nodeTypeLabel(makeDoc('## t').child(0)))
  })
})

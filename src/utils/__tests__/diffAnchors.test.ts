import { describe, expect, it } from 'vitest'
import { diffLines } from '../lineDiff'
import { extractSourceAnchors, extractWysiwygAnchors } from '../diffAnchors'

describe('extractSourceAnchors', () => {
  it('内容一致时返回空数组', () => {
    const rows = diffLines('a\nb\nc', 'a\nb\nc').filter(l => !l.mergedIntoNext)
    expect(extractSourceAnchors(rows)).toEqual([])
  })

  it('提取多处不连续变更 hunk 并正确分类 added / removed / modified', () => {
    const oldText = ['keep1', 'old-line', 'keep2', 'to-delete', 'keep3'].join('\n')
    const newText = ['keep1', 'new-line', 'keep2', 'keep3', 'added-line'].join('\n')
    const rows = diffLines(oldText, newText).filter(l => !l.mergedIntoNext)
    const anchors = extractSourceAnchors(rows)

    expect(anchors.map(a => a.kind)).toEqual(['modified', 'removed', 'added'])
    expect(anchors.map(a => a.index)).toEqual([0, 1, 2])
    for (const a of anchors) {
      expect(a.startRatio).toBeGreaterThanOrEqual(0)
      expect(a.endRatio).toBeLessThanOrEqual(1)
      expect(a.endRatio).toBeGreaterThan(a.startRatio)
      expect(a.rowIndex).toBeDefined()
    }
  })

  it('纯字符删除的配对修改行归类为 removed', () => {
    const rows = diffLines('hello world', 'hello').filter(l => !l.mergedIntoNext)
    const anchors = extractSourceAnchors(rows)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].kind).toBe('removed')
  })
})

describe('extractWysiwygAnchors', () => {
  it('合并连续变更 entry 为单个 hunk，保留不连续变更的独立锚点', () => {
    const anchors = extractWysiwygAnchors([
      { changed: false, from: 0, to: 10 },
      { changed: true, kind: 'added', from: 10, to: 20 },
      { changed: true, kind: 'added', from: 20, to: 35 },
      { changed: false, from: 35, to: 60 },
      { changed: true, kind: 'removed', from: 60, to: 60 },
      { changed: true, kind: 'added', from: 60, to: 80 },
      { changed: false, from: 80, to: 100 },
    ], 100)

    expect(anchors).toHaveLength(2)
    expect(anchors[0]).toMatchObject({
      index: 0,
      kind: 'added',
      from: 10,
      to: 35,
      startRatio: 0.1,
      endRatio: 0.35,
    })
    expect(anchors[1]).toMatchObject({
      index: 1,
      kind: 'modified',
      from: 60,
      to: 80,
      startRatio: 0.6,
      endRatio: 0.8,
    })
  })

  it('零长 delete widget 与空文档(docSize=0)不产生 NaN', () => {
    const anchors = extractWysiwygAnchors([
      { changed: true, kind: 'removed', from: 0, to: 0 },
    ], 0)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].startRatio).toBe(0)
    expect(anchors[0].endRatio).toBe(0)
  })
})

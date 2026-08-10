import { describe, it, expect } from 'vitest'
import { diffLines } from '../lineDiff'

describe('diffLines', () => {
  it('完全相同的文本 → 全部 unchanged', () => {
    const result = diffLines('a\nb\nc', 'a\nb\nc')
    expect(result.every(l => l.type === 'unchanged')).toBe(true)
    expect(result).toHaveLength(3)
    expect(result.map(l => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('纯新增:旧为空,新有内容', () => {
    const result = diffLines('', 'x\ny')
    expect(result.every(l => l.type === 'added')).toBe(true)
    expect(result.map(l => l.text)).toEqual(['x', 'y'])
  })

  it('纯删除:旧有内容,新为空', () => {
    const result = diffLines('x\ny', '')
    expect(result.every(l => l.type === 'removed')).toBe(true)
    expect(result.map(l => l.text)).toEqual(['x', 'y'])
  })

  it('中间插入一行', () => {
    const result = diffLines('a\nc', 'a\nb\nc')
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: 'unchanged', text: 'a' })
    expect(result[1]).toMatchObject({ type: 'added', text: 'b' })
    expect(result[2]).toMatchObject({ type: 'unchanged', text: 'c' })
  })

  it('中间删除一行', () => {
    const result = diffLines('a\nb\nc', 'a\nc')
    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({ type: 'unchanged', text: 'a' })
    expect(result[1]).toMatchObject({ type: 'removed', text: 'b' })
    expect(result[2]).toMatchObject({ type: 'unchanged', text: 'c' })
  })

  it('修改一行(删旧+加新)', () => {
    const result = diffLines('a\nold\nc', 'a\nnew\nc')
    const types = result.map(l => l.type)
    expect(types).toContain('removed')
    expect(types).toContain('added')
    // a 和 c 仍然 unchanged
    expect(result[0]).toMatchObject({ type: 'unchanged', text: 'a' })
    expect(result[result.length - 1]).toMatchObject({ type: 'unchanged', text: 'c' })
  })

  it('行号正确递增', () => {
    const result = diffLines('a\nb', 'a\nx\nb')
    // a: old=1,new=1 (unchanged)
    expect(result[0]).toMatchObject({ oldLineNumber: 1, newLineNumber: 1 })
    // x: added, new=2
    const added = result.find(l => l.type === 'added')!
    expect(added.newLineNumber).toBe(2)
    // b: old=2,new=3 (unchanged)
    const lastB = result.find(l => l.text === 'b' && l.type === 'unchanged')!
    expect(lastB.oldLineNumber).toBe(2)
    expect(lastB.newLineNumber).toBe(3)
  })

  it('空字符串对比空字符串 → 空数组', () => {
    const result = diffLines('', '')
    expect(result).toHaveLength(0)
  })
})

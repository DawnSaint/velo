import { describe, it, expect } from 'vitest'
import { diffLines, diffChars, extractHunks, isPureCharRemoval } from '../lineDiff'
import type { DiffLine } from '../lineDiff'

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

// ========== Myers 算法正确性测试 ==========

describe('diffLines — Myers 算法', () => {
  it('大段重排:整块移动', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh'
    const newText = 'e\nf\ng\nh\na\nb\nc\nd'
    const result = diffLines(oldText, newText)
    // 应该识别出 a-d 被删除+重新添加,e-h 被删除+重新添加
    // Myers 会把它识别为 delete a-d + insert e-h(前半)+ delete e-h + insert a-d(后半)
    // 或者其他等价的最短编辑序列
    const added = result.filter(l => l.type === 'added')
    const removed = result.filter(l => l.type === 'removed')
    expect(added.length).toBeGreaterThan(0)
    expect(removed.length).toBeGreaterThan(0)
    // 结果应包含所有行
    const allTexts = result.map(l => l.text)
    for (const line of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(allTexts).toContain(line)
    }
  })

  it('连续多行新增', () => {
    const result = diffLines('a\ne', 'a\nb\nc\nd\ne')
    const added = result.filter(l => l.type === 'added')
    expect(added.map(l => l.text)).toEqual(['b', 'c', 'd'])
    expect(added.every(l => l.inlineDiff == null)).toBe(true)
  })

  it('连续多行删除', () => {
    const result = diffLines('a\nb\nc\nd\ne', 'a\ne')
    const removed = result.filter(l => l.type === 'removed')
    expect(removed.map(l => l.text)).toEqual(['b', 'c', 'd'])
    expect(removed.every(l => l.inlineDiff == null)).toBe(true)
  })

  it('空行移动:含空行的 diff', () => {
    const result = diffLines('a\n\nb', 'a\nb')
    const removed = result.filter(l => l.type === 'removed')
    expect(removed.map(l => l.text)).toEqual([''])
  })

  it('纯新增空行', () => {
    const result = diffLines('a\nb', 'a\n\nb')
    const added = result.filter(l => l.type === 'added')
    expect(added.map(l => l.text)).toEqual([''])
  })

  it('大文档(5000+行)性能基线', () => {
    const oldLines: string[] = []
    const newLines: string[] = []
    for (let i = 0; i < 5000; i++) {
      oldLines.push(`line ${i}`)
      // 每 10 行改 1 行
      newLines.push(i % 10 === 0 ? `line ${i} modified` : `line ${i}`)
    }
    const start = performance.now()
    const result = diffLines(oldLines.join('\n'), newLines.join('\n'))
    const elapsed = performance.now() - start
    expect(result.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(500) // 性能基线:< 500ms(宽松,CI 环境波动)
  })

  it('无任何差异:大文档完全相同', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const result = diffLines(text, text)
    expect(result.every(l => l.type === 'unchanged')).toBe(true)
    expect(result).toHaveLength(1000)
  })
})

// ========== 字符级 inline diff 测试 ==========

describe('diffChars', () => {
  it('完全相同 → unchanged', () => {
    const result = diffChars('hello', 'hello')
    expect(result).toEqual([{ type: 'unchanged', text: 'hello' }])
  })

  it('纯新增:旧为空', () => {
    const result = diffChars('', 'abc')
    expect(result).toEqual([{ type: 'added', text: 'abc' }])
  })

  it('纯删除:新为空', () => {
    const result = diffChars('abc', '')
    expect(result).toEqual([{ type: 'removed', text: 'abc' }])
  })

  it('前缀不变,后缀新增', () => {
    const result = diffChars('hello', 'hello world')
    const types = result.map(s => s.type)
    expect(types).toContain('unchanged')
    expect(types).toContain('added')
    // unchanged 部分应是 'hello'
    const unchanged = result.find(s => s.type === 'unchanged')
    expect(unchanged?.text).toBe('hello')
    const added = result.filter(s => s.type === 'added')
    expect(added.map(s => s.text).join('')).toBe(' world')
  })

  it('前缀不变,后缀删除', () => {
    const result = diffChars('hello world', 'hello')
    const unchanged = result.find(s => s.type === 'unchanged')
    expect(unchanged?.text).toBe('hello')
    const removed = result.filter(s => s.type === 'removed')
    expect(removed.map(s => s.text).join('')).toBe(' world')
  })

  it('中间修改:头尾不变', () => {
    const result = diffChars('helloworld', 'helloearth')
    // Myers 可能找到 LCS='hellor'(h,e,l,l,o,r) 而非 'hello'
    // 用重建验证:unchanged+removed = 原文,unchanged+added = 新文
    const reconstructedOld = result
      .filter(s => s.type !== 'added')
      .map(s => s.text)
      .join('')
    const reconstructedNew = result
      .filter(s => s.type !== 'removed')
      .map(s => s.text)
      .join('')
    expect(reconstructedOld).toBe('helloworld')
    expect(reconstructedNew).toBe('helloearth')
    // 确保有 unchanged 部分(头尾公共)
    expect(result.some(s => s.type === 'unchanged')).toBe(true)
  })

  it('完全不同:无公共子序列', () => {
    const result = diffChars('abc', 'xyz')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'removed', text: 'abc' })
    expect(result[1]).toMatchObject({ type: 'added', text: 'xyz' })
  })

  it('超长行降级为整行标记', () => {
    const oldText = 'a'.repeat(501)
    const newText = 'b'.repeat(501)
    const result = diffChars(oldText, newText)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ type: 'removed', text: oldText })
    expect(result[1]).toMatchObject({ type: 'added', text: newText })
  })

  it('合并相邻同类型片段', () => {
    // 'aXbXc' → 'aYbYc'
    // 期望:unchanged('a') + removed('X') + unchanged('b') + removed('X') + unchanged('c')
    //         + added('Y') + ... → 但 Myers 会产生怎样的序列取决于算法
    const result = diffChars('aXbXc', 'aYbYc')
    // 验证:重新拼接后,removed + unchanged 拼出原文本,added + unchanged 拼出新文本
    const reconstructedOld = result
      .filter(s => s.type !== 'added')
      .map(s => s.text)
      .join('')
    const reconstructedNew = result
      .filter(s => s.type !== 'removed')
      .map(s => s.text)
      .join('')
    expect(reconstructedOld).toBe('aXbXc')
    expect(reconstructedNew).toBe('aYbYc')
  })

  it('Unicode 字符正确处理', () => {
    const result = diffChars('你好世界', '你好地球')
    const reconstructedOld = result
      .filter(s => s.type !== 'added')
      .map(s => s.text)
      .join('')
    const reconstructedNew = result
      .filter(s => s.type !== 'removed')
      .map(s => s.text)
      .join('')
    expect(reconstructedOld).toBe('你好世界')
    expect(reconstructedNew).toBe('你好地球')
  })
})

// ========== inlineDiff 在 diffLines 中的集成测试 ==========

describe('diffLines — inlineDiff 集成', () => {
  it('单行修改生成 inlineDiff', () => {
    const result = diffLines('hello world', 'hello earth')
    const removed = result.find(l => l.type === 'removed')
    const added = result.find(l => l.type === 'added')
    expect(removed?.inlineDiff).toBeDefined()
    expect(added?.inlineDiff).toBeDefined()
    // removed 的 inlineDiff 不含 'added' 片段
    expect(removed!.inlineDiff!.every(s => s.type !== 'added')).toBe(true)
    // added 的 inlineDiff 不含 'removed' 片段
    expect(added!.inlineDiff!.every(s => s.type !== 'removed')).toBe(true)
    // 重建验证:removed inlineDiff 的 removed+unchanged = 原文
    const reconstructedOld = removed!.inlineDiff!
      .map(s => s.text)
      .join('')
    const reconstructedNew = added!.inlineDiff!
      .map(s => s.text)
      .join('')
    expect(reconstructedOld).toBe('hello world')
    expect(reconstructedNew).toBe('hello earth')
  })

  it('多行修改逐行生成 inlineDiff', () => {
    const result = diffLines('old1\nold2', 'new1\nnew2')
    const removed = result.filter(l => l.type === 'removed')
    const added = result.filter(l => l.type === 'added')
    // 多行修改现在也逐行做字符级 diff
    expect(removed.every(l => l.inlineDiff != null)).toBe(true)
    expect(added.every(l => l.inlineDiff != null)).toBe(true)
    // 验证 added 行的 inlineDiff 能拼回原文
    const added0 = added.find(l => l.text === 'new1')!
    const reconstructed = added0.inlineDiff!.map(s => s.text).join('')
    expect(reconstructed).toBe('new1')
  })

  it('纯增/纯删不生成 inlineDiff', () => {
    const addedResult = diffLines('', 'new line')
    const added = addedResult.find(l => l.type === 'added')
    expect(added?.inlineDiff).toBeUndefined()

    const removedResult = diffLines('old line', '')
    const removed = removedResult.find(l => l.type === 'removed')
    expect(removed?.inlineDiff).toBeUndefined()
  })

  it('unchanged 行不生成 inlineDiff', () => {
    const result = diffLines('a\nb', 'a\nb')
    expect(result.every(l => l.inlineDiff == null)).toBe(true)
  })
})

// ========== 单行合并渲染(mergedInlineDiff / mergedIntoNext) ==========

describe('diffLines — 修改配对合并渲染', () => {
  it('行尾追加字符:removed 行标 mergedIntoNext,added 行带完整 mergedInlineDiff', () => {
    // 用户场景:'xxx' → 'xxxx',合并视图只显示一行 '+ xxxx',最后一个 x 深绿
    const result = diffLines('xxx', 'xxxx')
    const removed = result.find(l => l.type === 'removed')
    const added = result.find(l => l.type === 'added')
    expect(removed?.mergedIntoNext).toBe(true)
    expect(removed?.mergedInlineDiff).toBeUndefined()
    expect(added?.mergedIntoNext).toBeUndefined()
    expect(added?.mergedInlineDiff).toBeDefined()
    // mergedInlineDiff 含全部三类片段中的 unchanged + added(本例无 removed)
    const segs = added!.mergedInlineDiff!
    expect(segs.map(s => s.type)).toEqual(['unchanged', 'added'])
    expect(segs.map(s => s.text).join('')).toBe('xxxx')
    expect(segs[1].text).toBe('x')
  })

  it('删除字符:mergedInlineDiff 保留 removed 片段(供删除线渲染)', () => {
    const result = diffLines('hello world', 'hello word')
    const added = result.find(l => l.type === 'added')
    const segs = added!.mergedInlineDiff!
    // unchanged + added + removed 拼接可还原新旧文本
    const newText = segs.filter(s => s.type !== 'removed').map(s => s.text).join('')
    const oldText = segs.filter(s => s.type !== 'added').map(s => s.text).join('')
    expect(newText).toBe('hello word')
    expect(oldText).toBe('hello world')
    expect(segs.some(s => s.type === 'removed' && s.text === 'l')).toBe(true)
  })

  it('多行修改逐对标记合并信息', () => {
    const result = diffLines('old1\nold2', 'new1\nnew2')
    const removed = result.filter(l => l.type === 'removed')
    const added = result.filter(l => l.type === 'added')
    expect(removed.every(l => l.mergedIntoNext === true)).toBe(true)
    expect(added.every(l => l.mergedInlineDiff != null)).toBe(true)
  })

  it('纯增/纯删/不变行不带合并字段', () => {
    const pureAdd = diffLines('a', 'a\nb')
    expect(pureAdd.every(l => l.mergedIntoNext == null && l.mergedInlineDiff == null)).toBe(true)

    const pureRemove = diffLines('a\nb', 'a')
    expect(pureRemove.every(l => l.mergedIntoNext == null && l.mergedInlineDiff == null)).toBe(true)

    const unchanged = diffLines('a', 'a')
    expect(unchanged.every(l => l.mergedIntoNext == null && l.mergedInlineDiff == null)).toBe(true)
  })
})

// ========== isPureCharRemoval(纯字符删除判定) ==========

describe('isPureCharRemoval', () => {
  it('只删字符的配对修改 → true(如 `\\$\\$` → `$$`)', () => {
    const result = diffLines('\\$\\$', '$$')
    const added = result.find(l => l.type === 'added')!
    expect(isPureCharRemoval(added)).toBe(true)
    // mergedInlineDiff 中只有 removed + unchanged,无 added
    expect(added.mergedInlineDiff!.some(s => s.type === 'added')).toBe(false)
    expect(added.mergedInlineDiff!.some(s => s.type === 'removed')).toBe(true)
  })

  it('只加字符的配对修改 → false(如 `$$` → `\\$\\$`)', () => {
    const result = diffLines('$$', '\\$\\$')
    const added = result.find(l => l.type === 'added')!
    expect(isPureCharRemoval(added)).toBe(false)
  })

  it('增删混合的配对修改 → false(替换语义,仍按新增渲染)', () => {
    const result = diffLines('old', 'new')
    const added = result.find(l => l.type === 'added')!
    expect(isPureCharRemoval(added)).toBe(false)
  })

  it('整行新增/整行删除/不变行 → false', () => {
    const pureAdd = diffLines('a', 'a\nb').find(l => l.type === 'added')!
    expect(isPureCharRemoval(pureAdd)).toBe(false)

    const pureRemove = diffLines('a\nb', 'a').find(l => l.type === 'removed')!
    expect(isPureCharRemoval(pureRemove)).toBe(false)

    const unchanged = diffLines('a', 'a')[0]
    expect(isPureCharRemoval(unchanged)).toBe(false)
  })
})

// ========== Hunk 级语义测试 ==========

describe('extractHunks', () => {
  it('无差异 → 空 hunk 列表', () => {
    const lines = diffLines('a\nb', 'a\nb')
    expect(extractHunks(lines)).toHaveLength(0)
  })

  it('单个 hunk:连续 added/removed', () => {
    // a,b,c → a,x,y,c: Myers 选 delete(b)+insert(x)+insert(y), D=3
    const lines = diffLines('a\nb\nc', 'a\nx\ny\nc')
    const hunks = extractHunks(lines)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({
      addedCount: 2,
      removedCount: 1,
    })
    expect(hunks[0].endIndex - hunks[0].startIndex).toBe(3)
  })

  it('多个 hunk:被 unchanged 行分隔', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nx\nc\ny')
    const hunks = extractHunks(lines)
    expect(hunks).toHaveLength(2)
    expect(hunks[0].addedCount + hunks[1].addedCount).toBe(2)
  })

  it('纯新增 → 单个 hunk', () => {
    const lines = diffLines('', 'a\nb\nc')
    const hunks = extractHunks(lines)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]).toMatchObject({ addedCount: 3, removedCount: 0 })
  })

  it('hunk 索引正确指向 DiffLine 数组位置', () => {
    const lines: DiffLine[] = [
      { type: 'unchanged', text: 'a', oldLineNumber: 1, newLineNumber: 1 },
      { type: 'removed', text: 'b', oldLineNumber: 2, newLineNumber: 2 },
      { type: 'added', text: 'x', oldLineNumber: 2, newLineNumber: 2 },
      { type: 'unchanged', text: 'c', oldLineNumber: 3, newLineNumber: 3 },
    ]
    const hunks = extractHunks(lines)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].startIndex).toBe(1)
    expect(hunks[0].endIndex).toBe(3)
    expect(hunks[0].addedCount).toBe(1)
    expect(hunks[0].removedCount).toBe(1)
  })
})

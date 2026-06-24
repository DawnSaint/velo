import { describe, it, expect } from 'vitest'
import { fuzzyMatch, fuzzyMatchIndices, filterHeadings } from '../outlineFilter'
import type { HeadingItem } from '../outline'

// ========== helper:从 markdown-like 字符串生成 HeadingItem 树,绕开 parseHeadings 减少依赖 ==========
// 直接手写一棵树更便于构造"匹配祖先链"等定制化场景,且测试 failure 时树形状易读。
function h(level: number, text: string, children: HeadingItem[] = []): HeadingItem {
  return { level, text, displayText: text, children, key: `${level}::${text}` }
}

describe('fuzzyMatch', () => {
  it('空 query 视为匹配全部', () => {
    expect(fuzzyMatch('anything', '')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(fuzzyMatch('Introduction', 'intro')).toBe(true)
    expect(fuzzyMatch('INTRODUCTION', 'intro')).toBe(true)
    expect(fuzzyMatch('Introduction', 'INTRO')).toBe(true)
  })

  it('严格子序列匹配(非子串)', () => {
    // "irc" 在 "Introduction" 中按 i-r-c 出现 → 命中
    expect(fuzzyMatch('Introduction', 'irc')).toBe(true)
    // "abc" 在 "aXbYc" 中按 a-b-c 出现 → 命中
    expect(fuzzyMatch('aXbYc', 'abc')).toBe(true)
  })

  it('子序列顺序错乱不命中', () => {
    expect(fuzzyMatch('abc', 'cba')).toBe(false)
    expect(fuzzyMatch('hello', 'olh')).toBe(false)
  })

  it('query 比 text 长不命中', () => {
    expect(fuzzyMatch('hi', 'hello')).toBe(false)
  })

  it('完全匹配', () => {
    expect(fuzzyMatch('Setup', 'setup')).toBe(true)
  })

  it('空 text + 非空 query 不命中', () => {
    expect(fuzzyMatch('', 'x')).toBe(false)
  })

  it('中文 heading 也按子序列匹配', () => {
    // 中文无大小写,逐字符比较即可
    expect(fuzzyMatch('安装指南', '安装')).toBe(true)
    expect(fuzzyMatch('安装指南', '指南')).toBe(true)
    // 顺序错:南 在 指 之后,query "南指" 要先找南再找指,失败
    expect(fuzzyMatch('安装指南', '南指')).toBe(false)
    expect(fuzzyMatch('安装指南', '指安')).toBe(false)
  })
})

describe('fuzzyMatchIndices', () => {
  it('空 query 返回空数组(代表"全部命中"语义,与 fuzzyMatch 对齐)', () => {
    expect(fuzzyMatchIndices('anything', '')).toEqual([])
  })

  it('完全匹配 → 所有字符索引', () => {
    expect(fuzzyMatchIndices('hello', 'hello')).toEqual([0, 1, 2, 3, 4])
  })

  it('子序列匹配返回被吃掉的字符索引', () => {
    // "hl" 在 "hello" 中按 h-l 取走下标 0 和 2
    expect(fuzzyMatchIndices('hello', 'hl')).toEqual([0, 2])
    // "abc" 在 "aXbYc" 中按 a-b-c 取走 0,2,4
    expect(fuzzyMatchIndices('aXbYc', 'abc')).toEqual([0, 2, 4])
  })

  it('大小写不敏感', () => {
    expect(fuzzyMatchIndices('Hello', 'hl')).toEqual([0, 2])
    expect(fuzzyMatchIndices('HELLO', 'hello')).toEqual([0, 1, 2, 3, 4])
  })

  it('不命中返回 null', () => {
    expect(fuzzyMatchIndices('hello', 'xyz')).toBeNull()
  })

  it('query 比 text 长返回 null', () => {
    expect(fuzzyMatchIndices('hi', 'hello')).toBeNull()
  })

  it('顺序错乱 → null', () => {
    expect(fuzzyMatchIndices('hello', 'lh')).toBeNull()
  })

  it('中文也能正确取索引', () => {
    expect(fuzzyMatchIndices('安装指南', '安装')).toEqual([0, 1])
    expect(fuzzyMatchIndices('安装指南', '指南')).toEqual([2, 3])
  })

  it('空 text + 非空 query → null', () => {
    expect(fuzzyMatchIndices('', 'x')).toBeNull()
  })

  it('空 text + 空 query → []', () => {
    expect(fuzzyMatchIndices('', '')).toEqual([])
  })
})

describe('filterHeadings', () => {
  it('空 query 返回空集合', () => {
    const tree = [h(1, 'Hello'), h(1, 'World')]
    const { matchKeys, matchIndices } = filterHeadings(tree, '')
    expect(matchKeys.size).toBe(0)
    expect(matchIndices.size).toBe(0)
  })

  it('纯空白 query 视为空', () => {
    const tree = [h(1, 'Hello')]
    const { matchKeys, matchIndices } = filterHeadings(tree, '   \t  ')
    expect(matchKeys.size).toBe(0)
    expect(matchIndices.size).toBe(0)
  })

  it('叶子命中 → 仅自身进 matchKeys', () => {
    const tree = [h(1, 'Hello'), h(1, 'World')]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'hello')
    expect(matchKeys).toEqual(new Set(['1::Hello']))
    expect(matchIndices.get('1::Hello')).toEqual([0, 1, 2, 3, 4])
  })

  it('深层命中 → 仍能捕获(祖先不展示但 DFS 走到深层)', () => {
    // 树:Root → Intro → Install → Steps
    const tree = [
      h(1, 'Root', [
        h(2, 'Intro', [
          h(3, 'Install', [
            h(4, 'Steps'),
          ]),
        ]),
      ]),
    ]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'steps')
    expect(matchKeys).toEqual(new Set(['4::Steps']))
    expect(matchIndices.get('4::Steps')).toEqual([0, 1, 2, 3, 4])
    // 祖先未命中 → 不进 matchKeys(matchIndices 也无对应条目)
    expect(matchIndices.has('1::Root')).toBe(false)
    expect(matchIndices.has('2::Intro')).toBe(false)
  })

  it('多个不连续命中 → 各 key 各自保留索引', () => {
    // 树:
    //   Root
    //   ├── A (命中 "a")
    //   └── B
    //       └── Apple (命中 "a" 子序列)
    const tree = [
      h(1, 'Root', [
        h(2, 'A'),
        h(2, 'B', [h(3, 'Apple')]),
      ]),
    ]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'a')
    expect(matchKeys).toEqual(new Set(['2::A', '3::Apple']))
    // 'A' 单字符 → 索引 [0];'Apple' 子序列匹配 'a' → 索引 [0]
    expect(matchIndices.get('2::A')).toEqual([0])
    expect(matchIndices.get('3::Apple')).toEqual([0])
  })

  it('父命中 → 子未命中时,子不进 matchKeys', () => {
    // A 命中,B 是 A 的子但未命中 → B 不进 matchKeys
    const tree = [
      h(1, 'A', [h(2, 'B'), h(2, 'C')]),
    ]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'a')
    expect(matchKeys).toEqual(new Set(['1::A']))
    expect(matchIndices.size).toBe(1)
  })

  it('无命中 → 两集合都空', () => {
    const tree = [h(1, 'Hello'), h(1, 'World', [h(2, 'Foo')])]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'xyz')
    expect(matchKeys.size).toBe(0)
    expect(matchIndices.size).toBe(0)
  })

  it('子序列匹配生效', () => {
    // 命中 "Introduction" 需要 "irc"(fuzzy)
    const tree = [h(1, 'Introduction')]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'irc')
    expect(matchKeys).toEqual(new Set(['1::Introduction']))
    // Introduction: I(0) n(1) t(2) r(3) o(4) d(5) u(6) c(7) t(8) i(9) o(10) n(11)
    // "irc" 走 i-r-c → 索引 0, 3, 7
    expect(matchIndices.get('1::Introduction')).toEqual([0, 3, 7])
  })

  it('displayText 上的 markdown 标记被匹配(因为我们读 displayText)', () => {
    // outline.ts 的 parseHeadings 已经把 **Bold** → Bold;模拟之
    const tree = [h(1, 'Bold title')]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'bold')
    expect(matchKeys).toEqual(new Set(['1::Bold title']))
    expect(matchIndices.get('1::Bold title')).toEqual([0, 1, 2, 3])
  })

  it('空树 + 非空 query → 两集合都空', () => {
    const { matchKeys, matchIndices } = filterHeadings([], 'hello')
    expect(matchKeys.size).toBe(0)
    expect(matchIndices.size).toBe(0)
  })

  it('多根节点的树分别处理', () => {
    // 两个 root:One / Two;Two 下面有命中,One 无关
    const tree = [
      h(1, 'One', [h(2, 'Child1')]),
      h(1, 'Two', [h(2, 'Inner', [h(3, 'Deep')])]),
    ]
    const { matchKeys, matchIndices } = filterHeadings(tree, 'deep')
    expect(matchKeys).toEqual(new Set(['3::Deep']))
    expect(matchIndices.get('3::Deep')).toEqual([0, 1, 2, 3])
    // One 那条分支无命中 → 不进来
    expect(matchIndices.has('1::One')).toBe(false)
    expect(matchIndices.has('1::Two')).toBe(false)
    expect(matchIndices.has('2::Inner')).toBe(false)
  })
})
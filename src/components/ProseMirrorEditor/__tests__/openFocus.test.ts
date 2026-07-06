import { describe, expect, it } from 'vitest'
import { TextSelection } from 'prosemirror-state'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import { decideOpenFocus } from '../editor/openFocus'

function docFromMd(md: string) {
  return fromMarkdown(md, schema)
}

describe('decideOpenFocus', () => {
  it('空文档(只有一个空段落) → focus + 选区落在空段内', () => {
    const doc = docFromMd('')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(true)
    expect(policy.selection.head).toBe(TextSelection.atEnd(doc).head)
    expect(policy.selection.head).toBeGreaterThan(0)
  })

  it('非空内容 + 尾空段(标题 + 空段,需 ≥ 2 个尾换行)→ 不抢焦点 + 选区 atStart', () => {
    // 早期规则"最后一节点是空段落 → focus atEnd"会把这种 doc 也判为应 focus,
    // 与打字机模式叠加会开屏跳到末行 —— 现收紧为只有整个文档唯一空段才 focus。
    // remark-parse 吞掉单次尾换行;'\n\n\n' 才保留 1 个 trailing empty paragraph
    const doc = docFromMd('# Title\n\n\n')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(false)
    expect(policy.selection.head).toBe(TextSelection.atStart(doc).head)
  })

  it('标题后只有 1 个尾换行 → remark 吞掉,doc 无空段 → 不主动 focus + 选区 atStart', () => {
    const doc = docFromMd('# Title\n\n')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(false)
    expect(policy.selection.head).toBe(TextSelection.atStart(doc).head)
  })

  it('以非空段落结尾 → 不主动 focus + 选区 atStart', () => {
    const doc = docFromMd('# Title\n\n末尾段落有内容')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(false)
    expect(policy.selection.head).toBe(TextSelection.atStart(doc).head)
  })

  it('以 heading 结尾 → 不主动 focus + 选区 atStart', () => {
    const doc = docFromMd('# OnlyHeading')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(false)
    expect(policy.selection.head).toBe(TextSelection.atStart(doc).head)
  })

  it('以 code block 结尾 → 不主动 focus + 选区 atStart(只有 paragraph 算"行")', () => {
    const doc = docFromMd('# Title\n\n```js\nconst x = 1\n```')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(false)
    expect(policy.selection.head).toBe(TextSelection.atStart(doc).head)
  })

  // 原 TODO #2:MD 顶部是目录的时候,进入 MD 文件会自动选中目录
  it('原 TODO #2 场景:顶部 [TOC] 内容非空 → 不主动 focus + 选区 atStart(不抢焦点)', () => {
    const doc = docFromMd('[TOC]\n\n# Section A\n\nbody')
    const policy = decideOpenFocus(doc)
    expect(policy.shouldFocus).toBe(false)
    expect(policy.selection.head).toBe(TextSelection.atStart(doc).head)
  })

  // NEW TODO:打开 B 文档时若不在开头(A doc 已下拉到非开头位置),需复位到开头
  it('打开新文档的通用场景:任何非空段结尾 → 选区强制 atStart', () => {
    const cases = [
      '# Title',
      '# Title\n\n末尾段落有内容',
      '[TOC]\n\n# Section A\n\nbody',
      '# h1\n## h2\n\nparagraph content with some length to make scrolling meaningful',
    ]
    for (const md of cases) {
      const doc = docFromMd(md)
      const policy = decideOpenFocus(doc)
      expect(policy.shouldFocus, `shouldFocus for ${JSON.stringify(md)}`).toBe(false)
      expect(policy.selection.head, `selection.head for ${JSON.stringify(md)}`)
        .toBe(TextSelection.atStart(doc).head)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { schema } from '@/components/ProseMirrorEditor/editor/schema'
import { fromMarkdown } from '@/components/ProseMirrorEditor/editor/markdownIO'
import { headingChainFromDoc, headingChainFromMarkdown } from '@/utils/breadcrumbs'

function docFromMd(md: string) {
  return fromMarkdown(md, schema)
}

describe('headingChainFromDoc', () => {
  it('无标题 → 空链', () => {
    const doc = docFromMd('只是普通段落\n\n另一段')
    expect(headingChainFromDoc(doc, 1)).toEqual([])
  })

  it('光标在一级标题下 → 链含该 h1', () => {
    const doc = docFromMd('# Title\n\n内容')
    // 光标在"内容"段落里
    const pos = doc.content.size
    const chain = headingChainFromDoc(doc, pos)
    expect(chain).toEqual([{ level: 1, text: 'Title' }])
  })

  it('嵌套标题: h1 > h2 > h3 → 链含三层', () => {
    const doc = docFromMd('# A\n\n## B\n\n### C\n\n内容')
    const pos = doc.content.size
    const chain = headingChainFromDoc(doc, pos)
    expect(chain).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 3, text: 'C' },
    ])
  })

  it('同级标题弹出前一个:h1 > h2a,然后 h2b → 链只剩 h1 + h2b', () => {
    const doc = docFromMd('# A\n\n## B1\n\ntext1\n\n## B2\n\ntext2')
    const pos = doc.content.size
    const chain = headingChainFromDoc(doc, pos)
    expect(chain).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B2' },
    ])
  })

  it('高级标题弹出低级:h1 > h2,然后 h1 第二个 → 链只有第二个 h1', () => {
    const doc = docFromMd('# A\n\n## B\n\n# C\n\n内容')
    const pos = doc.content.size
    const chain = headingChainFromDoc(doc, pos)
    expect(chain).toEqual([{ level: 1, text: 'C' }])
  })

  it('光标在标题自身内部 → 该标题计入链', () => {
    const doc = docFromMd('# Title\n\ncontent')
    // 找到标题节点的起始位置
    let headingPos = 0
    doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        headingPos = pos + 1 // 标题内部
        return false
      }
      return true
    })
    const chain = headingChainFromDoc(doc, headingPos)
    expect(chain).toEqual([{ level: 1, text: 'Title' }])
  })

  it('光标在第一个标题之前 → 空链', () => {
    const doc = docFromMd('# Title\n\ncontent')
    // pos=0 是文档开头,在标题之前
    const chain = headingChainFromDoc(doc, 0)
    expect(chain).toEqual([])
  })
})

describe('headingChainFromMarkdown', () => {
  it('无标题 → 空链', () => {
    expect(headingChainFromMarkdown('普通文本\n\n另一段', 3)).toEqual([])
  })

  it('嵌套标题到光标行 → 链含祖先', () => {
    const md = '# A\n\n## B\n\n### C\n\n内容'
    // 光标在第 7 行(1-based),即"内容"行
    const chain = headingChainFromMarkdown(md, 7)
    expect(chain).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 3, text: 'C' },
    ])
  })

  it('光标行在标题行本身 → 该标题计入链', () => {
    const md = '# Title\n\ncontent'
    // 光标在第 1 行(标题行)
    const chain = headingChainFromMarkdown(md, 1)
    expect(chain).toEqual([{ level: 1, text: 'Title' }])
  })

  it('同级标题弹出前一个', () => {
    const md = '# A\n\n## B1\n\ntext\n\n## B2\n\ntext2'
    // 光标在第 7 行(text2)
    const chain = headingChainFromMarkdown(md, 7)
    expect(chain).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B2' },
    ])
  })

  it('高级标题弹出低级', () => {
    const md = '# A\n\n## B\n\n# C\n\ncontent'
    const chain = headingChainFromMarkdown(md, 6)
    expect(chain).toEqual([{ level: 1, text: 'C' }])
  })

  it('围栏代码块内的 # 不被误判为标题', () => {
    const md = '# Title\n\n```python\n# 这是注释\nx = 1\n```\n\ncontent'
    // 光标在最后一行
    const chain = headingChainFromMarkdown(md, 7)
    expect(chain).toEqual([{ level: 1, text: 'Title' }])
  })

  it('围栏 ~~~ 代码块内的 # 不被误判', () => {
    const md = '# Title\n\n~~~\n# comment\n~~~\n\ncontent'
    const chain = headingChainFromMarkdown(md, 6)
    expect(chain).toEqual([{ level: 1, text: 'Title' }])
  })

  it('cursorLine 超过总行数 → 截到末行', () => {
    const md = '# A\n\n## B\n\ncontent'
    const chain = headingChainFromMarkdown(md, 999)
    expect(chain).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
    ])
  })

  it('标题含 markdown 格式 → stripFormatting 去标记', () => {
    const md = '# **Bold** Title\n\ncontent'
    const chain = headingChainFromMarkdown(md, 3)
    expect(chain).toEqual([{ level: 1, text: 'Bold Title' }])
  })
})

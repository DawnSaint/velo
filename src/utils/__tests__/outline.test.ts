import { describe, it, expect } from 'vitest'
import { parseHeadings, stripFormatting, stripFencedCodeBlocks, unescapeMarkdown, type HeadingItem } from '../outline'

describe('stripFormatting', () => {
  it('剥离加粗 ** 和 __', () => {
    expect(stripFormatting('**bold** and __also bold__')).toBe('bold and also bold')
  })

  it('剥离斜体 * 和 _', () => {
    expect(stripFormatting('*italic* and _also italic_')).toBe('italic and also italic')
  })

  it('剥离行内 code `...`', () => {
    expect(stripFormatting('use `npm test` here')).toBe('use npm test here')
  })

  it('剥离链接 [text](url) 保留 text', () => {
    expect(stripFormatting('see [docs](https://example.com)')).toBe('see docs')
  })

  it('剥离图片 ![alt](url) 完全', () => {
    expect(stripFormatting('![logo](./logo.png)')).toBe('')
  })

  it('剥离删除线 ~~text~~', () => {
    expect(stripFormatting('this is ~~deleted~~ text')).toBe('this is deleted text')
  })

  it('组合多种格式,按顺序依次剥离', () => {
    expect(stripFormatting('**bold** and *italic* and `code`')).toBe('bold and italic and code')
  })

  // 转义还原:必须先于 stripFormatting,否则带 \ 的源被传到大纲里会多一个 \
  it('取消 \\_ → _ 后再剥离斜体,不会留 \\ 也不会被斜体吞', () => {
    expect(stripFormatting('foo\\_bar')).toBe('foo_bar')
  })
  it('取消 \\* → * 后再剥离斜体', () => {
    expect(stripFormatting('foo\\*bar')).toBe('foo*bar')
  })
  it('取消 \\\\ → \\', () => {
    expect(stripFormatting('path\\\\to\\\\file')).toBe('path\\to\\file')
  })
  it('取消 \\` → `', () => {
    expect(stripFormatting('use \\`npm\\` here')).toBe('use `npm` here')
  })
  it('取消 \\[ \\] \\( \\)', () => {
    expect(stripFormatting('a \\[b\\] \\(c\\)')).toBe('a [b] (c)')
  })
  it('非转义的普通字符不被改', () => {
    expect(stripFormatting('plain text with no escapes')).toBe('plain text with no escapes')
  })
})

describe('unescapeMarkdown', () => {
  it('取消 \\_ → _', () => {
    expect(unescapeMarkdown('foo\\_bar\\_baz')).toBe('foo_bar_baz')
  })
  it('取消 \\* → *', () => {
    expect(unescapeMarkdown('foo\\*bar')).toBe('foo*bar')
  })
  it('取消 \\\\ → \\(反斜杠自身成对)', () => {
    expect(unescapeMarkdown('a\\\\b')).toBe('a\\b')
  })
  it('非转义序列保留原样', () => {
    expect(unescapeMarkdown('a\\nb')).toBe('a\\nb') // \n 不在白名单里
  })
})

describe('stripFencedCodeBlocks', () => {
  it('移除 ``` 围栏并保留行数', () => {
    const input = '# Title\n```js\n# not heading\n# also not\n```\n## Real heading'
    const output = stripFencedCodeBlocks(input)
    expect(output.split('\n').length).toBe(input.split('\n').length)
    expect(output).toContain('# Title')
    expect(output).toContain('## Real heading')
    expect(output).not.toContain('# not heading')
  })

  it('移除 ~~~ 围栏', () => {
    const input = '# Title\n~~~python\n# not heading\n~~~'
    expect(stripFencedCodeBlocks(input)).not.toContain('# not heading')
  })
})

describe('parseHeadings', () => {
  it('解析嵌套 h1 > h2 > h3', () => {
    const md = '# H1\n## H2\n### H3'
    const tree = parseHeadings(md)
    expect(tree).toHaveLength(1)
    expect(tree[0].level).toBe(1)
    expect(tree[0].text).toBe('H1')
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].text).toBe('H2')
    expect(tree[0].children[0].children[0].text).toBe('H3')
  })

  it('同级重复标题生成 #1 #2 稳定 key', () => {
    const md = '# A\n# A\n# A'
    const tree = parseHeadings(md)
    expect(tree).toHaveLength(3)
    expect(tree[0].key).toBe('1::A')
    expect(tree[1].key).toBe('1::A#1')
    expect(tree[2].key).toBe('1::A#2')
  })

  it('围栏代码块内的 # 不被识别为标题', () => {
    const md = '# Real\n```\n# Fake heading\n```\n# Another real'
    const tree = parseHeadings(md)
    expect(tree).toHaveLength(2)
    expect(tree[0].text).toBe('Real')
    expect(tree[1].text).toBe('Another real')
  })

  it('5 级以上标题被忽略(正则只匹配 1~6 个 #)', () => {
    const md = '# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6\n####### h7'
    const tree = parseHeadings(md)

    const collectLevels = (items: HeadingItem[]): number[] =>
      items.flatMap(it => [it.level, ...collectLevels(it.children)])

    expect(collectLevels(tree)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('行内格式剥离到 displayText,text 保留原样', () => {
    const md = '# **Bold** title'
    const tree = parseHeadings(md)
    expect(tree[0].text).toBe('**Bold** title')
    expect(tree[0].displayText).toBe('Bold title')
  })

  it('转义字符:text 保留反斜杠,displayText 还原成字面字符', () => {
    // 模拟 Milkdown 序列化后,标题里有 _ 被转义为 \_
    const md = '# foo\\_bar'
    const tree = parseHeadings(md)
    expect(tree[0].text).toBe('foo\\_bar') // raw 源保留 \_
    expect(tree[0].displayText).toBe('foo_bar') // 大纲显示不带 \
  })

  it('末尾有空行不报错', () => {
    const md = '# Title\n\n\n\n'
    expect(() => parseHeadings(md)).not.toThrow()
    expect(parseHeadings(md)).toHaveLength(1)
  })

  it('末尾无换行也能解析', () => {
    const md = '# Title'
    expect(parseHeadings(md)).toHaveLength(1)
    expect(parseHeadings(md)[0].text).toBe('Title')
  })

  it('空 markdown 返回空树', () => {
    expect(parseHeadings('')).toEqual([])
  })

  it('无标题的 markdown 返回空树', () => {
    expect(parseHeadings('just some text\nand more')).toEqual([])
  })

  it('子标题先于父标题出现时,out-of-order 标题保留在 root,h1 不"收养"', () => {
    // 算法对乱序标题不做"收养":h3 先入 root,h1 也入 root,h2 作为 h1 的子节点。
    // 这是当前实现的有意行为,文档化以便未来有人修改算法时能注意到。
    const md = '### h3\n# h1\n## h2'
    const tree = parseHeadings(md)
    expect(tree).toHaveLength(2)
    expect(tree[0].text).toBe('h3')
    expect(tree[1].text).toBe('h1')
    expect(tree[1].children[0].text).toBe('h2')
  })
})

// Round-trip 测试:fromMarkdown(md) → doc → toMarkdown(doc) → md',
// 比较 normalize(md) === normalize(md')。
//
// normalize 容忍合理的格式漂移:
// - 末尾换行
// - 多个连续空行 → 单空行
// - 中间空白(remark stringify 可能会规整 list 项前的缩进)
//
// 这个测试是 Phase 1 的成功判据。任一 sample 失败都说明 markdownIO 还没收敛,
// 不能进 Phase 2(EditorInner 接入)。

import { describe, expect, it } from 'vitest'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'

function normalize(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')   // 行尾空白
    .replace(/\n{3,}/g, '\n\n') // 多空行折叠
    // 表格列宽对齐空格折叠:`| a  | b  |` → `| a | b |`
    // remark-gfm stringify 会对齐列宽,这是合理格式化,不算语义漂移
    .replace(/\|[ \t]+/g, '| ')
    .replace(/[ \t]+\|/g, ' |')
    .trim()
}

const samples: Array<{ name: string, md: string }> = [
  {
    name: '纯段落',
    md: 'Hello world.',
  },
  {
    name: '标题 1-3 级',
    md: '# H1\n\n## H2\n\n### H3',
  },
  {
    name: '强调:bold / italic / strike',
    md: '**bold** _italic_ ~~strike~~',
  },
  {
    name: '行内 code 与链接',
    md: 'Use `npm install` to add [the package](https://example.com).',
  },
  {
    name: '代码块',
    md: '```js\nconst x = 1\nconsole.log(x)\n```',
  },
  {
    name: '列表 + 任务',
    md: '- normal item\n- [ ] todo\n- [x] done',
  },
  {
    name: '表格',
    md: '| a | b |\n| - | - |\n| 1 | 2 |',
  },
  {
    name: 'mermaid',
    md: '```mermaid\ngraph TD\n  A --> B\n```',
  },
  {
    name: '行内公式 + 块级公式',
    md: 'Energy: $E=mc^2$\n\n$$\nx^2 + y^2 = z^2\n$$',
  },
  {
    name: '脚注',
    md: 'See note[^a].\n\n[^a]: This is the note.',
  },
  {
    name: '警告框 NOTE',
    md: '> [!NOTE]\n> Quick note about something.',
  },
  {
    name: '警告框 WARNING + 多行',
    md: '> [!WARNING]\n> First line.\n>\n> Second paragraph.',
  },
  {
    name: 'HTML 块级 details',
    md: '<details><summary>Click</summary>\n\nHidden content.\n\n</details>',
  },
  {
    name: 'HTML 行内 kbd',
    md: 'Press <kbd>Ctrl+C</kbd> to copy.',
  },
  {
    // 块级 details 嵌 summary + 行内 abbr —— 对齐 src/assets/sample.md 实际写法
    name: 'HTML 块级 details + 行内 abbr',
    md: '<details>\n<summary>点击展开</summary>\n带标题的缩写：<abbr title="Cascading Style Sheets">CSS</abbr>\n</details>',
  },
  {
    name: 'TOC marker',
    md: '[TOC]',
  },
  {
    // TOC 前后有空行也要 round-trip 正常
    name: 'TOC marker with surrounding blank lines',
    md: 'hello\n\n[TOC]\n\nworld',
  },
]

describe('markdownIO round-trip', () => {
  for (const { name, md } of samples) {
    it(name, () => {
      const doc = fromMarkdown(md, schema)
      const back = toMarkdown(doc)
      expect(normalize(back)).toEqual(normalize(md))
    })
  }
})

describe('markdownIO - HTML 节点直接行为', () => {
  it('块级 html 解析为 html_block 节点,attrs.value 是整段原文', () => {
    const md = '<details><summary>x</summary>y</details>'
    const doc = fromMarkdown(md, schema)
    const block = doc.firstChild
    expect(block?.type.name).toBe('html_block')
    expect(block?.attrs.value).toBe(md)
  })

  it('行内 html 区域合并:开标签+文本+闭标签 → 单个完整 html_inline', () => {
    // remark 把 <kbd>Ctrl</kbd> 拆成 3 段(<kbd> / Ctrl / </kbd>),合并层应
    // 收成单个 html_inline,value = '<kbd>Ctrl</kbd>'
    const doc = fromMarkdown('Press <kbd>Ctrl</kbd>.', schema)
    const para = doc.firstChild
    expect(para?.type.name).toBe('paragraph')
    let found = false
    para!.forEach(child => {
      if (child.type.name === 'html_inline' && child.attrs.value === '<kbd>Ctrl</kbd>') {
        found = true
        // atom 节点:不应带 mark
        expect(child.marks.length).toBe(0)
      }
    })
    expect(found).toBe(true)
  })

  it('行内多 HTML 区域:被纯文本隔开,各自合并成独立 html_inline', () => {
    // 模拟 sample.md 行内那串:`<kbd>Ctrl</kbd>+<kbd>C</kbd>`
    // 应该产生 2 个独立的 html_inline,value 各自完整;中间 `+` 仍是 text
    const doc = fromMarkdown('<kbd>Ctrl</kbd>+<kbd>C</kbd>', schema)
    const para = doc.firstChild
    const htmlValues: string[] = []
    para!.forEach(child => {
      if (child.type.name === 'html_inline') {
        htmlValues.push(child.attrs.value as string)
      }
    })
    expect(htmlValues).toEqual(['<kbd>Ctrl</kbd>', '<kbd>C</kbd>'])
  })

  it('行内嵌套 HTML 区域:开闭标签对跨多个 html_inline 节点,合并后嵌套结构保留', () => {
    // <kbd><strong>Ctrl</strong></kbd> → 应合成为单个 html_inline,
    // value = '<kbd><strong>Ctrl</strong></kbd>'
    const doc = fromMarkdown('<kbd><strong>Ctrl</strong></kbd>', schema)
    const para = doc.firstChild
    let found = false
    para!.forEach(child => {
      if (child.type.name === 'html_inline' && child.attrs.value === '<kbd><strong>Ctrl</strong></kbd>') {
        found = true
      }
    })
    expect(found).toBe(true)
  })

  it('空 value 不会产生 html_* 节点(纯文本段落保持原状)', () => {
    // 普通文本不应触发任何 html 节点
    const doc = fromMarkdown('hello world', schema)
    let htmlCount = 0
    doc.descendants(n => {
      if (n.type.name === 'html_block' || n.type.name === 'html_inline') htmlCount++
    })
    expect(htmlCount).toBe(0)
  })
})

describe('markdownIO - 多空行保留(preserveEmptyLine 链路)', () => {
  // 注:多空行 round-trip 验"结构闭合"而不是"字符串相等"。preprocessBlankLines
  // 会把 a\n\n\nb 转成 a\n\n<br />\n\nb(toMarkdown 又会还原成同样形态),
  // 所以源字符串跟回写字符串必然不等 —— 但 doc 结构在 from→to→from 循环后保持一致。

  it('CRLF 行尾的多空行也能被识别(从磁盘读 Windows 文件场景)', () => {
    // 修复前:`a\r\n\r\n\r\nb` 走 preprocessBlankLines 不会变(因 \r 卡住匹配),
    // 最终 doc 没有空 paragraph 占位;现在统一规范化,空段数与 LF 版本一致。
    const docLF = fromMarkdown('a\n\n\nb', schema)
    const docCRLF = fromMarkdown('a\r\n\r\n\r\nb', schema)
    expect(docCRLF.childCount).toBe(docLF.childCount)
    // 验证空段数对齐(LF 走 1 空段,CRLF 走 1 空段)
    const emptyLF = docLF.children.filter(c => c.childCount === 0).length
    const emptyCRLF = docCRLF.children.filter(c => c.childCount === 0).length
    expect(emptyCRLF).toBe(emptyLF)
    expect(emptyCRLF).toBeGreaterThan(0)
  })

  it('URL 含内部空格(中文页内锚点)→ 解析为链接,href 是可读形式(空格已 decode)', () => {
    // 链路:输入 `[text](url with space)` → preprocessor encode 让 remarkParse
    // 接受 → mdast → PM 时再 decode 回可读形式 → doc.link.attrs.href 是
    // 友好形态(用户看到的不是 %20)。
    // toMarkdown 序列化:remark-stringify 检测到 URL 含空格会自动用
    // `<url>` 包裹(标准 CommonMark 行为,跨工具通用),不依赖我们干预。
    const doc = fromMarkdown('页内 [回到开头](# Markdown 语法) 测试。', schema)
    const para = doc.firstChild!
    const linkChild = Array.from({ length: para.childCount }, (_, i) => para.child(i))
      .find(c => c.marks.some(m => m.type.name === 'link'))
    expect(linkChild).toBeDefined()
    const linkMark = linkChild!.marks.find(m => m.type.name === 'link')!
    // href 字段是 "可读形式"(空格未 encode)
    expect(linkMark.attrs.href).toBe('# Markdown 语法')

    // 验证后续 toMarkdown 也不暴露 %20 给用户(走 `<url>` 包裹)
    const back = toMarkdown(doc)
    expect(back).toContain('回到开头](<# Markdown 语法>)')
  })

  it('1 个空段解析为空 paragraph(childCount=0) 节点', () => {
    // a\n\n\nb → preprocess 注入 <br /> → remark-parse 出块级 html
    // → mdastBlockToPM 转空 paragraph。判断空段靠 childCount=0,
    // 不靠 attr 标记(简化 schema,空段行为只看是否有内容)
    const doc = fromMarkdown('a\n\n\nb', schema)
    expect(doc.childCount).toBe(3)
    const [a, mid, b] = doc.children
    expect(a.type.name).toBe('paragraph')
    expect(a.textContent).toBe('a')
    expect(mid.type.name).toBe('paragraph')
    expect(mid.childCount).toBe(0)  // 空段 = 无内容
    expect(b.type.name).toBe('paragraph')
    expect(b.textContent).toBe('b')
  })

  it('2 个空段解析为 2 个空 paragraph(childCount=0) 节点', () => {
    // 新公式下,N=3 → 1 空段,N=4 → 1 空段(都是 ceil 1),N=5 → 2 空段。
    // 用 N=5(3 空行)产生 2 个空段。
    const doc = fromMarkdown('a\n\n\n\n\nb', schema)
    const emptyNodes = doc.children.filter(c => c.childCount === 0)
    expect(emptyNodes.length).toBe(2)
  })

  it('空段 round-trip 结构闭合:doc 形状稳定(不被翻倍)', () => {
    // WIP 链路:preprocessBlankLines 注入 <br /> 块,toMarkdown 用 text 节点占位
    // (而非 html 节点),stringify 后不含 <br />,但 round-trip doc 结构闭合。
    // 验证 1 个空段 → toMarkdown → fromMarkdown 后仍然 1 个空段(N 不变)。
    const md = 'a\n\n\nb'
    const doc1 = fromMarkdown(md, schema)
    const back = toMarkdown(doc1)
    const doc2 = fromMarkdown(back, schema)
    const empty1 = doc1.children.filter(c => c.childCount === 0).length
    const empty2 = doc2.children.filter(c => c.childCount === 0).length
    expect(empty1).toBe(empty2)
    expect(empty1).toBeGreaterThan(0)
  })

  it('round-trip 结构闭合:from→to→from 产出相同 doc 形状', () => {
    // 关键不变量:多空行被 preprocess 注入 <br /> 后,doc 结构稳定。
    // 二次 parse 不会引入额外的空段 / 漏掉空段。
    // 用 N=5(3 空行)→ 2 个 <br /> 段,结构稳定可观察。
    const md = 'a\n\n\n\n\nb\n\nc'  // a-b 间 2 空段,b-c 间 0 空段
    const doc1 = fromMarkdown(md, schema)
    const back = toMarkdown(doc1)
    const doc2 = fromMarkdown(back, schema)
    expect(doc2.childCount).toBe(doc1.childCount)
    for (let i = 0; i < doc1.childCount; i++) {
      expect(doc2.children[i].type.name).toBe(doc1.children[i].type.name)
      expect(doc2.children[i].childCount).toBe(doc1.children[i].childCount)
      expect(doc2.children[i].textContent).toBe(doc1.children[i].textContent)
    }
  })
})

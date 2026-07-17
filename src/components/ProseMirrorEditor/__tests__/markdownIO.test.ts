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
    name: '下划线 underline',
    md: '<u>underlined</u> and <u>nested **bold**</u>',
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
  {
    // hr:block+atom 节点无 attrs,round-trip 严格 idempotent。
    name: '分割线 hr',
    md: 'above\n\n---\n\nbelow',
  },
  {
    // 独立 <img> 标签(仅 src/alt/title)→ image 节点(htmlSource),
    // 序列化写回 <img> 而非 ![](),不规范化为 markdown 语法
    name: 'HTML 独立 img → image 节点 round-trip',
    md: '<img src="pic.png" alt="图片">',
  },
  {
    name: 'HTML 独立 img 带 title round-trip',
    md: '<img src="pic.png" alt="图片" title="标题">',
  },
  {
    name: 'HTML 独立 img 无 alt round-trip',
    md: '<img src="pic.png">',
  },
  {
    name: 'HTML img 含 width round-trip',
    md: '<img src="pic.png" alt="图片" width="100">',
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

  // 表格列对齐走 GFM 分隔行 `|:---:|`,整列同值才能 round-trip 闭合。
  // 列级对齐命令(setCellAlignment)保证同列所有行 alignment 一致,这是该
  // round-trip 成立的前提——pmTableToMdast 只从首行推导 align[]。
  // v0.7.1:列级对齐(setCellAlignment)的前提是同列所有行 alignment 一致,
  // 这样 pmTableToMdast 才能从首行推出完整 align[]。本测试锁定该前提下的
  // 保存/加载状态 round-trip:对齐语义经 toMarkdown → fromMarkdown 后必须保留。
  // (注意:remark-stringify 会对分隔符语法做规范化,如 :--- → -,所以比较 attrs 而非原始字符串)
  it('v0.7.1:表格列对齐经保存/加载后 alignment 语义保留', () => {
    const md = '| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |\n| d | e | f |'
    const doc1 = fromMarkdown(md, schema)
    const aligns1: string[] = []
    doc1.descendants((n) => {
      if (n.type.name === 'table_cell') aligns1.push((n.attrs.alignment as string) || 'left')
    })
    // 保存后再加载,body 6 个 cell 的 alignment 语义应与原来一致。
    const doc2 = fromMarkdown(toMarkdown(doc1), schema)
    const aligns2: string[] = []
    doc2.descendants((n) => {
      if (n.type.name === 'table_cell') aligns2.push((n.attrs.alignment as string) || 'left')
    })
    expect(aligns1).toEqual(['left', 'center', 'right', 'left', 'center', 'right'])
    expect(aligns2).toEqual(aligns1)
  })

  // v0.5.11:WYSIWYG 代码块行号是纯视觉装饰(Decoration.widget),不进
  // schema attrs、不进 markdown 序列化。round-trip 必须严格 idempotent。
  it('v0.5.11:code_block 行号不污染 markdown 文本', () => {
    const md = '```js\nconst a = 1\nconst b = 2\n```'
    expect(normalize(toMarkdown(fromMarkdown(md, schema)))).toEqual(normalize(md))
  })
})

describe('markdownIO - math fence guard', () => {
  it('行首 $$ 后有正文但没有闭合 $$ 时按普通段落解析', () => {
    const md = '$$L_{rank = \\sum_{r_i\n\np为要学习模型的输出\n\n$$p_i = \\frac{\\sum_t log P_\\pi(y_{i,t}|x,y_{i,'
    const doc = fromMarkdown(md, schema)

    let mathCount = 0
    doc.descendants(node => {
      if (node.type.name === 'math_block' || node.type.name === 'math_inline') mathCount++
    })

    expect(mathCount).toBe(0)
    expect(doc.child(0).type.name).toBe('paragraph')
    expect(doc.child(0).textContent).toBe('$$L_{rank = \\sum_{r_i')
    expect(doc.textContent).toContain('$$p_i = \\frac{\\sum_t log P_\\pi')
  })

  it('同一行闭合的 $$...$$ 仍解析为行内公式(保留双 $)', () => {
    const doc = fromMarkdown('$$p_i$$', schema)
    const para = doc.firstChild
    let foundInlineMath = false
    para?.forEach(child => {
      // delimiterCount 保留:$$p_i$$ 解析后 content 仍是 $$p_i$$(双 $)
      if (child.type.name === 'math_inline' && child.textContent === '$$p_i$$') foundInlineMath = true
    })
    expect(foundInlineMath).toBe(true)
  })

  it('$$...$$ 行内公式 round-trip 保留双 $(不降级成单 $)', () => {
    const md = '$$y=f(x)$$ and $x^2$'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(normalize(back)).toEqual(normalize(md))
  })

  it('$$...$$ 行内公式 round-trip(独立段落)', () => {
    const md = 'Force: $$F=ma$$'
    const doc = fromMarkdown(md, schema)
    const back = toMarkdown(doc)
    expect(normalize(back)).toEqual(normalize(md))
  })
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

describe('markdownIO - HTML img 接管为 image 节点', () => {
  it('独立 <img src alt> → image 节点(htmlSource=true)', () => {
    const doc = fromMarkdown('<img src="pic.png" alt="图片">', schema)
    const para = doc.firstChild!
    expect(para.type.name).toBe('paragraph')
    const img = para.firstChild!
    expect(img.type.name).toBe('image')
    expect(img.attrs.src).toBe('pic.png')
    expect(img.attrs.alt).toBe('图片')
    expect(img.attrs.htmlSource).toBe(true)
  })

  it('独立 <img src alt title> → image 节点,title 保留', () => {
    const doc = fromMarkdown('<img src="x.png" alt="a" title="t">', schema)
    const img = doc.firstChild!.firstChild!
    expect(img.type.name).toBe('image')
    expect(img.attrs.title).toBe('t')
    expect(img.attrs.htmlSource).toBe(true)
  })

  it('独立 <img src> (无 alt) → image 节点,alt 空串', () => {
    const doc = fromMarkdown('<img src="x.png">', schema)
    const img = doc.firstChild!.firstChild!
    expect(img.type.name).toBe('image')
    expect(img.attrs.src).toBe('x.png')
    expect(img.attrs.alt).toBe('')
    expect(img.attrs.htmlSource).toBe(true)
  })

  it('<img src alt width> 含额外属性 → image 节点,htmlAttrs 存 width', () => {
    const md = '<img src="x.png" alt="a" width="100">'
    const doc = fromMarkdown(md, schema)
    const img = doc.firstChild!.firstChild!
    expect(img.type.name).toBe('image')
    expect(img.attrs.src).toBe('x.png')
    expect(img.attrs.alt).toBe('a')
    expect(img.attrs.htmlSource).toBe(true)
    expect(img.attrs.htmlAttrs).toEqual({ width: '100' })
  })

  it('<div><img></div> img 嵌套 → 保留 html_block(不接管)', () => {
    const md = '<div><img src="x.png" alt="a"></div>'
    const doc = fromMarkdown(md, schema)
    const block = doc.firstChild!
    expect(block.type.name).toBe('html_block')
    expect(block.attrs.value).toBe(md)
  })

  it('image(htmlSource) 独占段落 → 序列化为 <img> html 块(非 ![]())', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('image', { src: 'x.png', alt: 'a', title: '', htmlSource: true }),
      ]),
    ])
    expect(toMarkdown(doc).trim()).toBe('<img src="x.png" alt="a">')
  })

  it('image(htmlSource) 带 title → 序列化含 title', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('image', { src: 'x.png', alt: 'a', title: 't', htmlSource: true }),
      ]),
    ])
    expect(toMarkdown(doc).trim()).toBe('<img src="x.png" alt="a" title="t">')
  })

  it('image(htmlSource) 含 htmlAttrs → 序列化含额外属性', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('image', { src: 'x.png', alt: 'a', title: '', htmlSource: true, htmlAttrs: { width: '100' } }),
      ]),
    ])
    expect(toMarkdown(doc).trim()).toBe('<img src="x.png" alt="a" width="100">')
  })

  it('普通 image(htmlSource=false) → 序列化为 ![]()(不变)', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.node('image', { src: 'x.png', alt: 'a', title: '', htmlSource: false }),
      ]),
    ])
    expect(toMarkdown(doc).trim()).toBe('![a](x.png)')
  })
})

describe('markdownIO - underline', () => {
  it('<u>text</u> 解析为带 underline mark 的 text 节点', () => {
    const doc = fromMarkdown('<u>hello</u>', schema)
    const para = doc.firstChild!
    expect(para.type.name).toBe('paragraph')
    const textNode = para.firstChild!
    expect(textNode.type.name).toBe('text')
    expect(textNode.text).toBe('hello')
    expect(textNode.marks.some(m => m.type.name === 'underline')).toBe(true)
  })

  it('<u>**bold**</u> 解析为 underline + strong 嵌套 mark', () => {
    const doc = fromMarkdown('<u>**bold**</u>', schema)
    const para = doc.firstChild!
    const textNode = para.firstChild!
    expect(textNode.text).toBe('bold')
    expect(textNode.marks.some(m => m.type.name === 'underline')).toBe(true)
    expect(textNode.marks.some(m => m.type.name === 'strong')).toBe(true)
  })

  it('underline mark 序列化为 <u>text</u>', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('hi', [schema.marks.underline.create()]),
      ]),
    ])
    expect(toMarkdown(doc).trim()).toBe('<u>hi</u>')
  })

  it('<u>text</u> round-trip 闭合', () => {
    const md = 'prefix <u>underlined</u> suffix'
    const back = toMarkdown(fromMarkdown(md, schema))
    expect(normalize(back)).toEqual(normalize(md))
  })

  it('多个 <u> 不混淆,各自独立配对', () => {
    const md = '<u>a</u> and <u>b</u>'
    const back = toMarkdown(fromMarkdown(md, schema))
    expect(normalize(back)).toEqual(normalize(md))
  })

  it('<u> 带属性也被识别为 underline mark', () => {
    const doc = fromMarkdown('<u class="x">text</u>', schema)
    const para = doc.firstChild!
    const textNode = para.firstChild!
    expect(textNode.text).toBe('text')
    expect(textNode.marks.some(m => m.type.name === 'underline')).toBe(true)
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

  it('尾部空行 toMarkdown 严格 idempotent(K≥2 守恒,不再每轮丢 2)', () => {
    // 修复前:processor.stringify 按 CommonMark 吃掉尾部空段,每 round 丢 2\n。
    // 修复后:toMarkdown 出口按 doc 尾部连续空段数补 \n,使
    //   toMarkdown(fromMarkdown(toMarkdown(doc))) === toMarkdown(doc)
    // 严格成立。K=尾部空段数;这里测 K=1..3 对应的磁盘空行数。
    //   磁盘 'b\n\n\n'(2 空行)→ doc K=1 → canonical 'b\n\n\n'  (N=3)
    //   磁盘 'b\n\n\n\n\n'(4 空行)→ doc K=2 → canonical 'b\n\n\n\n\n'(N=5)
    //   磁盘 'b\n\n\n\n\n\n\n'(6 空行)→ doc K=3 → canonical 'b\n\n\n\n\n\n\n'(N=7)
    const cases = ['b\n\n\n', 'b\n\n\n\n\n', 'b\n\n\n\n\n\n\n']
    for (const md of cases) {
      const canon = toMarkdown(fromMarkdown(md, schema))
      const canon2 = toMarkdown(fromMarkdown(canon, schema))
      const canon3 = toMarkdown(fromMarkdown(canon2, schema))
      expect(canon2).toBe(canon)
      expect(canon3).toBe(canon)
    }
  })
})

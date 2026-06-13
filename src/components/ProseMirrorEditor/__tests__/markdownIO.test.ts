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

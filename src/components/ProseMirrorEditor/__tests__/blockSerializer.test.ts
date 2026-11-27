// 块级增量序列化的正确性不变式：任意编辑序列下 incremental(doc) === toMarkdown(doc)。
//
// 这是 #incremental-roundtrip 的验收门。块边界语义(尾部空段 / frontmatter /
// definition / html / TOC / alert / math / table / list / setext / CRLF)全部作为
// 对抗样本覆盖；若新增块类型让「逐块拼接 !== 全量 stringify」，这里先挂。

import { beforeEach, describe, expect, it } from 'vitest'
import { EditorState } from 'prosemirror-state'
import type { Node as PMNode } from 'prosemirror-model'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'
import { schema } from '../editor/schema'
import {
  getBlockCache,
  invalidateBlockCache,
  parseMarkdownForDoc,
  resetBlockCaches,
  serializeDocIncremental,
  setBlockCache,
  toMarkdownIncremental,
  type BlockCache,
} from '../editor/blockSerializer'
import { diffLines } from '@/utils/lineDiff'

const cases: Array<{ name: string; md: string }> = [
  { name: 'plain', md: '# 标题\n\n第一段 **粗** 与 *斜*。\n\n第二段。\n' },
  { name: 'empty-doc', md: '' },
  { name: 'one-empty-para', md: '\n' },
  { name: 'trailing-1-blank', md: 'A\n\n' },
  { name: 'trailing-2-blank', md: 'A\n\n\n' },
  { name: 'trailing-3-blank', md: 'A\n\n\n\n' },
  { name: 'trailing-4-blank', md: 'A\n\n\n\n\n' },
  { name: 'leading-1-blank', md: '\n# H\n\nB\n' },
  { name: 'leading-4-blank', md: '\n\n\n\n# H\n\nB\n' },
  { name: 'all-blank', md: '\n\n\n\n' },
  { name: 'middle-blank', md: 'A\n\n\n\nB\n' },
  { name: 'many-middle-blank', md: 'A\n\n\n\n\n\nB\n' },
  { name: 'frontmatter', md: '---\ntitle: 测试\n---\n\n# H\n\nbody\n' },
  { name: 'frontmatter-only', md: '---\na: b\n---\n' },
  { name: 'toml-frontmatter', md: '+++\na = "b"\n+++\n\ntext\n' },
  { name: 'footnote', md: '正文[^1]\n\n[^1]: 脚注内容\n' },
  { name: 'footnote-multiblock', md: 'A[^x]\n\n[^x]: 第一段\n\n    第二段\n\nB\n' },
  { name: 'definition', md: '看 [链接][id] 与 [短链接]。\n\n[id]: https://example.com "标题"\n[短链接]: /foo\n' },
  { name: 'definition-only', md: '[a]: https://example.com\n' },
  { name: 'html-block', md: '<div>\n<span>x</span>\n</div>\n\n段落\n' },
  { name: 'html-inline', md: '行内 <span class="x">HTML</span> 与 `代码`\n' },
  { name: 'html-image', md: '<img src="a.png" alt="x" />\n\n下一段\n' },
  { name: 'toc', md: '[TOC]\n\n# H\n\ntext\n' },
  { name: 'alert', md: '> [!NOTE]\n> 提示内容\n\n普通段\n' },
  { name: 'alert-warning', md: '> [!WARNING]\n> 注意\n>\n> - a\n> - b\n' },
  { name: 'math-block', md: '$$\nx^2 + y^2 = z^2\n$$\n\n之后 $a$ 与 $$b$$。\n' },
  { name: 'code-fence', md: '```ts\nconst a = 1\n```\n\n段落\n' },
  { name: 'code-indented', md: '    indented code\n\n段落\n' },
  { name: 'table', md: '| a | b |\n| - | - |\n| 1 | 2 |\n\n段落\n' },
  { name: 'list-tight', md: '- a\n- b\n\n段落\n' },
  { name: 'list-loose', md: '- a\n\n- b\n\n段落\n' },
  { name: 'list-nested', md: '1. 一\n   - 子一\n   - 子二\n2. 二\n' },
  { name: 'list-task', md: '- [x] 完成\n- [ ] 未完成\n' },
  { name: 'setext', md: '标题\n=====\n\n子标题\n-----\n\n段落\n' },
  { name: 'blockquote-lazy', md: '> 引用第一行\n懒延续行\n\n段落\n' },
  { name: 'hr', md: 'A\n\n---\n\nB\n' },
  { name: 'char-entity', md: '实体 &#x20; 与 &nbsp; 及 &amp;\n\n`代码里的 &#x20;`\n' },
  { name: 'highlight', md: '==高亮== 与 ^^上标^^ 和 ~下标~\n' },
  { name: 'crlf', md: '# 标题\r\n\r\n段落 A\r\n\r\n段落 B\r\n' },
  { name: 'backslash', md: '反斜杠 \\\\ 与 \\* 转义\n' },
  { name: 'html-after-html', md: '<div>A</div>\n\n<div>B</div>\n' },
  { name: 'list-after-para', md: '段落\n\n- a\n- b\n' },
  { name: 'code-after-list', md: '- a\n- b\n\n```\ncode\n```\n' },
  { name: 'blockquote-after-para', md: '段落\n\n> 引用\n' },
  { name: 'math-after-math', md: '$$\na\n$$\n\n$$\nb\n$$\n' },
  {
    name: 'mixed-heavy',
    md: '# H\n\n---\n\n> [!TIP]\n> 提示\n\n| a | b |\n| :- | -: |\n| 1 | 2 |\n\n'
      + '- [x] a\n- [ ] b\n\n$$\nx\n$$\n\n<div>html</div>\n\n[TOC]\n\n[^1]: 脚注\n',
  },
  // 尾部不是 paragraph 的块：文档级收尾公式最容易在这些块型上漂移
  { name: 'tail-code-fence', md: '前置段落\n\n```ts\nconst a = 1\n\n```\n' },
  { name: 'tail-code-with-blank-lines', md: '```\ncode\n\n\n```\n' },
  { name: 'tail-table', md: '| a | b |\n| - | - |\n| 1 | 2 |\n' },
  { name: 'tail-list', md: '段落\n\n- a\n- b\n' },
  { name: 'tail-blockquote', md: '段落\n\n> 引用\n' },
  { name: 'tail-html', md: '段落\n\n<div>html</div>\n' },
  { name: 'tail-math', md: '段落\n\n$$\nx^2\n$$\n' },
  { name: 'tail-footnote', md: '段落\n\n[^a]: 脚注\n' },
  { name: 'tail-frontmatter', md: '---\na: b\n---\n' },
  { name: 'tail-empty-paras-after-code', md: '```\nx\n```\n\n\n\n' },
  { name: 'adjacent-code-blocks', md: '```\na\n```\n\n```\nb\n```\n' },
  { name: 'adjacent-html-and-list', md: '<div>A</div>\n\n- x\n- y\n' },
]

/** 固定 seed LCG，fuzz 失败可稳定复现。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function textPositions(doc: PMNode): number[] {
  const out: number[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock && node.content.size > 0) out.push(pos + 1)
  })
  return out
}

/** 一次随机编辑：插入 / 删除 / 拆块 / 追加块。非法位置整步跳过。 */
function randomEdit(state: EditorState, rng: () => number): EditorState {
  const doc = state.doc
  const positions = textPositions(doc)
  const pos = positions[Math.floor(rng() * positions.length)] ?? 1
  const tr = state.tr
  try {
    switch (Math.floor(rng() * 5)) {
      case 0: tr.insertText('X', pos); break
      case 1: tr.insertText('中文*斜*', pos); break
      case 2: tr.delete(pos, Math.min(pos + 1, doc.content.size)); break
      case 3: tr.split(pos); break
      default: tr.insert(doc.content.size, schema.node('paragraph', null, [schema.text('新段落')]))
    }
    return state.apply(tr)
  } catch {
    return state
  }
}

const fuzzCorpus = Array.from({ length: 12 }, (_, i) => [
  `## 章节 ${i}`,
  '',
  `第 ${i} 段 **粗体** 与 *斜体*，还有 [链接](https://example.com/${i})。`,
  '',
  '- 列表项 a',
  '- 列表项 b',
  '',
  '```ts',
  `const n = ${i}`,
  '```',
  '',
  '> [!NOTE]',
  '> 引用内容',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '$$\nx^2\n$$',
  '',
].join('\n')).join('\n')

describe('blockSerializer 不变式', () => {
  it.each(cases)('对抗样本 $name: 全量重建 === toMarkdown', ({ md }) => {
    const doc = fromMarkdown(md, schema)
    const result = toMarkdownIncremental(doc)
    expect(result.hit).toBe(false)
    expect(result.md).toBe(toMarkdown(doc))
    // 带缓存再走一次（净块全命中）也必须字节相等
    expect(toMarkdownIncremental(doc, result.cache).md).toBe(toMarkdown(doc))
  })

  it.each([20261113, 42, 7777])('随机编辑序列下 incremental === toMarkdown（seed %i）', (seed) => {
    const rng = makeRng(seed)
    let state = EditorState.create({ schema, doc: fromMarkdown(fuzzCorpus, schema) })
    let cache: BlockCache | undefined
    let hits = 0
    let rebuilds = 0
    for (let step = 0; step < 50; step++) {
      state = randomEdit(state, rng)
      const result = toMarkdownIncremental(state.doc, cache)
      expect(result.md, `seed ${seed} step ${step}`).toBe(toMarkdown(state.doc))
      cache = result.cache
      if (result.hit) hits++
      else rebuilds++
    }
    // 绝大多数步骤应命中增量，否则说明判净规则失效（退化成每次全量）
    expect(hits).toBeGreaterThan(30)
    expect(rebuilds).toBeLessThan(20)
  })

  it('尾部空段增删后仍与全量一致', () => {
    const base = fromMarkdown('A\n\nB\n', schema)
    const initial = toMarkdownIncremental(base)
    const appended = schema.topNodeType.create(null, [
      ...base.content.content,
      schema.node('paragraph'),
      schema.node('paragraph'),
    ])
    const result = toMarkdownIncremental(appended, initial.cache)
    expect(result.hit).toBe(false) // 块数变化 → 全量兜底
    expect(result.md).toBe(toMarkdown(appended))
  })

  it('PM 结构共享判净：只重算脏块及邻块，净块引用与串保持不变', () => {
    const doc = fromMarkdown('第一段\n\n第二段\n\n第三段\n\n第四段\n\n第五段\n', schema)
    const first = toMarkdownIncremental(doc)
    const state = EditorState.create({ schema, doc })
    const next = state.apply(state.tr.insertText('!', doc.child(2).nodeSize + doc.child(0).nodeSize + doc.child(1).nodeSize + 1))
    const second = toMarkdownIncremental(next.doc, first.cache)
    expect(second.hit).toBe(true)
    expect(second.md).toBe(toMarkdown(next.doc))
    expect(second.cache.entries[0].node).toBe(first.cache.entries[0].node)
    expect(second.cache.entries[0].md).toBe(first.cache.entries[0].md)
    expect(second.cache.entries[4].md).toBe(first.cache.entries[4].md)
  })
})

describe('blockSerializer 缓存槽', () => {
  beforeEach(() => resetBlockCaches())

  it('按 docId 隔离，互不串内容', () => {
    const a = fromMarkdown('# A\n\n内容 A\n', schema)
    const b = fromMarkdown('# B\n\n内容 B\n', schema)
    expect(serializeDocIncremental(a, 'a')).toBe(toMarkdown(a))
    expect(serializeDocIncremental(b, 'b')).toBe(toMarkdown(b))
    expect(getBlockCache('a')?.entries[0].node).toBe(a.child(0))
    expect(getBlockCache('b')?.entries[0].node).toBe(b.child(0))
  })

  it('缓存缺失 / 块数变化 / 显式失效都走全量兜底且结果正确', () => {
    const doc = fromMarkdown('# A\n\n内容\n', schema)
    expect(serializeDocIncremental(doc, 'a')).toBe(toMarkdown(doc))
    const cached = getBlockCache('a')!
    expect(toMarkdownIncremental(doc, cached).hit).toBe(true)
    expect(toMarkdownIncremental(doc, undefined).hit).toBe(false)
    expect(toMarkdownIncremental(doc, { entries: cached.entries.slice(0, 1) }).md).toBe(toMarkdown(doc))
    invalidateBlockCache('a')
    expect(getBlockCache('a')).toBeUndefined()
  })

  it('LRU 淘汰最久未用的 doc', () => {
    const doc = fromMarkdown('内容\n', schema)
    for (let i = 0; i < 9; i++) setBlockCache(`doc-${i}`, { entries: [] })
    expect(getBlockCache('doc-0')).toBeUndefined()
    expect(getBlockCache('doc-8')).toBeDefined()
    // 淘汰后重新序列化仍正确
    expect(serializeDocIncremental(doc, 'doc-0')).toBe(toMarkdown(doc))
  })
})

describe('块级原文切片保真 (parseMarkdownForDoc)', () => {
  beforeEach(() => resetBlockCaches())

  it('只改一处段落时，未触碰的非标准格式块、开头多空行、CRLF、无尾换行均逐字节保留', () => {
    const raw = [
      '',
      '',
      '',
      '',
      '# 涉企政策匹配对比推送方案',
      '',
      '第一段需要编辑。',
      '',
      '',
      '* 星号列表项保持 (128*-1) 不被加反斜杠',
      '* 还能切换视角看*“如果按晋江的门槛算，莆田会有多少家企业入围”*。',
      '',
      '| 未对齐表 | 列 |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\r\n') // 同时含 CRLF 与无尾换行

    const doc = parseMarkdownForDoc(raw, schema, 'doc-raw')
    // 未编辑时序列化逐字节等于原文
    expect(serializeDocIncremental(doc, 'doc-raw')).toBe(raw)

    // 修改「第一段需要编辑。」为「第一段已编辑。」
    let targetPos = -1
    doc.descendants((node, pos) => {
      if (node.isText && node.text === '第一段需要编辑。') targetPos = pos
    })
    expect(targetPos).toBeGreaterThan(0)
    const state = EditorState.create({ schema, doc })
    const edited = state.apply(state.tr.insertText('已', targetPos + 3, targetPos + 5))
    const out = serializeDocIncremental(edited.doc, 'doc-raw')

    expect(out).toBe(raw.replace('第一段需要编辑。', '第一段已编辑。'))

    // 用户再改回「第一段需要编辑。」（模拟删除 / Undo）：PMNode.eq 命中，全文逐字节还原为 raw
    const reverted = edited.apply(edited.tr.insertText('需要', targetPos + 3, targetPos + 4))
    expect(serializeDocIncremental(reverted.doc, 'doc-raw')).toBe(raw)
  })

  it('复现文档场景：增删任意一个文字时 diff 只出现 +1/-1（无心智外自动改动）', () => {
    const raw = [
      '',
      '',
      '',
      '',
      '# 涉企政策匹配对比推送方案',
      '',
      '',
      '',
      '### 一、 业务本质拆解',
      '',
      '正文段落内容。',
      '',
      '1. 政务端',
      '   - 直接联动展示，还能切换视角看*“如果按晋江的门槛算，莆田会有多少家企业入围”*。',
      '',
      '- 链路一',
      '  比如莆*“鞋企智能化改造设备购置补助”，晋江叫“制鞋工业企业智改数转项目奖补”*”\\*，字面不一样：',
      '  1. 工商库的行业代码往往只到“制鞋业”，但如果政*“支持超临界发泡鞋材、TPU新型功能材料研发”*研发”\\*，就拿向量计算。',
      '',
    ].join('\n')

    const doc = parseMarkdownForDoc(raw, schema, 'repro')
    let editPos = -1
    doc.descendants((node, pos) => {
      if (node.isText && node.text === '正文段落内容。') editPos = pos
    })
    const state = EditorState.create({ schema, doc })
    const next = state.apply(state.tr.insertText('新', editPos, editPos))
    const nextMd = serializeDocIncremental(next.doc, 'repro')

    const diff = diffLines(raw, nextMd)
    const added = diff.filter(l => l.type === 'added').length
    const removed = diff.filter(l => l.type === 'removed').length
    expect({ added, removed }).toEqual({ added: 1, removed: 1 })
  })

  it('增删中间段落（块数变化）时，前后未触碰的非标准格式块仍逐字节保留', () => {
    const raw = '* 星号列表 (128*-1)\n\n待删中间段\n\n| 未对齐表 | 列 |\n|---|---|\n| 1 | 2 |\n'
    const doc = parseMarkdownForDoc(raw, schema, 'split-delete-doc')
    expect(serializeDocIncremental(doc, 'split-delete-doc')).toBe(raw)

    // 删除中间段落（块数从 3 变为 2），首尾非标准块仍保持原样
    const midFrom = doc.child(0).nodeSize
    const midTo = midFrom + doc.child(1).nodeSize
    const state = EditorState.create({ schema, doc })
    const deleted = state.apply(state.tr.delete(midFrom, midTo))
    const out = serializeDocIncremental(deleted.doc, 'split-delete-doc')
    expect(out).toBe('* 星号列表 (128*-1)\n\n| 未对齐表 | 列 |\n|---|---|\n| 1 | 2 |\n')
  })
})

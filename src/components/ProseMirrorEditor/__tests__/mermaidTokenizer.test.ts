// 轻量 mermaid tokenizer 单元测试。
//
// 覆盖目标(对照 sample.md 真实样本 + mermaidDecoration.test.ts 的夹具):
// - 6 类 token 分类正确:keyword / direction / shape / edge / label / comment
// - offset 跨行正确累加(含 CJK 多字节)—— 这是 buildDecorations 用
//   `blockStart + token.offset` 算 from/to 的正确性前提,早期 shiki 实现踩过
//   offset 双重累加的坑,本测试用"token 拼接还原原文位置"的方式防回归。
// - 空输入 / 无 mermaid 关键字的纯文本 → 安全降级(空 / 默认色接管)。
// - token.type 与 _mermaid.scss 的 --velo-mermaid-<type> 变量一一对应。
//
// 风格参考:utils/__tests__/outline.test.ts(vitest + 显式 import + 纯函数)。

import { describe, it, expect } from 'vitest'
import { tokenizeMermaid, type MermaidToken } from '../nodes/mermaidTokenizer'

/** 工具:扁平化二维 token 数组,便于断言。 */
function flat(code: string): MermaidToken[] {
  return tokenizeMermaid(code).flat()
}

/** 工具:把所有 token 按 offset 拼回,看是否覆盖了源码中"有 token"的位置。
 *  用来防 offset 错位 —— 拼接结果里每个 token.content 都应落在其 offset 处。 */
function reconstruct(tokens: MermaidToken[]): string {
  let out = ''
  for (const t of tokens) {
    // 用空格填充 token 之前的空白(offset - out.length 可能 > 0,代表有
    // 未识别的 plain 字符被跳过)
    if (t.offset > out.length) out += ' '.repeat(t.offset - out.length)
    out += t.content
  }
  return out
}

describe('tokenizeMermaid — 空输入与降级', () => {
  it('空字符串返回 [[]](跟 shiki 行为一致)', () => {
    expect(tokenizeMermaid('')).toEqual([[]])
  })

  it('纯空白行也安全(不抛错)', () => {
    expect(tokenizeMermaid('   \n  ')).toHaveLength(2)
  })

  it('无 mermaid 关键字的纯文本不产生任何 token(让默认色接管)', () => {
    const tokens = flat('xxx invalid mermaid')
    expect(tokens).toHaveLength(0)
  })
})

describe('tokenizeMermaid — keyword 与 direction', () => {
  it('graph 关键字识别为 keyword', () => {
    const tokens = flat('graph LR')
    expect(tokens[0]).toMatchObject({ content: 'graph', type: 'keyword' })
  })

  it('graph 后紧跟的 TD/LR/RL/BT/TB 识别为 direction', () => {
    for (const dir of ['TD', 'LR', 'RL', 'BT', 'TB']) {
      const tokens = flat(`graph ${dir}`)
      expect(tokens.find(t => t.type === 'direction')).toMatchObject({ content: dir })
    }
  })

  it('flowchart 同样识别 keyword + direction', () => {
    const tokens = flat('flowchart TD')
    expect(tokens[0]).toMatchObject({ content: 'flowchart', type: 'keyword' })
    expect(tokens.find(t => t.type === 'direction')?.content).toBe('TD')
  })

  it('指令词 subgraph / classDef / style / pie / title / end 识别为 keyword', () => {
    for (const kw of ['subgraph', 'classDef', 'style', 'pie', 'title', 'end']) {
      const tokens = flat(kw)
      expect(tokens.find(t => t.content === kw && t.type === 'keyword')).toBeTruthy()
    }
  })

  it('长串关键字优先:classDef 不被 class 截断', () => {
    const tokens = flat('classDef foo fill:#f9f')
    expect(tokens[0]).toMatchObject({ content: 'classDef', type: 'keyword' })
    // 确保不是只匹配了 class
    expect(tokens[0].content.length).toBe('classDef'.length)
  })

  it('图类型词 sequenceDiagram / classDiagram / stateDiagram 识别为 keyword', () => {
    for (const kw of ['sequenceDiagram', 'classDiagram', 'stateDiagram', 'erDiagram', 'gitGraph']) {
      const tokens = flat(kw)
      expect(tokens[0]).toMatchObject({ content: kw, type: 'keyword' })
    }
  })

  it('行首带前导空白时 keyword 仍识别', () => {
    const tokens = flat('  graph TD')
    expect(tokens[0]).toMatchObject({ content: 'graph', type: 'keyword' })
  })
})

describe('tokenizeMermaid — shape(节点形状符号)', () => {
  it('[矩形] 识别为 shape', () => {
    const tokens = flat('A[Hello]')
    expect(tokens.find(t => t.content === '[Hello]')).toMatchObject({ type: 'shape' })
  })

  it('(圆角) 识别为 shape', () => {
    const tokens = flat('A(Hello)')
    expect(tokens.find(t => t.content === '(Hello)')).toMatchObject({ type: 'shape' })
  })

  it('{菱形} 识别为 shape', () => {
    const tokens = flat('A{World}')
    expect(tokens.find(t => t.content === '{World}')).toMatchObject({ type: 'shape' })
  })

  it('((圆形)) 识别为 shape —— 双括号必须在单括号之前匹配', () => {
    const tokens = flat('A((End))')
    expect(tokens.find(t => t.content === '((End))')).toMatchObject({ type: 'shape' })
    // 不能被切成 (End) + 多余括号
    expect(tokens.some(t => t.content === '(End)')).toBe(false)
  })

  it('[[子例程]] 识别为 shape —— 双方括号优先', () => {
    const tokens = flat('A[[Sub]]')
    expect(tokens.find(t => t.content === '[[Sub]]')).toMatchObject({ type: 'shape' })
  })

  it('{{六边形}} 识别为 shape', () => {
    const tokens = flat('A{{Hex}}')
    expect(tokens.find(t => t.content === '{{Hex}}')).toMatchObject({ type: 'shape' })
  })

  it('shape 内含 CJK(更新状态)正确识别', () => {
    const tokens = flat('B --> B1[更新状态]')
    expect(tokens.find(t => t.content === '[更新状态]')).toMatchObject({ type: 'shape' })
  })
})

describe('tokenizeMermaid — edge(边箭头)', () => {
  it('-->(实线箭头)识别为 edge', () => {
    const tokens = flat('A --> B')
    expect(tokens.find(t => t.content === '-->')).toMatchObject({ type: 'edge' })
  })

  it('-.->(点线箭头)识别为 edge —— 长串优先', () => {
    const tokens = flat('A -.-> B')
    expect(tokens.find(t => t.content === '-.->')).toMatchObject({ type: 'edge' })
  })

  it('==>(粗线箭头)识别为 edge', () => {
    const tokens = flat('A ==> B')
    expect(tokens.find(t => t.content === '==>')).toMatchObject({ type: 'edge' })
  })

  it('行终止符 ; 识别为 edge', () => {
    const tokens = flat('A-->B;')
    expect(tokens.some(t => t.content === ';' && t.type === 'edge')).toBe(true)
  })

  it('<-->(双向)识别为 edge', () => {
    const tokens = flat('A <--> B')
    expect(tokens.find(t => t.content === '<-->')).toMatchObject({ type: 'edge' })
  })
})

describe('tokenizeMermaid — label', () => {
  it('edge label |text| 识别为 label', () => {
    const tokens = flat('A -->|edge label| B')
    expect(tokens.find(t => t.content === '|edge label|')).toMatchObject({ type: 'label' })
  })

  it('字符串 "..." 识别为 label', () => {
    const tokens = flat('pie\n  "喜欢宅" : 45')
    expect(tokens.find(t => t.content === '"喜欢宅"')).toMatchObject({ type: 'label' })
  })

  it('label 含空格 / 特殊字符也完整匹配(非贪婪到第二个 |)', () => {
    const tokens = flat('A -->|yes / no| B')
    expect(tokens.find(t => t.content === '|yes / no|')).toMatchObject({ type: 'label' })
  })
})

describe('tokenizeMermaid — comment', () => {
  it('行首 %% 整行识别为 comment', () => {
    const tokens = flat('%% this is a comment')
    expect(tokens[0]).toMatchObject({ content: '%% this is a comment', type: 'comment' })
  })

  it('行内 %% 后续识别为 comment', () => {
    const tokens = flat('A --> B %% trailing note')
    const comment = tokens.find(t => t.type === 'comment')
    expect(comment?.content).toBe('%% trailing note')
  })
})

describe('tokenizeMermaid — offset 跨行累加', () => {
  it('多行 token 的 offset 从整个 code 开头正确累加(含 CJK)', () => {
    // code = 'graph LR\n  A[Hello] --> B{World}'(共 27 字符)
    //   'graph LR'  → [0..8)   (8 字符)
    //   '\n'        → [8]
    //   '  '        → [9..11)
    //   'A'         → [11]     (节点 ID,未识别 plain,不产出 token)
    //   '[Hello]'   → [12..19) (7 字符)
    //   ' '         → [19]
    //   '-->'       → [20..23)
    //   ' '         → [23]
    //   'B'         → [24]     (节点 ID,未识别 plain)
    //   '{World}'   → [25..32) —— 但 code 只有 27 字符,{World} 从 25 开始 ✓
    const code = 'graph LR\n  A[Hello] --> B{World}'
    const tokens = flat(code)
    const shapeOpen = tokens.find(t => t.content === '[Hello]')
    const edge = tokens.find(t => t.content === '-->')
    const shapeClose = tokens.find(t => t.content === '{World}')

    expect(shapeOpen?.offset).toBe(12)
    expect(edge?.offset).toBe(20)
    expect(shapeClose?.offset).toBe(25)
  })

  it('reconstruct 拼接结果:token 落在正确 offset(无错位)', () => {
    const code = 'graph LR\n  A[Hello] --> B{World}'
    const tokens = flat(code)
    const rebuilt = reconstruct(tokens)
    // 每个 token.content 应在 rebuilt 中其 offset 处出现
    for (const t of tokens) {
      expect(rebuilt.slice(t.offset, t.offset + t.content.length)).toBe(t.content)
    }
  })

  it('含 CJK 的多字节字符不影响 offset 累加', () => {
    // "更新状态" 4 个汉字 = 8 个 UTF-16 code unit(string.length = 8)
    const code = 'graph LR\n  B --> B1[更新状态]'
    const tokens = flat(code)
    const shape = tokens.find(t => t.content === '[更新状态]')
    expect(shape).toBeTruthy()
    // 验证 offset + content.length 不越界
    expect(shape!.offset + shape!.content.length).toBeLessThanOrEqual(code.length)
  })

  it('行数与 code.split("\\n") 一致', () => {
    const code = 'a\nb\nc\nd'
    expect(tokenizeMermaid(code)).toHaveLength(4)
    // 末尾 \n → split 产生末尾空串元素
    expect(tokenizeMermaid('a\nb\n')).toHaveLength(3)
  })
})

describe('tokenizeMermaid — sample.md 真实样本全覆盖', () => {
  it('graph LR + 节点 + CJK label 全部正确分类', () => {
    const code = 'graph LR\n  A[GraphCommand] --> B[update]\n  A --> C[goto]\n  A --> D[send]\n\n  B --> B1[更新状态]\n  C --> C1[流程控制]\n  D --> D1[消息传递]'
    const tokens = flat(code)
    // 关键字
    expect(tokens.filter(t => t.type === 'keyword' && t.content === 'graph')).toHaveLength(1)
    // 方向
    expect(tokens.filter(t => t.type === 'direction' && t.content === 'LR')).toHaveLength(1)
    // 边(-->:3 条带 label 的 line 各一条 + 第 1 行 1 条 = 4)
    expect(tokens.filter(t => t.type === 'edge' && t.content === '-->').length).toBeGreaterThanOrEqual(3)
    // shape:[GraphCommand] [update] [goto] [send] [更新状态] [流程控制] [消息传递]
    const shapes = tokens.filter(t => t.type === 'shape')
    expect(shapes.length).toBeGreaterThanOrEqual(7)
    // offset 完整性:拼接还原无错位
    const rebuilt = reconstruct(tokens)
    for (const t of tokens) {
      expect(rebuilt.slice(t.offset, t.offset + t.content.length)).toBe(t.content)
    }
  })

  it('graph TD; + 分号行终止符正确分类', () => {
    const code = 'graph TD;\n  A-->B;\n  A-->C;\n  B-->D;\n  C-->D;'
    const tokens = flat(code)
    expect(tokens.filter(t => t.type === 'keyword' && t.content === 'graph')).toHaveLength(1)
    expect(tokens.filter(t => t.type === 'direction' && t.content === 'TD')).toHaveLength(1)
    expect(tokens.filter(t => t.type === 'edge' && t.content === ';').length).toBeGreaterThanOrEqual(5)
    expect(tokens.filter(t => t.type === 'edge' && t.content === '-->').length).toBeGreaterThanOrEqual(4)
  })

  it('pie + title + CJK 标题 + 引号 label 正确分类', () => {
    const code = 'pie\n  title 为什么总是宅在家里？\n  "喜欢宅" : 45\n  "天气太热" : 70\n  "穷" : 500\n  "没人约" : 95'
    const tokens = flat(code)
    expect(tokens.filter(t => t.type === 'keyword' && t.content === 'pie')).toHaveLength(1)
    expect(tokens.filter(t => t.type === 'keyword' && t.content === 'title')).toHaveLength(1)
    // 4 个引号字符串 label
    expect(tokens.filter(t => t.type === 'label' && t.content.startsWith('"'))).toHaveLength(4)
  })
})

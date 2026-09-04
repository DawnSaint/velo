// 自写严格 math 解析扩展的合同测试。
//
// 覆盖 remark-math 做不到、也正是导致"残缺公式块吞掉后文"的核心场景。
// 这些用例是 strictMath 的存在理由 —— 任何一条挂掉都意味着数据损坏风险回归。

import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import { remarkStrictMath } from '../plugins/strictMath'

function parse(md: string) {
  return unified().use(remarkParse).use(remarkStrictMath).parse(md) as any
}

function stringify(tree: any) {
  return unified().use(remarkParse).use(remarkStrictMath).use(remarkStringify).stringify(tree)
}

/** 顶层节点摘要:[类型, 值] 列表。 */
function outline(md: string) {
  return parse(md).children.map((n: any) => [
    n.type,
    n.type === 'math' || n.type === 'inlineMath' ? n.value : (n.children?.[0]?.value ?? ''),
  ])
}

describe('strictMath 块级围栏', () => {
  it('合法块级公式照常解析', () => {
    expect(outline('$$\nx^2\n$$')).toEqual([['math', 'x^2']])
  })

  it('空公式块仍可解析', () => {
    expect(outline('$$\n$$')).toEqual([['math', '']])
  })

  it('支持 $$meta 形式', () => {
    const tree = parse('$$asciimath\nx\n$$')
    expect(tree.children[0].type).toBe('math')
    expect(tree.children[0].meta).toBe('asciimath')
    expect(tree.children[0].value).toBe('x')
  })

  it('缩进 3 空格内仍识别', () => {
    expect(outline('   $$\nx\n   $$')).toEqual([['math', 'x']])
  })

  it('A1:EOF 未闭合 → 开围栏当普通文本,不吞并', () => {
    // upstream remark-math 会把这两行合成一个 math_block
    expect(outline('$$\nxxx\n')).toEqual([['paragraph', '$$\nxxx']])
  })

  it('A1:用户场景 —— 删掉一个尾 $ 后后续段落不被吞', () => {
    // 注意:源里 `\\` 是转义,解析后段落文本只剩一个 `\` —— 这是 markdown 语义,
    // 与围栏无关。真正含"两个字面反斜杠"的场景在 mathBlockBrokenFence.test.ts
    // 里从 PM 文档层面覆盖。
    const md = '$$\nxxx\n$\n\nnext paragraph\n'
    expect(outline(md)).toEqual([
      ['paragraph', '$$\nxxx\n$'],
      ['paragraph', 'next paragraph'],
    ])
  })

  it('A2:跨公式块不吞并(只做 A1 会漏掉的场景)', () => {
    // 第 1 行开围栏未闭合,若允许跨空行搜索,会一路匹配到第 7 行(第 2 块的闭合行),
    // 把 A / $ / text 全部吞进一个 math_block。
    const md = '$$\nA\n$\n\ntext\n\n$$\nB\n$$'
    expect(outline(md)).toEqual([
      ['paragraph', '$$\nA\n$'],
      ['paragraph', 'text'],
      ['math', 'B'],
    ])
  })

  it('A2:公式块内含空行 → 不识别为公式(有意的取舍,内容不丢)', () => {
    // 退化结果是两段普通文本,内容完整保留,只是不渲染成公式。
    expect(outline('$$\nx\n\n$$')).toEqual([['paragraph', '$$\nx'], ['paragraph', '$$']])
  })

  it('块引用内 / 列表项内的块级公式不受影响', () => {
    const quote = parse('> $$\n> x\n> $$\n')
    expect(quote.children[0].children[0].type).toBe('math')

    const list = parse('- $$\n  x\n  $$\n')
    expect(list.children[0].children[0].children[0].type).toBe('math')
  })
})

describe('strictMath 行内公式(与上游一致,不允许回归)', () => {
  it('单 $ 行内公式', () => {
    const tree = parse('a $x$ b')
    const inline = tree.children[0].children[1]
    expect(inline.type).toBe('inlineMath')
    expect(inline.value).toBe('x')
  })

  it('双 $ 行内公式', () => {
    const tree = parse('a $$x$$ b')
    const inline = tree.children[0].children[1]
    expect(inline.type).toBe('inlineMath')
    expect(inline.value).toBe('x')
  })

  it('未闭合的 $ 退回普通文本', () => {
    const tree = parse('a $x b')
    expect(tree.children[0].children.every((c: any) => c.type === 'text')).toBe(true)
  })
})

describe('strictMath 序列化:段落里的 $ 不再转义', () => {
  it('残缺公式块降级成段落后,$ 保持原样', () => {
    const md = '$$\nxxx \\\\\n$\n\nnext\n'
    const out = stringify(parse(md))
    // `$` 不再被转义成 `\$` —— 严格解析下裸 `$$` 行已无法吞并后文
    expect(out).not.toContain('\\$')
    expect(out).toContain('$$')
  })

  it('普通段落里的价格 $ 不转义', () => {
    const out = stringify(parse('价格 $5 起\n'))
    expect(out).not.toContain('\\$')
  })

  it('残缺公式块 round-trip 稳定', () => {
    const md = '$$\nxxx \\\\\n$\n\nnext\n'
    const once = stringify(parse(md))
    const twice = stringify(parse(once))
    expect(twice).toBe(once)
  })

  it('合法公式块 round-trip 稳定', () => {
    const md = '$$\nx^2\n$$\n'
    const once = stringify(parse(md))
    expect(once).toContain('$$\nx^2\n$$')
    expect(stringify(parse(once))).toBe(once)
  })

  it('反斜杠仍然转义 —— 去掉会真的丢字符', () => {
    // 段落文本 `a \\b`(两个字面反斜杠)。`\` 后面跟标点才需要转义,
    // 所以只有第一个被转 → `a \\\b`(三个)。
    const tree: any = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a \\\\b' }] }],
    }
    const out = stringify(tree)
    // 重读回来必须还是两个反斜杠 —— 若省掉转义,会被解成一个。
    expect(parse(out).children[0].children[0].value).toBe('a \\\\b')
  })
})

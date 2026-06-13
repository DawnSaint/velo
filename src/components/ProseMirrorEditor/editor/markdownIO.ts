// Markdown ↔ ProseMirror doc 双向转换。
//
// 走 unified pipeline:remark-parse + remark-gfm + remark-math + remark-stringify。
// remark-* 自己挂载 micromark / mdast-util 的 fromMarkdown / toMarkdown 扩展,
// 我们只在 mdast ↔ ProseMirror 这一层做转换。
//
// stringify 配置对齐 Milkdown / preset-commonmark 默认值,目的是让现有
// `.md` 文件 round-trip 后 diff 最小:
// - bullet `-`, listItemIndent 'one', emphasis `_`, strong `*`, fences true
//
// 已知信息丢失(文档化但不防御):
// - hardbreak attrs.isInline → 统一序列化为 `break`
// - list_item attrs.label → 由 stringify 的 bullet 配置决定
// - table cell colspan/rowspan/colwidth → mdast 不支持
// - mdast `html` 节点 → 当前转 paragraph 占位(v0.4.1 再做)
//
// mermaid:mdast 里就是 `code` with `lang === 'mermaid'`,我们映射到 PM 的
// mermaid 节点(attrs.value = code.value)。反向同理。

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Schema, Node as PMNode, MarkType } from 'prosemirror-model'
import type { Root, RootContent, BlockContent, DefinitionContent, PhrasingContent, Table, ListItem } from 'mdast'
import { remarkPreserveEmptyLine } from '../plugins/preserveEmptyLine'

// ============================================================
//  unified processor
// ============================================================

const processor = unified()
  .use(remarkParse)
  // 空行保留 —— 必须在 remarkParse 之后,拦截 this.parser 把多空行
  // 预处理成 <br /> 块,让 mdast 里出现可见的空 paragraph 占位
  .use(remarkPreserveEmptyLine)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, {
    bullet: '-',
    listItemIndent: 'one',
    emphasis: '_',
    strong: '*',
    fences: true,
    rule: '-',
    ruleSpaces: false,
  })

// ============================================================
//  fromMarkdown:string → ProseMirror Node
// ============================================================

export function fromMarkdown(md: string, schema: Schema): PMNode {
  const tree = processor.parse(md) as Root
  const blocks = tree.children.flatMap(n => mdastBlockToPM(n, schema))
  // 空文档兜底:doc 至少要一个 paragraph
  if (blocks.length === 0) {
    return schema.node('doc', null, [schema.node('paragraph')])
  }
  return schema.node('doc', null, blocks)
}

/** mdast 块级节点 → 0..N 个 PM 节点(0 个发生在不支持的节点被吞掉时)。 */
function mdastBlockToPM(node: RootContent, schema: Schema): PMNode[] {
  switch (node.type) {
    case 'paragraph':
      return [schema.node('paragraph', null, mdastInlineToPM(node.children, schema))]

    case 'heading':
      return [schema.node('heading', { level: node.depth },
        mdastInlineToPM(node.children, schema))]

    case 'blockquote':
      return [schema.node('blockquote', null,
        node.children.flatMap(c => mdastBlockToPM(c, schema)))]

    case 'thematicBreak':
      return [schema.node('hr')]

    case 'code': {
      // mermaid 走自己的节点;其他语言进 code_block
      if (node.lang === 'mermaid') {
        return [schema.node('mermaid', { value: node.value })]
      }
      const content = node.value ? [schema.text(node.value)] : []
      return [schema.node('code_block', { language: node.lang ?? '' }, content)]
    }

    case 'math':
      return [schema.node('math_block', { value: node.value })]

    case 'list': {
      const isOrdered = node.ordered === true
      const listType = isOrdered ? 'ordered_list' : 'bullet_list'
      const attrs: Record<string, unknown> = { spread: node.spread === true }
      if (isOrdered) attrs.order = node.start ?? 1
      const items = node.children.map(item => mdastListItemToPM(item, isOrdered, schema))
      return [schema.node(listType, attrs, items)]
    }

    case 'footnoteDefinition': {
      const label = node.identifier
      const children = node.children.flatMap(c => mdastBlockToPM(c, schema))
      // footnote_definition 要求 'block+',children 至少一个
      if (children.length === 0) children.push(schema.node('paragraph'))
      return [schema.node('footnote_definition', { label }, children)]
    }

    case 'table':
      return [mdastTableToPM(node, schema)]

    case 'html':
      // v0.4.1 再做。目前转纯文本段落兜底,不抛错也不丢内容。
      return [schema.node('paragraph', null,
        node.value ? [schema.text(node.value)] : [])]

    default:
      // 不支持的块级节点(yaml/toml frontmatter 等)→ 静默丢弃
      return []
  }
}

function mdastListItemToPM(item: ListItem, isOrdered: boolean, schema: Schema): PMNode {
  const children = item.children.flatMap(c => mdastBlockToPM(c, schema))
  // list_item 要求 'paragraph block*',首子必须是 paragraph
  if (children.length === 0 || children[0].type.name !== 'paragraph') {
    children.unshift(schema.node('paragraph'))
  }
  const attrs: Record<string, unknown> = {
    listType: isOrdered ? 'ordered' : 'bullet',
    spread: item.spread !== false,
    checked: item.checked == null ? null : item.checked,
  }
  return schema.node('list_item', attrs, children)
}

function mdastTableToPM(table: Table, schema: Schema): PMNode {
  const rows = table.children
  if (rows.length === 0) {
    // 空表兜底:1 行 header 1 个空 cell
    const empty = schema.node('paragraph')
    const headerCell = schema.node('table_header', null, [empty])
    return schema.node('table', null, [
      schema.node('table_header_row', null, [headerCell]),
    ])
  }

  const align = table.align ?? []
  const headerCells = rows[0].children.map((cell, i) =>
    schema.node('table_header', { alignment: align[i] ?? 'left' },
      [paragraphFromInline(cell.children, schema)]))
  const headerRow = schema.node('table_header_row', null, headerCells)

  const bodyRows = rows.slice(1).map(row => {
    const cells = row.children.map((cell, i) =>
      schema.node('table_cell', { alignment: align[i] ?? 'left' },
        [paragraphFromInline(cell.children, schema)]))
    return schema.node('table_row', null, cells)
  })

  return schema.node('table', null, [headerRow, ...bodyRows])
}

function paragraphFromInline(inline: PhrasingContent[], schema: Schema): PMNode {
  return schema.node('paragraph', null, mdastInlineToPM(inline, schema))
}

// ============================================================
//  mdast 行内 → PM(text + marks + atom inline)
// ============================================================

function mdastInlineToPM(nodes: PhrasingContent[], schema: Schema): PMNode[] {
  const out: PMNode[] = []
  for (const n of nodes) {
    out.push(...inlineNodeToPM(n, schema, []))
  }
  return out
}

/**
 * 单个 mdast 行内节点 → 0..N 个 PM 节点。
 * `activeMarks` 是从外层(emphasis/strong/link/delete/inlineCode)继承下来的 mark
 * 类型 + attrs,递归时 push,返回时 pop —— 与 ProseMirror 的 mark addToSet 等价。
 */
interface ActiveMark { type: MarkType; attrs?: Record<string, unknown> }

function inlineNodeToPM(
  node: PhrasingContent,
  schema: Schema,
  activeMarks: ActiveMark[],
): PMNode[] {
  const marks = activeMarks.map(m => m.type.create(m.attrs))

  switch (node.type) {
    case 'text':
      return node.value ? [schema.text(node.value, marks)] : []

    case 'inlineCode':
      return [schema.text(node.value, marks.concat(schema.marks.code.create()))]

    case 'emphasis':
      return node.children.flatMap(c =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.emphasis })))

    case 'strong':
      return node.children.flatMap(c =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.strong })))

    case 'delete':
      return node.children.flatMap(c =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.strike_through })))

    case 'link':
      return node.children.flatMap(c =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({
            type: schema.marks.link,
            attrs: { href: node.url, title: node.title ?? null },
          })))

    case 'image':
      return [schema.node('image', {
        src: node.url,
        alt: node.alt ?? '',
        title: node.title ?? '',
      })]

    case 'break':
      return [schema.node('hardbreak')]

    case 'inlineMath':
      // math_inline content 是 text*,把 source 当文本塞进去
      return [schema.node('math_inline', null,
        node.value ? [schema.text(node.value)] : [])]

    case 'footnoteReference':
      return [schema.node('footnote_reference', { label: node.identifier })]

    case 'html':
      // 行内 html → 文本兜底(v0.4.1)
      return node.value ? [schema.text(node.value, marks)] : []

    default:
      return []
  }
}

// ============================================================
//  toMarkdown:ProseMirror Node → string
// ============================================================

export function toMarkdown(doc: PMNode): string {
  const tree: Root = {
    type: 'root',
    children: pmBlocksToMdast(doc),
  }
  return processor.stringify(tree).toString()
}

function pmBlocksToMdast(parent: PMNode): RootContent[] {
  const out: RootContent[] = []
  parent.forEach(child => {
    const node = pmBlockToMdast(child)
    if (node) out.push(node)
  })
  return out
}

function pmBlockToMdast(node: PMNode): RootContent | null {
  switch (node.type.name) {
    case 'paragraph':
      return { type: 'paragraph', children: pmInlineToMdast(node) }

    case 'heading':
      return {
        type: 'heading',
        depth: node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6,
        children: pmInlineToMdast(node) as PhrasingContent[],
      }

    case 'blockquote':
      return {
        type: 'blockquote',
        children: pmBlocksToMdast(node) as (BlockContent | DefinitionContent)[],
      }

    case 'hr':
      return { type: 'thematicBreak' }

    case 'code_block':
      return {
        type: 'code',
        lang: (node.attrs.language as string) || null,
        value: node.textContent,
      }

    case 'mermaid':
      return { type: 'code', lang: 'mermaid', value: node.attrs.value as string }

    case 'math_block':
      return { type: 'math', value: node.attrs.value as string } as RootContent

    case 'bullet_list':
    case 'ordered_list': {
      const isOrdered = node.type.name === 'ordered_list'
      const items: ListItem[] = []
      node.forEach(item => {
        items.push(pmListItemToMdast(item))
      })
      return {
        type: 'list',
        ordered: isOrdered,
        start: isOrdered ? (node.attrs.order as number) : null,
        spread: node.attrs.spread as boolean,
        children: items,
      }
    }

    case 'footnote_definition':
      return {
        type: 'footnoteDefinition',
        identifier: node.attrs.label as string,
        label: node.attrs.label as string,
        children: pmBlocksToMdast(node) as (BlockContent | DefinitionContent)[],
      }

    case 'table':
      return pmTableToMdast(node)

    default:
      return null
  }
}

function pmListItemToMdast(item: PMNode): ListItem {
  return {
    type: 'listItem',
    spread: item.attrs.spread as boolean,
    checked: item.attrs.checked as boolean | null,
    children: pmBlocksToMdast(item) as ListItem['children'],
  }
}

function pmTableToMdast(table: PMNode): Table {
  const rows: Table['children'] = []
  const align: Table['align'] = []
  let alignReady = false

  table.forEach(row => {
    const cells: PhrasingContent[][] = []
    row.forEach(cell => {
      // cell 内容固定为单 paragraph
      const para = cell.firstChild
      const inline = para ? pmInlineToMdast(para) : []
      cells.push(inline as PhrasingContent[])
      if (!alignReady) {
        // mdast align:null = 未指定;'left'/'right'/'center' = 显式
        // 我们 schema 里 alignment 默认 'left',但这是 PM 内部默认
        // 不代表 markdown 源码里写了 `:-`。源码里 `| - |` parse 出来是 null,
        // 我们 schema 没法区分"用户写了 :-"和"未指定",这里统一回 null
        // 避免 round-trip 把 `| - |` 变成 `| :- |`。
        const a = cell.attrs.alignment as string | undefined
        align.push(a === 'center' ? 'center' : a === 'right' ? 'right' : null)
      }
    })
    alignReady = true
    rows.push({
      type: 'tableRow',
      children: cells.map(c => ({ type: 'tableCell', children: c })),
    })
  })

  return {
    type: 'table',
    align,
    children: rows,
  }
}

// ============================================================
//  PM 行内 → mdast(text + marks → emphasis/strong/.../inlineCode 树)
// ============================================================

function pmInlineToMdast(parent: PMNode): PhrasingContent[] {
  // 第一步:把每个 PM 子节点扁平化成 { kind, marks, ... } 描述
  type Span =
    | { kind: 'text'; marks: ReadonlyArray<{ name: string; attrs: Record<string, unknown> }>; value: string }
    | { kind: 'image'; marks: never[]; src: string; alt: string; title: string }
    | { kind: 'break'; marks: never[] }
    | { kind: 'inlineMath'; marks: never[]; value: string }
    | { kind: 'footnoteRef'; marks: never[]; label: string }

  const spans: Span[] = []
  parent.forEach(child => {
    const name = child.type.name
    const markList = child.marks.map(m => ({ name: m.type.name, attrs: m.attrs as Record<string, unknown> }))
    if (name === 'text') {
      spans.push({ kind: 'text', marks: markList, value: child.text ?? '' })
    }
    else if (name === 'image') {
      spans.push({
        kind: 'image', marks: [],
        src: child.attrs.src as string,
        alt: child.attrs.alt as string,
        title: child.attrs.title as string,
      })
    }
    else if (name === 'hardbreak') {
      spans.push({ kind: 'break', marks: [] })
    }
    else if (name === 'math_inline') {
      spans.push({ kind: 'inlineMath', marks: [], value: child.textContent })
    }
    else if (name === 'footnote_reference') {
      spans.push({ kind: 'footnoteRef', marks: [], label: child.attrs.label as string })
    }
  })

  // 第二步:连续相同 mark 集合的 spans 合并到同一个 mark 树下。
  // 走最朴素的策略:逐 span 调用 wrapWithMarks,让 mdast-util-to-markdown 在
  // stringify 时自己合并相邻同 mark 的输出(它会做的,实测无需我们提前合并)。
  const out: PhrasingContent[] = []
  for (const span of spans) {
    if (span.kind === 'image') {
      out.push({
        type: 'image',
        url: span.src,
        alt: span.alt || null,
        title: span.title || null,
      })
    }
    else if (span.kind === 'break') {
      out.push({ type: 'break' })
    }
    else if (span.kind === 'inlineMath') {
      out.push({ type: 'inlineMath', value: span.value } as PhrasingContent)
    }
    else if (span.kind === 'footnoteRef') {
      out.push({
        type: 'footnoteReference',
        identifier: span.label,
        label: span.label,
      })
    }
    else {
      out.push(wrapWithMarks(span.value, span.marks))
    }
  }
  return out
}

/**
 * 把一段文本按 mark 列表层层包成 emphasis / strong / link / delete / inlineCode。
 * mark 顺序:inlineCode 最内(它本身是叶子,改文本节点为 inlineCode),
 * 其次按 strike_through → emphasis → strong → link 由内到外。
 *
 * 这只是个简单实现 —— 不试图全局重排相邻 span 共享 mark。stringify 阶段
 * mdast-util-to-markdown 会把相邻同 mark 节点合并,实测对单测试用例足够。
 */
function wrapWithMarks(
  text: string,
  marks: ReadonlyArray<{ name: string; attrs: Record<string, unknown> }>,
): PhrasingContent {
  // inlineCode 是文本节点变体,不能再嵌 mark
  const codeMark = marks.find(m => m.name === 'code')
  if (codeMark) {
    return { type: 'inlineCode', value: text }
  }

  let node: PhrasingContent = { type: 'text', value: text }

  // 内层 → 外层
  const order = ['strike_through', 'emphasis', 'strong', 'link']
  for (const name of order) {
    const mark = marks.find(m => m.name === name)
    if (!mark) continue
    if (name === 'strike_through') {
      node = { type: 'delete', children: [node] }
    }
    else if (name === 'emphasis') {
      node = { type: 'emphasis', children: [node] }
    }
    else if (name === 'strong') {
      node = { type: 'strong', children: [node] }
    }
    else if (name === 'link') {
      node = {
        type: 'link',
        url: mark.attrs.href as string,
        title: (mark.attrs.title as string | null) ?? null,
        children: [node as PhrasingContent],
      }
    }
  }

  return node
}

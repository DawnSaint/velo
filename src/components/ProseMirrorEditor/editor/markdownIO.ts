// Markdown ↔ ProseMirror doc 双向转换。
//
// 已知信息丢失(文档化但不防御):
// - hardbreak attrs.isInline → 统一序列化为 `break`
// - list_item attrs.label → 由 stringify 的 bullet 配置决定
// - table cell colspan/rowspan/colwidth → mdast 不支持
// - mdast `html` 节点 → html_block / html_inline(原样存 attrs.value,
//   NodeView 用 DOMPurify sanitize 后 innerHTML 写入)
//
// mermaid(v0.4.6+):mdast `code` lang='mermaid' → PM `code_block { language: 'mermaid' }`,
// 与其他 fenced code 同管线(codeHighlight 出 shiki 高亮 + toolbar,
// MermaidDecoration widget 叠加 SVG 预览)。`mermaid` atom 节点已废弃。

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Schema, Node as PMNode, MarkType } from 'prosemirror-model'
import type { Root, RootContent, BlockContent, DefinitionContent, PhrasingContent, Table, ListItem } from 'mdast'
import { remarkPreserveEmptyLine } from '../plugins/preserveEmptyLine'
import { remarkAlert } from '../plugins/remarkAlert'
import { remarkEncodeLinkUrls } from '../plugins/remarkEncodeLinkUrls'
import { remarkHighlight } from '../plugins/remarkHighlight'
import { remarkMathFenceGuard } from '../plugins/remarkMathFenceGuard'

// ============================================================
//  unified processor
// ============================================================

const processor = unified()
  .use(remarkParse)
  .use(remarkPreserveEmptyLine)
  .use(remarkEncodeLinkUrls)
  .use(remarkGfm)
  .use(remarkMathFenceGuard)
  .use(remarkMath)
  .use(remarkAlert)
  .use(remarkHighlight)
  .use(remarkStringify, {
    bullet: '-',
    listItemIndent: 'one',
    emphasis: '_',
    strong: '*',
    fences: true,
    rule: '-',
    ruleSpaces: false,
    handlers: {
      // ==xxx== 高亮。mdast 没有原生 highlight 节点,这里走 state.write
      // 原样输出 `==`,内层 children 走 state.all 让 remark-stringify 自己序列化
      // (嵌套 strong / emphasis / link 都正确)。
      highlight(state: any, node: any) {
        state.write('==')
        if (Array.isArray(node.children) && node.children.length > 0) {
          state.all(node)
        }
        state.write('==')
      },
    },
    // `highlight` 是自定义 mdast 节点,Options 类型联合里没有 —— 用 any 绕过
  } as any)

// ============================================================
//  fromMarkdown:string → ProseMirror Node
// ============================================================

export function fromMarkdown(md: string, schema: Schema): PMNode {
  const tree = processor.runSync(processor.parse(md) as Root) as Root
  const blocks = tree.children.flatMap(n => mdastBlockToPM(n, schema))
  // 空文档兜底:doc 至少要一个 paragraph
  if (blocks.length === 0) {
    return schema.node('doc', null, [schema.node('paragraph')])
  }
  return schema.node('doc', null, blocks)
}

// ============================================================
//  extractLangsFromDoc:扫 doc 收集所有 fenced code 块用到的 lang
// ============================================================
//
// 给 shiki 预装 grammar 用。doc 里出现的 lang 在 App.vue 启动期装进
// createHighlighter,首屏代码块立即出 token;未出现的 lang 留到运行时
// `ensureLanguage` 异步追加。走 mdast 不走 regex,CommonMark 缩进 / 自定义
// 容器 / 引用块嵌套的 fence 都能正确识别,跟 editor 实际看到的语义一致。
// `processor.parse` 是纯 AST 构造(无 PM 转换、无 stringify),代价可忽略。
export function extractLangsFromDoc(md: string): string[] {
  if (!md) return []
  const tree = processor.parse(md) as Root
  const seen = new Set<string>()
  const visit = (n: Root | RootContent): void => {
    if (n.type === 'code' && n.lang) {
      seen.add(n.lang.toLowerCase())
    }
    // mdast 节点只有 block / root / 部分 phrasing 节点带 children,统一读
    if ('children' in n && Array.isArray((n as { children?: unknown }).children)) {
      for (const c of (n as { children: RootContent[] }).children) visit(c)
    }
  }
  visit(tree)
  return [...seen]
}

// URL 在解析时已被 encodeLinkUrlSpaces 转成 %20,PM doc 里存的是原始可读形式
// (decode 回来);toMarkdown / linkClick 等都假设 doc 里的 href 是 "可读形式"，
// 不会再二次 encode。
// 注:remarkEncodeLinkUrls 只在 parse 前替换文本,实际产出的 mdast link 节点
// URL 字段已经含 %20(被解析器"吃"进去),但 mdast → PM 转换时通常把 URL 当
// opaque 字符串透传,所以 href 字段会以 %20 形式进 doc —— 这是个隐患,
// 必须在 mdast → PM 的 link 分支里 decode 回可读形式。
// 修复:mdastInlineToPM 的 case 'link' 处统一 decodeURIComponent。

/** mdast 块级节点 → 0..N 个 PM 节点(0 个发生在不支持的节点被吞掉时)。 */
function mdastBlockToPM(node: RootContent, schema: Schema): PMNode[] {
  if ((node as any).type === 'alert') {
    const alertNode = node as any
    return [schema.node('alert', {
      variant: String(alertNode.variant ?? 'note').toLowerCase(),
    }, ((alertNode.children ?? []) as RootContent[]).flatMap((c: RootContent) => mdastBlockToPM(c, schema)))]
  }

  switch (node.type) {
    case 'paragraph': {
      // [TOC] 独占段落 → toc 节点(trim 容忍首尾空白,不误伤正文含 [TOC] 的段落)
      const text = node.children.map(c => (c as any).type === 'text' ? (c as any).value : '').join('')
      if (text.trim() === '[TOC]') {
        return [schema.node('toc')]
      }
      return [schema.node('paragraph', null, mdastInlineToPM(node.children, schema))]
    }

    case 'heading':
      return [schema.node('heading', { level: node.depth },
        mdastInlineToPM(node.children, schema))]

    case 'blockquote':
      return [schema.node('blockquote', null,
        node.children.flatMap(c => mdastBlockToPM(c, schema)))]

    case 'thematicBreak':
      return [schema.node('hr')]

    case 'code': {
      // mermaid 与其他 fenced code 一视同仁 → code_block { language: 'mermaid' }。
      // MermaidDecoration widget 负责在 pre 之后叠加 SVG 预览。
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
      // footnote_definition 要求 'footnote_label block+',children 至少一个
      // 描述段;但 label 强制由 footnote_label 节点承载(mdast identifier → 文本)。
      // 描述段为 0 时,自动补一个空 paragraph 满足 'block+'。
      if (children.length === 0) children.push(schema.node('paragraph'))
      // 把 mdast identifier 放在 children 最前,作为 footnote_label text content。
      // schema 不允许把 label 塞进 attrs.label(已删除),改走 content 路径
      // —— 与 footnote_reference 的 'label as text content' 修复同范式。
      const labelNode = schema.node('footnote_label', null,
        label ? [schema.text(label)] : [])
      return [schema.node('footnote_definition', null, [labelNode, ...children])]
    }

    case 'table':
      return [mdastTableToPM(node, schema)]

    case 'html':
      // 块级 HTML 整体存 attrs.value;空 value 过滤(不渲染空 div 块)
      if (!node.value) return []
      // preserveEmptyLine 注入的 <br /> 占位:代表"1 个空段",转空 paragraph。
      // 不走 html_block 路径(那个会被 NodeView 渲染成单独的 <div> 块,
      // 跟"空段"语义对不上)。toMarkdown 靠 childCount=0 识别空段,无需 attr。
      if (node.value === '<br />') {
        return [schema.node('paragraph')]
      }
      return [schema.node('html_block', { value: node.value })]

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
  return mergeHtmlInlineRuns(schema, out)
}

/**
 * 合并相邻的 html_inline 节点 + 其间的纯文本节点,形成完整的 HTML 区域。
 *
 * remark 把 `<kbd>Ctrl</kbd>` 拆成 3 个 mdast 节点(html("<kbd>") / text("Ctrl") /
 * html("</kbd>")),逐个转 PM 会得到 3 个独立 atom 节点,NodeView 把每个渲染成独立
 * span:开标签 span 渲染成空 kbd、文本游离在 span 外、闭标签 span 空。视觉上
 * `<kbd>Ctrl</kbd>` 变成 `<kbd></kbd>Ctrl` 然后挂个孤立闭标签。
 *
 * 这里走一个简易标签栈状态机:遇到第一个 html_inline 节点开始缓冲,持续收
 * html + text 直到标签栈清空(说明完整标签对已收齐)。栈用简易正则扫 —— 只
 * 关心开始 / 结束 / 自闭合标签,够覆盖 sample.md 全部场景。
 *
 * 已知限制:HTML 区域内的文本如果带 mark(emphasis / strong 等),合并后 mark
 * 会丢 —— 我们用 `.text` 拿纯文本。保 mark 需要保留各 PM 节点原样,但那正
 * 好是当前问题。后续要做的话改 span tree。
 */
function mergeHtmlInlineRuns(schema: Schema, nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = []
  let buf: string | null = null
  let openTags: string[] = []

  const flush = () => {
    if (buf !== null) {
      out.push(schema.node('html_inline', { value: buf }))
      buf = null
      openTags = []
    }
  }

  // 扫 <tag> / </tag> / <tag/> 三种。attr 内容里可能有 > 之外的字符,<script> 这种
  // 也照样能匹配;够用。
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g

  for (const node of nodes) {
    if (node.type.name === 'html_inline') {
      const value = node.attrs.value as string
      if (buf === null) buf = ''
      buf += value
      // 更新标签栈
      for (const m of value.matchAll(tagRe)) {
        const tag = m[1]
        const isClose = m[0].startsWith('</')
        const isSelfClose = m[0].endsWith('/>')
        if (isClose) {
          const idx = openTags.lastIndexOf(tag)
          if (idx >= 0) openTags.splice(idx, 1)
        }
        else if (!isSelfClose) {
          openTags.push(tag)
        }
      }
      // 标签栈空 → 整段 HTML 区域已收齐,flush
      if (openTags.length === 0) flush()
    }
    else if (node.type.name === 'text' && buf !== null) {
      // HTML 区域内的纯文本:并入缓冲区(marks 会丢,见函数注释)
      buf += node.text ?? ''
    }
    else {
      // HTML 区域外的节点 / 区域内的非文本节点(如 hardbreak):先 flush,再透传
      flush()
      out.push(node)
    }
  }
  // 收尾:还有未 flush 的 buffer(说明 HTML 标签没正常闭合),照原样当一个区域
  flush()
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

  // remarkHighlight 注入的 'highlight' 节点不在 PhrasingContent 类型联合里,
  // 把 node 当 any 处理 —— 各分支访问的字段都在运行时存在。
  const n = node as any

  switch (n.type) {
    case 'text':
      return n.value ? [schema.text(n.value, marks)] : []

    case 'inlineCode':
      return [schema.text(n.value, marks.concat(schema.marks.code.create()))]

    case 'emphasis':
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.emphasis })))

    case 'strong':
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.strong })))

    case 'highlight':
      // remarkHighlight 注入的自定义节点,无 GFM 原生对应物。
      // children 复用 inlineNodeToPM 递归 + 把 highlight mark push 到 activeMarks。
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.highlight })))

    case 'delete':
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.strike_through })))

    case 'link':
      // remarkParse 看到的 url 是经 remarkEncodeLinkUrls 预处理过的,
      // URL 里的内部空格被 encode 成 %20。这里 decode 回可读形式,
      // 让 doc.link.attrs.href 是用户友好形态:
      //   输入 `[回到开头](# Markdown 语法)` → PM doc 里 href = '# Markdown 语法'
      //   序列化 toMarkdown 也直接写回 '# Markdown 语法'(round-trip 友好)
      // scrollToAnchor 走 slug 化降级匹配跳转(plugins/linkClick.ts)。
      let href = n.url
      try {
        href = decodeURIComponent(href)
      }
      catch {
        /* decode 失败就保留原值(可能本来就是 %20 字面量) */
      }
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({
            type: schema.marks.link,
            attrs: { href, title: n.title ?? null },
          })))

    case 'image':
      return [schema.node('image', {
        src: n.url,
        alt: n.alt ?? '',
        title: n.title ?? '',
      })]

    case 'break':
      return [schema.node('hardbreak')]

    case 'inlineMath':
      // math_inline content 是 text*,把 source 当文本塞进去
      return [schema.node('math_inline', null,
        n.value ? [schema.text(n.value)] : [])]

    case 'footnoteReference':
      // label 作为 footnote_reference 的 text content(非 attrs.label)。
      // schema 里 footnote_reference 是 content:'text*' 的非 atom inline 节点,
      // PM selection 能进入 sup 逐字符编辑 label。
      return [schema.node('footnote_reference', null,
        n.identifier ? [schema.text(n.identifier)] : [])]

    case 'html':
      // 行内 HTML:atom 节点,不带外层 marks(对照 image 行为)
      if (!n.value) return []
      return [schema.node('html_inline', { value: n.value })]

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
      if (node.childCount === 0) {
        return { type: 'paragraph', children: [{ type: 'text', value: '' }] }
      }
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

    case 'alert': {
      const variant = String(node.attrs.variant ?? 'note').toUpperCase()
      const marker = `[!${variant}]`
      const children = pmBlocksToMdast(node) as (BlockContent | DefinitionContent)[]

      // marker 用 mdast html 节点而不是 text 节点 —— mdast-util-to-markdown 对
      // phrasing 内的 `[` 默认转义(防 link reference 歧义),但 html 节点不受
      // 这条规则约束,原样写出 `[!NOTE]`。
      if (children[0]?.type === 'paragraph') {
        const first = children[0] as { type: 'paragraph'; children: PhrasingContent[] }
        first.children.unshift({ type: 'html', value: `${marker}\n` })
      }
      else {
        children.unshift({
          type: 'paragraph',
          children: [{ type: 'html', value: marker }],
        })
      }

      return {
        type: 'blockquote',
        children,
      }
    }

    case 'hr':
      return { type: 'thematicBreak' }

    case 'code_block':
      return {
        type: 'code',
        lang: (node.attrs.language as string) || null,
        value: node.textContent,
      }

    case 'math_block':
      return { type: 'math', value: node.attrs.value as string } as RootContent

    case 'html_block':
      // 原样写出 attrs.value;remark-stringify 对 mdast html 节点不做 escape
      return { type: 'html', value: node.attrs.value as string }

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

    case 'footnote_definition': {
      // identifier 从 firstChild(footnote_label 节点)读 text content,
      // 非 attrs.label(已删除)—— 与 footnote_reference 'label as text content'
      // 修复同范式。
      const label = node.firstChild?.textContent ?? ''
      return {
        type: 'footnoteDefinition',
        identifier: label,
        label,
        children: pmBlocksToMdast(node) as (BlockContent | DefinitionContent)[],
      }
    }

    case 'table':
      return pmTableToMdast(node)

    case 'toc':
      // toc 节点序列化回 [TOC] 独占段落。
      // 用 html 节点而非 text 节点:remark-stringify 对 text 节点里的 `[` 会
      // 转义成 `\[`(防 link reference 歧义),html 节点不受此规则,原样输出。
      return { type: 'paragraph', children: [{ type: 'html', value: '[TOC]' }] }

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
    | { kind: 'htmlInline'; marks: never[]; value: string }

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
      // label 从 text content 读(非 attrs.label)—— schema 里 footnote_reference
      // 是 content:'text*' 的非 atom inline 节点
      spans.push({ kind: 'footnoteRef', marks: [], label: child.textContent || '' })
    }
    else if (name === 'html_inline') {
      // atom 节点:marks 字段在 dispatch 时也硬编码为 []，与 image 一致
      spans.push({ kind: 'htmlInline', marks: [], value: child.attrs.value as string })
    }
  })

  // 第二步:先抽 highlight run(==xxx==),再走剩余 spans 的 wrapWithMarks。
  //
  // 为什么要先抽 highlight:highlight 不是 GFM 的原生 mark,wrapWithMarks 不知道
  // 它,会丢 mark。所以这里把"连续 text span 都含 highlight mark"的那一段
  // 抽出来,strip highlight mark(保留其他 mark),输出成 `[html '==', ...内层 mdast..., html '==']`
  // 三个兄弟节点 —— mdast html 节点原样输出,不会被 escape(`=` 在 start-of-inline
  // 位置会被 remark-stringify 当 setext heading 前缀 escape 成 `\=`,改用 html 节点避开)。
  //
  // 不抽 atom(image / math_inline / footnoteRef / hardbreak / html_inline):
  // 这些跨节点的 highlight 在规范上本就不该支持(round-trip 后断)。
  // 实测 schema 里 highlight 不带在 atom 上,所以 typeAt 的输入只会让
  // 文本节点带 highlight mark,这段逻辑对简单场景足够。
  const out: PhrasingContent[] = []
  let i = 0
  while (i < spans.length) {
    const span = spans[i]
    if (span.kind === 'text' && span.marks.some(m => m.name === 'highlight')) {
      const start = i
      let end = i
      while (
        end < spans.length
        && spans[end].kind === 'text'
        && spans[end].marks.some(m => m.name === 'highlight')
      ) {
        end++
      }
      const inner: PhrasingContent[] = []
      for (let j = start; j < end; j++) {
        const sub = spans[j]
        if (sub.kind !== 'text') continue // TS narrow 兜底,while 已保证是 text
        const noHighlight = sub.marks.filter(m => m.name !== 'highlight')
        inner.push(wrapWithMarks(sub.value, noHighlight))
      }
      if (inner.length > 0) {
        // 用 html 节点作 `==` 边界 —— 不会被 escape
        out.push({ type: 'html', value: '==' } as PhrasingContent)
        out.push(...inner)
        out.push({ type: 'html', value: '==' } as PhrasingContent)
      }
      // else: 极端情况,跳过(空 highlight run 不输出 `====`)
      i = end
      continue
    }
    // 非 highlight span:照旧
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
    else if (span.kind === 'htmlInline') {
      out.push({ type: 'html', value: span.value } as PhrasingContent)
    }
    else {
      out.push(wrapWithMarks(span.value, span.marks))
    }
    i++
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

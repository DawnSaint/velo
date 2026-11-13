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

import remarkStringify from 'remark-stringify'
import type { Schema, Node as PMNode, Mark, MarkType } from 'prosemirror-model'
import type { Root, RootContent, BlockContent, DefinitionContent, PhrasingContent, Table, ListItem } from 'mdast'
import { resolveShikiLang } from '../nodes/CodeBlockLangs'
import { parseHtmlImageSource, serializeHtmlImageSource } from '../image/imageSource'
import type { FrontmatterLang } from '../syntax/block/frontmatter'
import { createParseProcessor, preprocessSource } from './parseProcessor'
import { CHAR_REF_MARK, scanCharRefs } from './charRef'
import type { CharRefAt, CharRefSegment } from './charRef'
// remark-parse 实际解析的是 preprocessSource(md)（空行 → `<br />`、URL 空格 →
// %20 两次改写之后），mdast 的 position.offset 也是相对这份字符串；
// annotateEmphasisMarker / annotateMathDelimiterCount 用 offset 回查源文本，
// 必须喂同一份，否则 offset 错位 → marker / 分隔符数量识别失败。
// 见 parseProcessor.preprocessSource。

// ============================================================
//  unified processor
// ============================================================

/**
 * 自定义 strong / emphasis handler —— 覆盖 mdast-util-to-markdown 默认 handler。
 *
 * 两个 handler 共同解决两个问题:
 *
 * 1. **marker 保真**:默认 handler 用全局 option(strong:'*' / emphasis:'_')决定
 *    分隔符,PM doc 中 mark.attrs.marker 记录的 `*`/`_` 在序列化时丢失。
 *    修复:pmInlineToMdast 把 mark.attrs.marker 写入 mdast 节点的 `_marker` 字段,
 *    handler 优先读 `node._marker`,fallback 到 state.options。
 *    这样 `*xxx*` 的 emphasis(marker='*')序列化后仍是 `*xxx*`,不再变 `_xxx_`。
 *
 * 2. **CJK outside 编码跳过**:默认 strong handler 在内容以标点结尾且后跟字母时,
 *    会把字母编码为 HTML 实体(如 `&#x6B63;`),防 `**` 闭合判定失败。
 *    但 remarkCjkEmphasis 插件已在 parse 阶段修复 CJK 标点问题,outside 编码不再必要。
 *
 * 3. **首尾空白移出界定符(不编码)**:CommonMark 不允许 `**foo **`(闭合界定符前
 *    紧贴空白不构成 strong)。上游 mdast-util-to-markdown 用 inside 编码把边界空格
 *    写成 `&#x20;` 保真;边界空格渲染上与普通空格无异,移到界定符外即可得到
 *    干净且等价的源码(见 wrapAttention)。代价:round-trip 后该空格不再属于 mark run。
 *    前提:parse 侧不把 CommonMark 非法的 `** foo**` 补成 strong
 *    (`remarkCjkEmphasis` 已跳过首尾空白匹配),否则会把用户源码改写成 `**foo**`。
 */

// 把 attention(strong/emphasis)内容首尾的空白移出界定符,而不是编码成 `&#x20;`。
// 内容全是空白时加粗/斜体无意义,直接输出空白(丢弃界定符),避免产出 `****`。
// inner 内容始终以 `**`/`*` 为前后上下文(空白移到界定符外不影响 inner 的
// containerPhrasing 序列化),外层 containerPhrasing 会对完整返回串重新 track。
function wrapAttention(before: string, between: string, after: string): string {
  const lead = between.match(/^[ \t]+/)?.[0] ?? ''
  const trail = between.match(/[ \t]+$/)?.[0] ?? ''
  const inner = between.slice(lead.length, between.length - trail.length)
  if (inner.length === 0) return between
  return lead + before + inner + after + trail
}

const strongHandler = function (node: any, _parent: any, state: any, info: any) {
  const marker = node._marker || state.options.strong || '*'
  const exit = state.enter('strong')
  const tracker = state.createTracker(info)
  const before = tracker.move(marker + marker)

  const between = tracker.move(
    state.containerPhrasing(node, {
      after: marker,
      before,
      ...tracker.current(),
    })
  )

  const after = tracker.move(marker + marker)
  exit()

  // 跳过 outside 编码:不设置 attentionEncodeSurroundingInfo。
  state.attentionEncodeSurroundingInfo = undefined

  return wrapAttention(before, between, after)
}
strongHandler.peek = function (_node: any, _parent: any, state: any) {
  return state.options.strong || '*'
}

/**
 * 自定义 emphasis handler —— 与 strongHandler 同范式。
 * 读 `node._marker` 决定用 `*` 还是 `_`,保 marker 保真。
 * emphasis 单字符分隔符,strong 双字符;其余逻辑(首尾空白移出 / outside 跳过)一致。
 */
const emphasisHandler = function (node: any, _parent: any, state: any, info: any) {
  const marker = node._marker || state.options.emphasis || '_'
  const exit = state.enter('emphasis')
  const tracker = state.createTracker(info)
  const before = tracker.move(marker)

  const between = tracker.move(
    state.containerPhrasing(node, {
      after: marker,
      before,
      ...tracker.current(),
    })
  )

  const after = tracker.move(marker)
  exit()

  state.attentionEncodeSurroundingInfo = undefined

  return wrapAttention(before, between, after)
}
emphasisHandler.peek = function (_node: any, _parent: any, state: any) {
  return state.options.emphasis || '_'
}

// 主线程 processor = parse 管线（共享） + stringify 配置（仅主线程需要）。
// parse 部分由 createParseProcessor() 提供，与 markdownWorker.ts 共享同一配置。
const processor = createParseProcessor()
  .use(remarkStringify, {
    bullet: '-',
    listItemIndent: 'one',
    emphasis: '_',
    strong: '*',
    fences: true,
    rule: '-',
    ruleSpaces: false,
    handlers: {
      // 自定义 strong / emphasis handler(见上方定义):
      // 读 node._marker 保 `*`/`_` 分隔符往返不串(emphasis 默认 '_',
      // strong 默认 '*' → 恒定输出会丢 PM doc 中 mark.attrs.marker)。
      strong: strongHandler,
      emphasis: emphasisHandler,
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
      // <u>text</u> 下划线。与 highlight 同范式:state.write 原样输出 <u> / </u>,
      // 内层 children 走 state.all 让 remark-stringify 自己序列化。
      underline(state: any, node: any) {
        state.write('<u>')
        if (Array.isArray(node.children) && node.children.length > 0) {
          state.all(node)
        }
        state.write('</u>')
      },
      // ^text^ 上标。与 highlight 同范式:state.write 原样输出 `^`,
      // 内层 children 走 state.all 让 remark-stringify 自己序列化。
      superscript(state: any, node: any) {
        state.write('^')
        if (Array.isArray(node.children) && node.children.length > 0) {
          state.all(node)
        }
        state.write('^')
      },
      // ~text~ 下标。与 highlight 同范式:state.write 原样输出 `~`,
      // 内层 children 走 state.all 让 remark-stringify 自己序列化。
      subscript(state: any, node: any) {
        state.write('~')
        if (Array.isArray(node.children) && node.children.length > 0) {
          state.all(node)
        }
        state.write('~')
      },
      // 行内公式:覆盖 remark-math 的 inlineMath handler,根据 delimiterCount
      // 决定输出 `$value$`(单 $)还是 `$$value$$`(双 $)。remark-math 默认总用
      // 单 $,会把 doc 里的 `$$x$$` 降级成 `$x$`。padding / value 含 $ 升级 size
      // 的逻辑保留自 mdast-util-math 的 inlineMath handler,确保边缘场景一致。
      // handler 签名 (node, parent, state, info) —— 见 mdast-util-to-markdown。
      inlineMath(node: any, _parent: any, _state: any) {
        let value = node.value || ''
        const delimiterCount = (node.delimiterCount as number) || 1
        let size = delimiterCount
        // value 里若出现 size 个连续 $ 的孤立序列,升级 size 防提前闭合
        while (new RegExp('(^|[^$])' + '\\$'.repeat(size) + '([^$]|$)').test(value)) {
          size++
        }
        const sequence = '$'.repeat(size)
        // padding:value 首尾是空格/换行 或 首尾是 $ 时,前后补空格防歧义
        if (
          /[^ \r\n]/.test(value) &&
          ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^\$|\$$/.test(value))
        ) {
          value = ' ' + value + ' '
        }
        return sequence + value + sequence
      },
      // 图片:覆盖默认 handler,不转义 URL 中的 `(` `)` —— 本地文件路径常含
      // 括号(如 `(null).png`),默认 safe() 会转义成 `\(` `\)`,导致源码模式
      // 出现转义符号。CommonMark 规范允许 balanced 括号出现在 link destination,
      // remark-parse 也能正确解析,因此不转义不影响 round-trip。
      // URL 含空格时用 `<>` 包裹(CommonMark 要求),否则直接输出。
      image(node: any) {
        const alt = (node.alt || '').replace(/\\/g, '\\\\').replace(/([[\]])/g, '\\$1')
        const rawUrl = node.url || ''
        const title = node.title ? ` "${node.title}"` : ''
        const url = /\s/.test(rawUrl) ? `<${rawUrl}>` : rawUrl
        return `![${alt}](${url}${title})`
      },
      // 字符实体:原样输出字面量,不走 state.safe(它会把 & 转义成 \&,
      // 写盘后实体就变成了普通文本)。
      charRef(node: { value?: string }) {
        return node.value || ''
      },
    },
    // `highlight` 是自定义 mdast 节点,Options 类型联合里没有 —— 用 any 绕过
  } as any)

// ============================================================
//  fromMarkdown:string → ProseMirror Node
// ============================================================

/**
 * mdast tree → ProseMirror doc（共享核心：fromMarkdown 和 fromMarkdownAsync 共用）。
 *
 * annotateMathDelimiterCount 需要 md 原文回查 offset，mdastBlockToPM 需要 schema —— 两步
 * 都依赖主线程上下文，不能在 Worker 里做。Worker 只负责 parse + runSync 产出 mdast。
 */
function mdastToPMDoc(tree: Root, md: string, schema: Schema): PMNode {
  annotateMathDelimiterCount(tree, md)
  annotateEmphasisMarker(tree, md)
  annotateCharRefs(tree, md)
  const blocks = tree.children.flatMap(n => mdastBlockToPM(n, schema))
  if (blocks.length === 0) {
    return schema.node('doc', null, [schema.node('paragraph')])
  }
  if (blocks.length === 1 && blocks[0].type.name === 'frontmatter') {
    blocks.push(schema.node('paragraph'))
  }
  return schema.node('doc', null, blocks)
}

export function fromMarkdown(md: string, schema: Schema): PMNode {
  const tree = processor.runSync(processor.parse(md) as Root) as Root
  // 用 remark-parse 实际解析的预处理字符串回查 offset（见文件顶部 import 注释）
  return mdastToPMDoc(tree, preprocessSource(md), schema)
}

// ============================================================
//  fromMarkdownAsync: Web Worker 后台 parse → 主线程 mdastToPMDoc
// ============================================================
//
// C1: 将 remark-parse + runSync（大文档主线程瓶颈）移入 Worker。
// Worker 只做 parse + runSync，返回 mdast JSON；主线程拿到后执行 mdastToPMDoc
// （需要 schema + md 原文，不能在 Worker 做）。
//
// Worker 失败（创建失败 / parse 报错 / 超时）时自动降级到同步 fromMarkdown。

let _worker: Worker | null = null
let _workerFailed = false
let _nextId = 1

function getWorker(): Worker | null {
  if (_workerFailed) return null
  if (_worker) return _worker
  try {
    _worker = new Worker(
      new URL('./markdownWorker.ts', import.meta.url),
      { type: 'module' },
    )
    _worker.onerror = (e) => {
      // Worker 创建后发生不可恢复错误，标记失败，后续请求降级到同步
      console.warn('[markdownIO] Worker error, falling back to sync:', e.message || e)
      _workerFailed = true
      _worker = null
    }
    return _worker
  } catch (e) {
    console.warn('[markdownIO] Worker creation failed, falling back to sync:', e)
    _workerFailed = true
    return null
  }
}

/**
 * 异步 parse：Worker 后台 parse + runSync → 主线程 mdastToPMDoc。
 *
 * Worker 不可用时降级到同步 fromMarkdown。
 * 超时（默认 10s）也降级到同步。
 */
export async function fromMarkdownAsync(
  md: string,
  schema: Schema,
  opts?: { signal?: AbortSignal; timeout?: number },
): Promise<PMNode> {
  const worker = getWorker()
  if (!worker) {
    return fromMarkdown(md, schema)
  }

  const id = _nextId++
  const timeout = opts?.timeout ?? 10_000

  return new Promise<PMNode>((resolve) => {
    let settled = false

    const cleanup = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      if (timer) clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onAbort)
    }

    const fallback = () => {
      if (settled) return
      settled = true
      cleanup()
      console.warn('[markdownIO] Worker parse fallback (error/timeout), using sync')
      // 降级到同步 parse
      resolve(fromMarkdown(md, schema))
    }

    const onMessage = (e: MessageEvent) => {
      if (e.data?.id !== id) return
      if (settled) return
      settled = true
      cleanup()
      const { tree, error } = e.data
      if (error || !tree) {
        resolve(fromMarkdown(md, schema))
        return
      }
      resolve(mdastToPMDoc(tree as Root, preprocessSource(md), schema))
    }

    const onError = () => fallback()
    const onAbort = () => fallback()

    const timer = setTimeout(fallback, timeout)
    opts?.signal?.addEventListener('abort', onAbort)

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage({ id, md })
  })
}

/**
 * 遍历 mdast,给每个 inlineMath 节点加 `delimiterCount` 字段(1 或 2)。
 *
 * remark-math 的 mathFromMarkdown 把 `$x$` / `$$x$$` 都剥成 inlineMath.value=`x`,
 * 丢失了分隔符数量信息。这里用 node.position.start.offset(指向分隔符首个 `$`)
 * 从该位置向后数连续 `$` 的数量(上限 2,因为 micromark 只支持 1 或 2 个 $)。
 *
 * position.offset 来自 strictMath 解析树,直接对齐 preprocessSource(md) 的结果
 * (见 parseProcessor.preprocessSource),与旧 remarkMathFenceGuard 无关。
 */
function annotateMathDelimiterCount(tree: Root, md: string): void {
  const visit = (node: any): void => {
    if (node.type === 'inlineMath') {
      const offset = node.position?.start?.offset
      if (typeof offset === 'number') {
        // offset 指向分隔符首个 `$`,向后数连续 $ (inlineMath position 含分隔符)
        let count = 0
        let i = offset
        while (i < md.length && md[i] === '$') { count++; i++ }
        node.delimiterCount = Math.max(1, Math.min(count, 2))
      }
      else {
        node.delimiterCount = 1
      }
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) visit(c)
    }
  }
  visit(tree)
}

/**
 * 从原始 markdown 文本回查 emphasis / strong 节点实际使用的分隔符(`*` / `_`),
 * 注入到 mdast 节点的 `_marker` 字段。mdast 的 emphasis/strong 节点本身不记录
 * 分隔符种类(只有 type + children),remarkStringify 用全局 option
 * (emphasis:'_' / strong:'*')决定输出。但 PM schema 的 emphasis/strong 有
 * marker attr(markSourceEdit 的 buildMarkSource 读它决定源码显示 `*xxx*` / `_xxx_`),
 * fromMarkdown 默认用 schema 默认值 `'*'`,会导致 `_xxx_` 加载后光标进入 mark
 * 源码编辑显示成 `*xxx*`。
 *
 * 与 annotateMathDelimiterCount 同范式:从 node.position.start.offset 回查 md 原文。
 * position 含分隔符本身(emphasis: md[start] 是首个 `_`/`*`;
 * strong: md[start] 和 md[start+1] 都是 `_`/`*`)。
 */
function annotateEmphasisMarker(tree: Root, md: string): void {
  const visit = (node: any): void => {
    if (node.type === 'emphasis' || node.type === 'strong') {
      const offset = node.position?.start?.offset
      if (typeof offset === 'number' && offset < md.length) {
        const ch = md[offset]
        if (ch === '_' || ch === '*') {
          node._marker = ch
        }
      }
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) visit(c)
    }
  }
  visit(tree)
}

/**
 * 给 mdast text 节点标注字符实体位置(_charRefs)。
 *
 * remark-parse 已把实体解码进 node.value,字面量只剩在原文里。用 node.position.offset
 * 回查 preprocessSource 后的 md,模拟一遍解码得到「解码串下标 → 实体字面量」。
 * 与 annotateEmphasisMarker 同范式,只标能严格对齐的节点。
 */
interface MdastLike {
  type?: string
  value?: unknown
  position?: { start?: { offset?: number }, end?: { offset?: number } }
  children?: MdastLike[]
  _charRefs?: CharRefAt[]
}

function annotateCharRefs(tree: Root, md: string): void {
  const visit = (node: MdastLike): void => {
    // 不能用 node.value.includes('&') 过滤:实体解码后往往正好不含 &,
    // 纯实体文本(首尾&#x20;&#8203;相邻 / **&#x20; ... **)会被整段漏掉。
    if (node.type === 'text' && typeof node.value === 'string') {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (typeof start === 'number' && typeof end === 'number' && end <= md.length) {
        const refs = scanCharRefs(md.slice(start, end), node.value)
        if (refs?.length) node._charRefs = refs
      }
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) visit(c)
    }
  }
  visit(tree as unknown as MdastLike)
}

/**
 * 带实体标注的 mdast text → PM inline 节点。
 * 连续实体合成一个 text 节点(char_ref mark 带 segments),其余区间照旧拆 soft break。
 */
function charRefTextToPM(
  value: string,
  refs: CharRefAt[],
  marks: readonly Mark[],
  schema: Schema,
): PMNode[] {
  const charRefType = schema.marks[CHAR_REF_MARK]
  const out: PMNode[] = []
  let i = 0
  let refIdx = 0
  while (i < value.length) {
    if (refIdx < refs.length && refs[refIdx].at === i) {
      const segments: CharRefSegment[] = []
      let cursor = i
      while (refIdx < refs.length && refs[refIdx].at === cursor) {
        const r = refs[refIdx]
        segments.push({ raw: r.raw, text: r.text })
        cursor += r.text.length
        refIdx++
      }
      out.push(schema.text(
        segments.map(s => s.text).join(''),
        marks.concat(charRefType.create({ segments })),
      ))
      i = cursor
      continue
    }
    let end = i
    while (end < value.length && value[end] !== '\n'
      && !(refIdx < refs.length && refs[refIdx].at === end)) end++
    if (end > i) out.push(schema.text(value.slice(i, end), marks))
    if (end < value.length && value[end] === '\n') {
      out.push(schema.node('hardbreak'))
      i = end + 1
    }
    else {
      i = end
    }
  }
  return out
}

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
  // 访问器需要覆盖 frontmatter 节点(toml 不在 RootContent 联合中),故用宽的
  // 形状类型,通过 type 字段分发。
  type VisitNode = Root | RootContent | { type: FrontmatterLang; value: string }
  const visit = (n: VisitNode): void => {
    if (n.type === 'code' && n.lang) {
      seen.add(resolveShikiLang(n.lang))
    }
    // frontmatter(remark-frontmatter 输出的 mdast `yaml` / `toml` 节点)始终走对应
    // shiki grammar 高亮(yaml / toml 各自独立 grammar),提前装进 seed 列表,
    // 首屏直接出 token 免闪烁。节点类型本身即为 shiki lang id,直接透传。
    if (n.type === 'yaml' || n.type === 'toml') {
      seen.add(n.type)
    }
    // mdast 节点只有 block / root / 部分 phrasing 节点带 children,统一读
    if ('children' in n && Array.isArray((n as { children?: unknown }).children)) {
      for (const c of (n as { children: RootContent[] }).children) visit(c)
    }
  }
  visit(tree)
  return [...seen]
}

// remarkEncodeLinkUrls 在 parse 前把 URL 内部空格 encode 成 %20,mdast link 节点的
// url 字段因此含 %20。mdast → PM 的 link 分支(decodeURIComponent)把它还原为可读形式,
// 保 toMarkdown / linkClick 看到的 href 是用户友好形态,不会再二次 encode。

/**
 * mdast 块级节点 → 0..N 个 PM 节点(0 个发生在不支持的节点被吞掉时)。
 *
 * 参数覆盖 RootContent 外加 remark-frontmatter 输出的 toml 节点(type='toml',
 * 不在 mdast 默认 RootContent 联合中)。
 */
type BlockContentWide = RootContent | { type: 'toml'; value: string }
function mdastBlockToPM(node: BlockContentWide, schema: Schema): PMNode[] {
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
      // B2:math_block content 含首尾 `$$`,source 前后补 `$$\n` 包裹,使 `$$` 独占一行。
      // `$$\n${value}\n$$` → 编辑态 source 3 行,阅读态 stripDelimiters 得 ${value} 给 katex。
      // 空 value 仍需 `$$` 占位,否则节点 content 为空文本(合法但 NodeView 占位态)。
      return [schema.node('math_block', null, schema.text(`$$\n${node.value}\n$$`))]

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

    case 'html': {
      // 块级 HTML 整体存 attrs.value;空 value 过滤(不渲染空 div 块)
      if (!node.value) return []
      // preserveEmptyLine 注入的 <br /> 占位:代表"1 个空段",转空 paragraph。
      // 不走 html_block 路径(那个会被 NodeView 渲染成单独的 <div> 块,
      // 跟"空段"语义对不上)。toMarkdown 靠 childCount=0 识别空段,无需 attr。
      if (node.value === '<br />') {
        return [schema.node('paragraph')]
      }
      // 单行 <hr> / <hr /> / <hr  > 等 HTML 分割线 → hr 节点(同 --- 语义)。
      // 不保留原始 HTML 形态(round-trip 后序列化为 ---),不支持展开源码编辑。
      if (/^<hr\b[^>]*>$/i.test(node.value)) {
        return [schema.node('hr')]
      }
      // 独立 <img src="..." alt="..." title="..."> 标签(仅 src/alt/title 属性)
      // → 接管为 image 节点(htmlSource=true),可选中 + 点按钮展开源码编辑。
      // 含额外属性(width 等)或 img 嵌套在 HTML 内 → 不匹配,保留 html_block。
      const standaloneImg = parseHtmlImageSource(node.value)
      if (standaloneImg) {
        const { extraAttrs, ...imgAttrs } = standaloneImg
        return [schema.node('paragraph', null, [
          schema.node('image', {
            ...imgAttrs,
            htmlSource: true,
            htmlAttrs: Object.keys(extraAttrs).length ? extraAttrs : null,
          }),
        ])]
      }
      return [schema.node('html_block', { value: node.value })]
    }

    case 'yaml':
    case 'toml': {
      // remark-frontmatter 解析出的 frontmatter 块(yaml / toml)→ frontmatter 节点。
      // mdast 节点类型即种类,存入 lang 属性以驱动序列化分隔符 + shiki grammar;
      // value 是 fence 之间的原始文本(不含分隔符)。
      // node 类型收窄为 'yaml'|'toml',但 RootContent 联合未列出 toml —— 按
      // 带 value 的 frontmatter 形状做局部类型断言,避免 TS2678。
      const fmNode = node as { type: FrontmatterLang; value: string }
      const content = fmNode.value ? [schema.text(fmNode.value)] : []
      return [schema.node('frontmatter', { lang: fmNode.type }, content)]
    }

    default:
      // 不支持的块级节点 → 静默丢弃
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
    case 'text': {
      if (!n.value) return []
      // 字符实体:优先按标注切成「普通文本 / char_ref mark 文本」两套节点。
      const refs = n._charRefs as CharRefAt[] | undefined
      if (refs?.length && schema.marks[CHAR_REF_MARK]) {
        return charRefTextToPM(n.value, refs, marks, schema)
      }
      // CommonMark soft break(\n)在 mdast text 里是字面 \n,但 PM text 节点不应
      // 含 \n —— CSS pre-wrap 会渲染它,但 PM 的 DOM ↔ doc 同步在编辑时可能
      // 把 \n 拆成 <br>,导致结构突变(toMarkdown 输出变化 → 触发 reload)。
      // 拆成 text + hardbreak(soft) + text + ... 保证 PM doc 结构正确。
      // hardbreak 不带 attrs → toMarkdown 序列化为 \n(soft break);
      // mdast break(hard)→ hardbreak 带 {hard:true} → 序列化为 \\\n。
      const parts = n.value.split('\n')
      if (parts.length === 1) return [schema.text(n.value, marks)]
      const out: PMNode[] = []
      for (let k = 0; k < parts.length; k++) {
        if (parts[k]) out.push(schema.text(parts[k], marks))
        if (k < parts.length - 1) out.push(schema.node('hardbreak'))
      }
      return out
    }

    case 'inlineCode':
      return [schema.text(n.value, marks.concat(schema.marks.code.create()))]

    case 'emphasis':
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.emphasis, attrs: { marker: n._marker ?? '*' } })))

    case 'strong':
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.strong, attrs: { marker: n._marker ?? '*' } })))

    case 'highlight':
      // remarkHighlight 注入的自定义节点,无 GFM 原生对应物。
      // children 复用 inlineNodeToPM 递归 + 把 highlight mark push 到 activeMarks。
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.highlight })))

    case 'underline':
      // remarkUnderline 注入的自定义节点,无 GFM 原生对应物。
      // children 复用 inlineNodeToPM 递归 + 把 underline mark push 到 activeMarks。
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.underline })))

    case 'superscript':
      // remarkSupSub 注入的自定义节点,无 GFM 原生对应物。
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.superscript })))

    case 'subscript':
      // remarkSupSub 注入的自定义节点,无 GFM 原生对应物。
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.subscript })))

    case 'delete':
      return n.children.flatMap((c: PhrasingContent) =>
        inlineNodeToPM(c, schema,
          activeMarks.concat({ type: schema.marks.strike_through })))

    case 'link': {
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
    }

    case 'image':
      return [schema.node('image', {
        src: n.url,
        alt: n.alt ?? '',
        title: n.title ?? '',
      })]

    case 'break':
      // hard: true 区分"来自 mdast break(hard break)"和"来自 text \n(soft break)"
      return [schema.node('hardbreak', { hard: true })]

    case 'inlineMath':
      // B1:content 含 `$` 分隔符 —— `$` + value + `$`。NodeView 渲染时剥离 $ 给 katex
      // delimiterCount(2026-07-01):`$$x^2$$` 保留双 $,避免打开文件后降级成单 $。
      // 由 fromMarkdown 的 annotateMathDelimiterCount 回查原始 md 标注。
    {
      const dc = (n.delimiterCount as number) || 1
      const d = '$'.repeat(dc)
      return [schema.node('math_inline', null,
        n.value ? [schema.text(`${d}${n.value}${d}`)] : [])]
    }

    case 'footnoteReference':
      // label 作为 footnote_reference 的 text content(非 attrs.label)。
      // schema 里 footnote_reference 是 content:'text*' 的非 atom inline 节点,
      // PM selection 能进入 sup 逐字符编辑 label。
      return [schema.node('footnote_reference', null,
        n.identifier ? [schema.text(n.identifier)] : [])]

    case 'emoji':
      // remarkEmoji 注入的 emoji 节点 → PM emoji atom 节点(shortcode 在 attrs)。
      return [schema.node('emoji', { shortcode: n.shortcode ?? '' })]

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

/**
 * 文档级收尾:尾部空段补偿 + 空文档特例。
 *
 * mdast-util-to-markdown 强制文档以单个 \n 收尾并吃掉尾部空段,但 PM doc 里
 * 这些空段是活的(preprocessBlankLines 注入的 <br /> 占位转成的空 paragraph)。
 * 按 doc 尾部连续空段数 K 补 \n,使 toMarkdown(fromMarkdown(x)) 对尾部空行
 * 严格 idempotent:K=1 → 补 3 个 \n,K=2 → 补 5 个 \n(2K+1);K=0 → 单 \n。
 * 边界:恰好 1 个尾部空行(X\n\n)CommonMark 不可表示,fromMarkdown 不产空段,
 * 与 VSCode/Typora 同行为。
 *
 * 块级增量序列化(blockSerializer.ts)拼回全文后也调这里 —— 文档级后处理
 * 只有一份实现,避免两处补偿公式漂移。
 */
export function finalizeMarkdown(doc: PMNode, body: string): string {
  let k = 0
  for (let i = doc.childCount - 1; i >= 0; i--) {
    const c = doc.child(i)
    if (c.type.name === 'paragraph' && c.childCount === 0) k++
    else break
  }
  // 唯一空段是 schema 'block+' 强制的占位段 —— 那才是真空文档,canonical 为 '';
  // 空文档里按 Enter 造出的多个空段是用户有意留的空行,必须走 2K+1 补偿,
  // 否则整篇空行塌缩成 '' → content 永远等于 lastSavedContent → 不 dirty。
  if (k === doc.childCount && k <= 1) return ''
  return body.replace(/\n*$/, '') + (k > 0 ? '\n'.repeat(2 * k + 1) : '\n')
}

export function toMarkdown(doc: PMNode): string {
  const tree: Root = {
    type: 'root',
    children: pmBlocksToMdast(doc),
  }
  let out = processor.stringify(tree).toString()
  // 把 text 值中的 \u0001 占位符替换回 \\（markdown 转义反斜杠）。
  // 见 spanToLeaf 注释：绕过 escapeBackslashes 的 round-trip bug。
  out = out.replace(/\u0001/g, '\\\\')
  return finalizeMarkdown(doc, out)
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
      // 单个 htmlSource image 独占段落 → 序列化为 html 块节点(非 paragraph),
      // remark-stringify 原样输出 `<img ...>`,round-trip 回 html_block → image。
      // 不规范化为 `![]()` —— HTML 图片保持 HTML 形态。
      if (node.childCount === 1 && node.firstChild!.type.name === 'image'
        && node.firstChild!.attrs.htmlSource) {
        return { type: 'html', value: serializeHtmlImageSource({
          src: node.firstChild!.attrs.src as string,
          alt: node.firstChild!.attrs.alt as string,
          title: node.firstChild!.attrs.title as string,
          extraAttrs: (node.firstChild!.attrs.htmlAttrs as Record<string, string>) || {},
        }) }
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
// B2:content 含首尾 `$$`(独占行),剥离 $$ 并 trim 首尾换行后得纯 source。
// `$$\nx^2\n$$` → strip `$$` → `\nx^2\n` → trim → `x^2` 给 mdast math.value。
return { type: 'math', value: stripMathDelimiters(node.textContent).replace(/^\n+|\n+$/g, '') } as RootContent

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

    case 'frontmatter': {
      // frontmatter 节点序列回 mdast 节点,lang 属性决定种类(yaml / toml);
      // remark-frontmatter 的 stringify handler 会按节点种类包裹对应 fence
      // (`---` / `+++`) 输出。
      const lang = (node.attrs.lang as FrontmatterLang) || 'yaml'
      return { type: lang, value: node.textContent } as RootContent
    }

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

// B1:math_inline content 含 `$` 分隔符,序列化时剥离首尾连续 $ 得纯 source。
// `$x^2$` → `x^2`、`$$x^2$$` → `x^2`。mathInlineUnwrapPlugin 保证进来的 content
// 必匹配 `$...$`,此处兜底处理边缘(剥完为空返回空串)。
function stripMathDelimiters(s: string): string {
  return s.replace(/^\$+/, '').replace(/\$+$/, '')
}

// PM 行内子节点扁平化描述 —— pmInlineToMdast 第一步产出,processSpans 消费。
type InlineSpan =
  | { kind: 'text'; marks: ReadonlyArray<{ name: string; attrs: Record<string, unknown> }>; value: string }
  | { kind: 'image'; marks: never[]; src: string; alt: string; title: string }
  | { kind: 'break'; marks: never[]; hard: boolean }
  | { kind: 'inlineMath'; marks: never[]; value: string; delimiterCount: number }
  | { kind: 'footnoteRef'; marks: never[]; label: string }
  | { kind: 'htmlInline'; marks: never[]; value: string }
  | { kind: 'emoji'; marks: never[]; shortcode: string }

function pmInlineToMdast(parent: PMNode): PhrasingContent[] {
  // 第一步:把每个 PM 子节点扁平化成 InlineSpan
  const spans: InlineSpan[] = []
  parent.forEach(child => {
    const name = child.type.name
    const markList = child.marks.map(m => ({ name: m.type.name, attrs: m.attrs as Record<string, unknown> }))
    if (name === 'text') {
      spans.push({ kind: 'text', marks: markList, value: child.text ?? '' })
    }
    else if (name === 'image') {
      if (child.attrs.htmlSource) {
        // htmlSource image 在内联位置(非独占段落)→ 序列化为 inline html,
        // 保持 `<img>` 形态而非 `![]()`。独占段落在 pmBlockToMdast 已拦截为 html 块。
        spans.push({
          kind: 'htmlInline', marks: [],
          value: serializeHtmlImageSource({
            src: child.attrs.src as string,
            alt: child.attrs.alt as string,
            title: child.attrs.title as string,
            extraAttrs: (child.attrs.htmlAttrs as Record<string, string>) || {},
          }),
        })
      } else {
        spans.push({
          kind: 'image', marks: [],
          src: child.attrs.src as string,
          alt: child.attrs.alt as string,
          title: child.attrs.title as string,
        })
      }
    }
    else if (name === 'hardbreak') {
      // hard=true(来自 mdast break,即 `  \n` / `\\\n`)→ 序列化为 mdast break
      // hard=false(来自 text \n soft break)→ 序列化为 text \n
      spans.push({ kind: 'break', marks: [], hard: !!child.attrs.hard })
    }
    else if (name === 'math_inline') {
      // B1:content 含 `$`,序列化时剥离首尾 $ 得纯 source 给 mdast inlineMath.value
      // delimiterCount(2026-07-01):从 content 首尾 $ 数量判断,保留 `$$x$$` 双 $ 信息,
      // 避免 toMarkdown 把双 $ 降级成单 $。
      const text = child.textContent
      const openCount = (text.match(/^\$+/)?.[0] ?? '').length
      const closeCount = (text.match(/\$+$/)?.[0] ?? '').length
      const dc = Math.min(openCount, closeCount) || 1
      spans.push({ kind: 'inlineMath', marks: [], value: stripMathDelimiters(text), delimiterCount: dc })
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
    else if (name === 'emoji') {
      // emoji atom 节点:shortcode 在 attrs,序列化时输出 `:shortcode:`
      spans.push({ kind: 'emoji', marks: [], shortcode: child.attrs.shortcode as string })
    }
    // fold_placeholder:视觉节点,不序列化到 markdown(折叠态占位符)
  })

  // 第二步:按连续共享的外层 mark 构建容器树(见 processSpans)。
  return processSpans(spans)
}

// ============================================================
//  行内 mark → mdast 容器树
// ============================================================

// 容器 mark 的固定嵌套顺序(外 → 内)。PM 的 marks 是无序集合,mdast 容器有
// 先后,序列化必须选定一个稳定顺序;与 markSourceEdit 的 OPEN_ORDER 对齐。
// code 不在此列 —— inlineCode 是叶子节点,由 spanToLeaf 把 text 变成它,
// 其余 mark 照常包在外面(`**a `b` c**` 里的 `b` 仍属于 strong)。
//
// underline / highlight / sup / sub 没有 GFM 原生 mdast 容器,用 html 边界节点
// 输出(与 stringify handlers 同款),所以也纳入同一套 stack。
const CONTAINER_MARK_ORDER = [
  'underline', 'highlight', 'superscript', 'subscript',
  'link', 'strong', 'emphasis', 'strike_through',
] as const

type ContainerMarkName = typeof CONTAINER_MARK_ORDER[number]
type SpanMark = ReadonlyArray<{ name: string, attrs: Record<string, unknown> }>

interface ContainerMark {
  name: ContainerMarkName
  marker?: string
  href?: string
  title?: string | null
}

interface MarkedLeaf {
  leaf: PhrasingContent
  /** 外 → 内的容器 mark 栈 */
  stack: ContainerMark[]
}

function markFromSpan(name: ContainerMarkName, marks: SpanMark): ContainerMark | null {
  const m = marks.find(x => x.name === name)
  if (!m) return null
  if (name === 'link') {
    return {
      name,
      href: m.attrs.href as string,
      title: (m.attrs.title as string | null) ?? null,
    }
  }
  if (name === 'strong' || name === 'emphasis') {
    return { name, marker: (m.attrs.marker as string) || '*' }
  }
  return { name }
}

function sameMark(a: ContainerMark | undefined, b: ContainerMark): boolean {
  if (!a || a.name !== b.name) return false
  if (b.name === 'link') return a.href === b.href && a.title === b.title
  if (b.name === 'strong' || b.name === 'emphasis') return a.marker === b.marker
  return true
}

function htmlNode(value: string): PhrasingContent {
  return { type: 'html', value } as PhrasingContent
}

/** 单个 span → 叶子 mdast 节点。code mark 把 text 变成 inlineCode 叶子。 */
function spanToLeaf(span: InlineSpan): PhrasingContent {
  switch (span.kind) {
    case 'text':
      if (span.marks.some(m => m.name === 'code')) {
        return { type: 'inlineCode', value: span.value }
      }
      // char_ref mark 的 text 节点只含实体解码字符 —— 原样写回实体字面量。
      // segments 与文本对不上(用户在 mark 内编辑过)时退回普通 text,不写坏源码。
      {
        const refMark = span.marks.find(m => m.name === CHAR_REF_MARK)
        const segments = refMark?.attrs.segments as CharRefSegment[] | undefined
        if (Array.isArray(segments) && segments.length
          && segments.map(s => s.text).join('') === span.value) {
          return { type: 'charRef', value: segments.map(s => s.raw).join('') } as unknown as PhrasingContent
        }
      }
      // \ → \u0001 占位符,让 state.safe 不处理 \ 的转义(上游 escapeBackslashes
      // 对连续 \\ 的转义规则 N→(N+1) 与 remark-parse 的 N→ceil(N/2) 不对称,
      // 导致 round-trip 不 idempotent)。toMarkdown 输出后替换回 \\。
      return { type: 'text', value: span.value.replace(/\\/g, '\u0001') }

    case 'image':
      return {
        type: 'image',
        url: span.src,
        alt: span.alt || null,
        title: span.title || null,
      }

    case 'break':
      // hard break → mdast break(`\\\n`);soft break → 裸 \n
      return span.hard ? { type: 'break' } : { type: 'text', value: '\n' }

    case 'inlineMath':
      return {
        type: 'inlineMath',
        value: span.value,
        delimiterCount: span.delimiterCount,
      } as PhrasingContent

    case 'footnoteRef':
      return {
        type: 'footnoteReference',
        identifier: span.label,
        label: span.label,
      }

    case 'htmlInline':
      return htmlNode(span.value)

    case 'emoji':
      return htmlNode(`:${span.shortcode}:`)
  }
}

function wrapMark(mark: ContainerMark, children: PhrasingContent[]): PhrasingContent[] {
  switch (mark.name) {
    case 'link':
      return [{
        type: 'link',
        url: mark.href as string,
        title: mark.title ?? null,
        children,
      } as PhrasingContent]
    case 'strong':
      return [{ type: 'strong', children, _marker: mark.marker } as PhrasingContent & { _marker: string }]
    case 'emphasis':
      return [{ type: 'emphasis', children, _marker: mark.marker } as PhrasingContent & { _marker: string }]
    case 'strike_through':
      return [{ type: 'delete', children } as PhrasingContent]
    // 自定义 mark 没有 GFM 原生 mdast 节点 —— html 节点原样输出,不受 safe() 转义。
    case 'underline':
      return [htmlNode('<u>'), ...children, htmlNode('</u>')]
    case 'highlight':
      return [htmlNode('=='), ...children, htmlNode('==')]
    case 'superscript':
      return [htmlNode('^'), ...children, htmlNode('^')]
    case 'subscript':
      return [htmlNode('~'), ...children, htmlNode('~')]
  }
}

/**
 * 按「连续共享的外层 mark」把叶子分组包成容器树。
 *
 * 逐 span 独立包裹会把 `**a `b` c**` 切成 `**a** `b` **c**`,canonical
 * round-trip 据此静默改写用户源码(打开文件即变、保存后写盘也是改后串)。
 * 把共享前缀提到外层后,inlineCode / delete / link 都留在同一个容器内,
 * 分隔符只在整段两端各出现一次。
 *
 * 已知限制:atom 节点(image / math_inline / footnoteRef / hardbreak)在 schema
 * 里 marks 为空,跨 atom 的外层 mark 信息已丢失,这里无法还原。
 */
function buildMarkTree(leaves: MarkedLeaf[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let i = 0
  while (i < leaves.length) {
    const first = leaves[i]
    const mark = first.stack[0]
    if (!mark) {
      out.push(first.leaf)
      i++
      continue
    }
    let end = i + 1
    while (end < leaves.length && sameMark(leaves[end].stack[0], mark)) end++
    const inner = leaves.slice(i, end).map(l => ({ leaf: l.leaf, stack: l.stack.slice(1) }))
    const children = buildMarkTree(inner)
    if (children.length > 0) out.push(...wrapMark(mark, children))
    i = end
  }
  return out
}

/**
 * InlineSpan[] → mdast PhrasingContent[]:每个 span 先降成叶子 + 外层 mark 栈,
 * 再交给 buildMarkTree 合并相邻的同 mark run。
 */
function processSpans(spans: InlineSpan[]): PhrasingContent[] {
  const leaves: MarkedLeaf[] = spans.map(span => {
    const marks: SpanMark = span.kind === 'text' ? span.marks : []
    return {
      leaf: spanToLeaf(span),
      stack: CONTAINER_MARK_ORDER
        .map(name => markFromSpan(name, marks))
        .filter((m): m is ContainerMark => m !== null),
    }
  })
  return buildMarkTree(leaves)
}

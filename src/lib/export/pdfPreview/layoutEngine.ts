// 轻量布局引擎：mdast → BlockIR → 分页 Display List。
//
// 两段式是「实时预览」的关键：
//   1) buildBlocks()：只做一次。解析 mdast、调 shiki / KaTeX / mermaid、生成
//      块级 IR（行内 run 序列，尚未断行）。内容不变就不重跑。
//   2) relayout(opts)：同步、纯计算。按当前页边距 / 字号重新断行 + 分页，
//      产出 PdfPage[]。改边距 / 字号 / 行距 / 页眉页脚都只走这一步。
//
// 坐标约定：所有 DisplayOp 都是 **页面左上角原点、y 向下** 的 pt 坐标。
// PdfWriter 统一做 `pageHeight - y` 翻转，DOM 预览则直接当 CSS px 用（乘缩放）。

import type { Root } from 'mdast'
import { get as emojiGet, has as emojiHas } from 'node-emoji'
import { renderCodeBlockHtml } from '../shikiHtml'
import type { FragmentBuild } from './fragmentBuilder'
import {
  ALERT_COLORS, drainMissingGlyphs, encodeMixed, glyph, layoutGeometry,
  measureMixed, resetMissingGlyphs, segmentGraphemes, tokensOf, type Tokens,
} from './tokens'
import type {
  DisplayOp, FontKey, PdfDestinations, PdfDocument, PdfLayoutOptions, PdfPage, PdfSource,
  RichFragment, LinkOp, TextOp,
} from './types'
import { DEFAULT_PDF_LAYOUT_OPTIONS, PX_TO_PT } from './types'
// ---- IR ----------------------------------------------------------------------

export interface Run {
  text: string
  font: FontKey
  /** 相对传入 base 字号的倍数 */
  scale: number
  /**
   * 左右内边距（pt，单侧）。模拟 CSS inline-block 的 `padding` ——
   * 脚注引用 `.footnote-ref { padding: 0 2px }`。0 / 未设时行为与旧版一致。
   */
  padX?: number
  colorKey?: keyof Tokens
  hex?: string
  hexDark?: string
  bgKey?: keyof Tokens
  strike?: boolean
  /**
   * 自写 HTML 行内标签的底衬样式（kbd / mark / sub / sup / abbr / 自定义标签）。
   * 与 inlineRuns 里合并出的 html 行区域同源，由 htmlInlineDeco() 生成。
   */
  deco?: DecoStyle
  /** 行内富片段（公式 / 图片） */
  fragId?: string
  fragW?: number
  fragH?: number
  /** 外部链接（https:// / mailto: / asset: …）→ PDF /URI 注解 */
  uri?: string
  /** 页内锚点名 → PDF 命名目标跳转 */
  dest?: string
}

/** 自写 HTML 标签的视觉样式（值域与 SCSS / inline style 对齐，颜色由布局时按主题选）。 */
interface DecoStyle {
  /** 背景填充 */
  fill?: string
  /** 描边色 */
  stroke?: string
  /** 描边宽度 pt（>0 才画框） */
  strokeWidth?: number
  radius?: number
  /** 相对所在行的字号缩放（sub/sup = 0.75） */
  scale?: number
  /**
   * 相对基线的纵向偏移 em，向上为负（与 CSS `top` 同号：sup = -0.5、sub = +0.25）。
   * 引擎内部 y 向下，故绘制时按 `baseline + shiftEm * size` 换算。
   */
  shiftEm?: number
}

type FragMode = 'math' | 'mermaid' | 'image' | 'html'

interface Block {
  kind: 'para' | 'heading' | 'code' | 'table' | 'listItem' | 'quote' | 'hr' | 'toc' | 'footnote' | 'fragment' | 'spacer'
  runs?: Run[]
  codeLines?: Run[][]
  level?: number
  /** heading / footnoteDefinition 的锚点名（PDF 命名目标） */
  anchor?: string
  depth?: number
  ordered?: boolean
  ordinal?: number
  checked?: boolean | null
  label?: string
  variant?: string
  fragId?: string
  fragMode?: FragMode
  rows?: Run[][][]
  align?: (string | null)[]
  spacer?: number
}

export interface BlockIR {
  blocks: Block[]
  headings: { level: number; text: string; anchor: string }[]
}

const SANS: FontKey = 'sans'
const BOLD: FontKey = 'bold'

function run(text: string, patch: Partial<Run> = {}): Run {
  return { text, font: SANS, scale: 1, colorKey: 'ink', ...patch }
}

function plainText(nodes: any[]): string {
  const out: string[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'text' || n.type === 'inlineCode') out.push(String(n.value ?? ''))
    else if (Array.isArray(n.children)) out.push(plainText(n.children))
  }
  return out.join('')
}

// ---- 锚点 slug：与 htmlRenderer.ts 同源，保证 HTML / PDF 两条导出路径
//     的目录、脚注跳转指向同一个目标名 ----------------------------------------

/** heading id 用：小写 + 空白替 `-`（对齐 htmlRenderer.slugify） */
function headingSlug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\-_]/gu, '')
    .slice(0, 80)
}

/** 脚注 label 用：大小写敏感、非 [A-Za-z0-9_-] 替 `_`（对齐 htmlRenderer.footnoteSlug） */
function footnoteSlug(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'
}

/** raw HTML → 纯文本（行内 kbd / sub / sup 等只保留文字）。 */
function stripTags(raw: string): string {
  return raw.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

// ---- 自写 HTML 行内标签（kbd / mark / sub / sup / abbr / 自定义标签）--------------
//
// 编辑器 / 导出 HTML 靠 SCSS（_velo-editor kbd {…}）给这些标签上视觉；PDF 是
// Display List，没有 CSS 引擎，只能把「标签语义」翻译成显式的底衬算子。
// 这里复刻 _editor-typography.scss 里已定稿的那几条规则，并允许用户用 inline
// style / class 覆盖颜色 —— 否则自写样式在 PDF 里整块丢失。

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/g
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2]
  return out
}

/** 用户 inline style 里的少量声明（color / background / border-radius / font-size）。 */
function parseStyleDeco(style: string): Partial<DecoStyle> {
  const d: Partial<DecoStyle> = {}
  const pick = (re: RegExp): string | undefined => re.exec(style)?.[1]?.trim()
  const color = pick(/(?:^|;)\s*color\s*:\s*([^;]+)/i)
  if (color) d.stroke = color
  const bg = pick(/(?:^|;)\s*(?:background(?:-color)?)\s*:\s*([^;]+)/i)
  if (bg && !/^transparent$/i.test(bg)) d.fill = bg
  const br = pick(/(?:^|;)\s*border-radius\s*:\s*([\d.]+)(?:px|em|rem)?/i)
  if (br) d.radius = parseFloat(br)
  // px 按导出基准 16px 折算倍数；em/rem 直接当倍数。
  const fsPx = pick(/(?:^|;)\s*font-size\s*:\s*([\d.]+)px/i)
  const fsEm = pick(/(?:^|;)\s*font-size\s*:\s*([\d.]+)(?:em|rem)/i)
  if (fsPx) d.scale = parseFloat(fsPx) / 16
  else if (fsEm) d.scale = parseFloat(fsEm)
  return d
}

/**
 * 单个自写标签 → 底衬样式。默认值对齐 _editor-typography.scss：
 * kbd = 等宽 + 边框 + 加粗下沿；mark = 黄底；sub/sup = 缩小 + 基线偏移；
 * 自定义标签（无规则）退化为「有 inline style 才画」，避免误加装饰。
 */
function decoOf(tag: string, attrs: Record<string, string>, t: Tokens): DecoStyle | undefined {
  const user = parseStyleDeco(attrs.style ?? '')
  switch (tag.toLowerCase()) {
      case 'kbd': {
        return {
          fill: user.fill ?? t.inlineBg,
          stroke: user.stroke ?? '#d0d7de',
          strokeWidth: 1,
          radius: user.radius ?? 4,
          scale: user.scale ?? 0.85,
        }
      }
    case 'mark':
      return { fill: user.fill ?? t.highlight, radius: user.radius ?? 2 }
    case 'sub':
    case 'sup': {
      // 纯缩放 + 基线偏移，没有底衬可画；deco 仅作「已处理」标记，
      // Painter 对无 fill/stroke 的 deco 直接跳过。
      const d: DecoStyle = { scale: user.scale ?? 0.75 }
      if (user.shiftEm !== undefined) d.shiftEm = user.shiftEm
      else d.shiftEm = tag.toLowerCase() === 'sub' ? 0.25 : -0.5
      return d
    }
    default:
      // 未知标签：仅当用户给了可识别的视觉声明（底色 / 边框色 / 字号）才翻译，
      // 否则保持纯文本（与"自写样式没生效"区分开）。
      if (!user.fill && !user.stroke && user.scale === undefined) return undefined
      return {
        fill: user.fill,
        stroke: user.stroke,
        strokeWidth: user.stroke ? 1 : undefined,
        radius: user.radius ?? 3,
        scale: user.scale,
      }
  }
}

/**
 * 行内 HTML 区域 → run 序列（每个标签一个 run，带 deco）。
 *
 * remark 把 `<kbd>Mod</kbd>+<kbd>B</kbd>` 拆成 html/text/html/...，必须先合并成
 * 完整标签再处理，否则孤立开标签会丢内容（与 htmlRenderer.mergeHtmlInlineRunsMdast
 * 同一约束）。这里复用同一份标签栈状态机思路：收齐一对标签就产出。
 */
function htmlInlineRuns(nodes: any[], style: Partial<Run>, t: Tokens): Run[] {
  // 只有真的出现过 html 节点才走标签解析；纯文本段落不要过一遍扫描。
  if (!nodes?.some((n: any) => n.type === 'html')) return []

  const out: Run[] = []
  let buf = ''
  const flushText = () => {
    if (buf) { out.push(run(buf, style)); buf = '' }
  }
  for (const n of nodes ?? []) {
    // 非 html/text 节点终止当前 HTML 区：它自己的 run 由外层 inlineRuns 生成，
    // 这里只负责把连续 html/text 拼回完整标签对。
    if (n.type !== 'html' && n.type !== 'text') { flushText(); continue }
    buf += String(n.value ?? '')
    // 保险：正常一轮必消费至少一个字符；若正则出现空匹配 / lastIndex 未推进
    // 导致 buf 不动，这里兜底退出，绝不在预览主线程里死循环。
    for (let guard = 0; guard < buf.length + 1; guard++) {
      TAG_RE.lastIndex = 0
      const m = TAG_RE.exec(buf)
      if (!m) break
      // 标签对前的裸文本（`<kbd>Mod</kbd>` 的开标签残片 / "按 "）先出栈，
      // 否则 `<span>前</span><kbd>Mod</kbd>` 里开标签残留会污染 buf。
      const head = buf.slice(0, m.index)
      if (head) { out.push(run(head, style)); }
      const tag = m[1]
      const attrs = parseAttrs(m[2])
      const text = stripTags(m[0])
      const deco = decoOf(tag, attrs, t)
      out.push(run(text, { ...style, deco: deco ?? style.deco }))
      buf = buf.slice(m.index + m[0].length)
    }
  }
  flushText()
  return out
}

/** 允许 inlineRuns 覆盖的 run 字段（html 底衬 / 背景色等）。 */
interface BuildCtx { src: PdfSource; fb: FragmentBuild; tokens: Tokens }
function inlineRuns(nodes: any[], style: Partial<Run>, ctx: BuildCtx): Run[] {
  const out: Run[] = []
  // 连续 html / text 节点先合并成完整标签对，再逐段产出（含底衬）；
  // 其余节点保持原 switch 语义。
  for (let i = 0; i < (nodes ?? []).length;) {
    const n = nodes[i]
    if (n?.type === 'html' || n?.type === 'text') {
      let j = i
      while (j < nodes.length && (nodes[j]?.type === 'html' || nodes[j]?.type === 'text')) j++
      const seg = nodes.slice(i, j)
      if (seg.some((s: any) => s?.type === 'html')) {
        for (const r of htmlInlineRuns(seg, style, ctx.tokens)) {
          // 外部传入的 bgKey（highlight）优先于标签自身底色
          out.push(style.bgKey ? run(r.text, { ...r, bgKey: style.bgKey }) : r)
        }
      } else {
        // 纯文本段：直接按 text 产出 run（不能返回空，否则整段文字丢失）
        for (const s of seg) out.push(run(String(s.value ?? ''), style))
      }
      i = j
      continue
    }
    switch (n.type) {
      case 'inlineCode': out.push(run(String(n.value ?? ''), { ...style, font: 'mono', scale: (style.scale ?? 1) * 0.88, bgKey: 'inlineBg' })); i++; continue
      case 'strong': out.push(...inlineRuns(n.children, { ...style, font: 'bold' }, ctx)); i++; continue
      case 'emphasis': out.push(...inlineRuns(n.children, { ...style }, ctx)); i++; continue
      case 'delete': out.push(...inlineRuns(n.children, { ...style, strike: true }, ctx)); i++; continue
      case 'highlight': out.push(...inlineRuns(n.children, { ...style, bgKey: 'highlight' }, ctx)); i++; continue
      case 'link': {
        // 内部锚点（#fragment）→ PDF 命名目标；外部地址 → /URI。
        // slug 与 htmlRenderer 的 walker 同源，HTML / PDF 两条导出指向同一目标。
        let url = String(n.url ?? '')
        try { url = decodeURIComponent(url) } catch { /* 原样 */ }
        let patch: Partial<Run> = { colorKey: 'link' as const }
        if (url.startsWith('#')) {
          const frag = headingSlug(url.slice(1))
          if (frag) patch = { ...patch, dest: `h-${frag}` }
        } else if (url) {
          patch = { ...patch, uri: url }
        }
        out.push(...inlineRuns(n.children, { ...style, ...patch }, ctx))
        i++; continue
      }
      case 'break': out.push(run(' ', style)); i++; continue
      case 'inlineMath': {
        const id = ctx.fb.byNode.get(n as object)
        const fr = id ? ctx.fb.fragments[id] : null
        if (fr) out.push(run('', { ...style, fragId: id, fragW: fr.w, fragH: fr.h }))
        else out.push(run(String(n.value ?? ''), { ...style, font: 'mono' }))
        i++; continue
      }
      case 'image': {
        const id = ctx.fb.byNode.get(n as object)
        const fr = id ? ctx.fb.fragments[id] : null
        if (fr) out.push(run('', { ...style, fragId: id, fragW: fr.w, fragH: fr.h }))
        else out.push(run(`[${String(n.alt ?? 'image')}]`, { ...style, colorKey: 'muted' }))
        i++; continue
      }
      case 'footnoteReference': {
        // 引用端：对齐导出 HTML 的 <sup class="footnote-ref"><a>label</a></sup> ——
        // 只有 label 本身（无方括号），主色 + 0.85em + 加粗 + 上标抬高，
        // 可跳到定义（锚点与导出 HTML 的 #velo-fn-{slug} 同源）。
        const label = String(n.identifier ?? '')
        const slug = footnoteSlug(label)
        out.push(run(label, {
          ...style,
          colorKey: 'primary',
          scale: (style.scale ?? 1) * 0.85,
          font: 'bold',
          dest: `fn-${slug}`,
          // .footnote-ref 是 inline-block + padding:0 2px —— 两侧各留 2px 空隙。
          padX: 2 * PX_TO_PT,
          deco: { shiftEm: -0.5 },
        }))
        i++; continue
      }
      case 'emoji': {
        const sc = String(n.shortcode ?? '')
        out.push(run(sc && emojiHas(sc) ? (emojiGet(sc) ?? `:${sc}:`) : `:${sc}:`, style))
        i++; continue
      }
      default:
        if (Array.isArray(n.children)) out.push(...inlineRuns(n.children, style, ctx))
        i++; continue
    }
  }
  return out
}

/** blockquote / alert / footnote 内部的块 → 一整条 run 序列（嵌套展平）。 */
function flattenRuns(nodes: any[], ctx: BuildCtx, style: Partial<Run> = {}): Run[] {
  const out: Run[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'paragraph') {
      if (out.length) out.push(run(' ', style))
      out.push(...inlineRuns(n.children, style, ctx))
    } else if (Array.isArray(n.children)) {
      out.push(...flattenRuns(n.children, ctx, style))
    }
  }
  return out
}

/** shiki HTML → 带 light / dark 两套颜色的逐行 run。 */
async function shikiLines(value: string, lang: string, src: PdfSource): Promise<Run[][]> {
  const { html } = await renderCodeBlockHtml({
    code: value, lang, lightTheme: src.lightTheme, darkTheme: src.darkTheme,
  })
  if (!html) return value.replace(/\t/g, '    ').split('\n').map(line => [run(line, { font: 'mono', scale: 0.9 })])
  const code = new DOMParser().parseFromString(html, 'text/html').querySelector('code')
  if (!code) return []
  const lines: Run[][] = [[]]
  const push = (text: string, light?: string, dark?: string) => {
    if (!text) return
    const parts = text.replace(/\t/g, '    ').split('\n')
    parts.forEach((part, i) => {
      if (i > 0) lines.push([])
      if (part) lines[lines.length - 1].push(run(part, {
        font: 'mono', scale: 0.9,
        hex: light || undefined,
        hexDark: dark || light || undefined,
      }))
    })
  }
  for (const child of Array.from(code.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) push(child.textContent ?? '')
    else if (child instanceof Element) {
      const st = child.getAttribute('style') ?? ''
      push(child.textContent ?? '',
        /--shiki-light:\s*([^;]+)/.exec(st)?.[1]?.trim(),
        /--shiki-dark:\s*([^;]+)/.exec(st)?.[1]?.trim())
    }
  }
  return lines
}

/** mdast 树 → 块级 IR。只跑一次，与实时版式参数无关。 */
// 标签底衬颜色 / 边框色只依赖版式主题（亮 / 暗），与边距、字号无关，
// 所以 IR 构建时用默认 options 取一次即可 —— relayout 只做几何变换。
export async function buildBlocks(tree: Root, src: PdfSource, fb: FragmentBuild): Promise<BlockIR> {
  const ctx: BuildCtx = { src, fb, tokens: tokensOf({ ...DEFAULT_PDF_LAYOUT_OPTIONS }) }
  const blocks: Block[] = []
  const headings: { level: number; text: string; anchor: string }[] = []

  const walkList = (node: any, depth: number) => {
    let ordinal = node.start ?? 1
    for (const item of node.children ?? []) {
      const first = (item.children ?? [])[0]
      const hasFirstPara = first?.type === 'paragraph'
      blocks.push({
        kind: 'listItem',
        runs: hasFirstPara ? inlineRuns(first.children, {}, ctx) : [],
        depth, ordered: !!node.ordered,
        ordinal: node.ordered ? ordinal++ : undefined,
        checked: item.checked ?? null,
      })
      for (const child of (item.children ?? []).slice(hasFirstPara ? 1 : 0)) {
        if (child.type === 'list') walkList(child, depth + 1)
        else if (child.type === 'blockquote') blocks.push({ kind: 'quote', runs: flattenRuns(child.children, ctx, { colorKey: 'muted' }), depth: depth + 1 })
        else if (child.type === 'paragraph') blocks.push({ kind: 'para', runs: inlineRuns(child.children, {}, ctx), depth: depth + 1 })
        else void walkNode(child)
      }
    }
  }

  const walkNode = async (node: any): Promise<void> => {
    switch (node.type) {
      case 'paragraph': {
        if (node.children?.length === 1 && node.children[0].type === 'text'
          && String(node.children[0].value ?? '').trim() === '[TOC]') {
          blocks.push({ kind: 'toc' }); break
        }
        const kids = node.children ?? []
        if (kids.length === 1 && kids[0].type === 'image') {
          const id = fb.byNode.get(kids[0] as object)
          if (id) { blocks.push({ kind: 'fragment', fragId: id, fragMode: 'image' }); break }
        }
        const runs = inlineRuns(kids, {}, ctx)
        if (runs.length) blocks.push({ kind: 'para', runs })
        break
      }
      case 'heading': {
        const level = Math.min(Math.max(node.depth ?? 1, 1), 6)
        const text = plainText(node.children)
        const anchor = headingSlug(text) ? `h-${headingSlug(text)}` : ''
        headings.push({ level, text, anchor })
        blocks.push({ kind: 'heading', level, runs: inlineRuns(node.children, { font: 'bold' }, ctx), anchor })
        break
      }
      case 'code': {
        const lang = String(node.lang ?? '').toLowerCase()
        if (lang === 'mermaid') {
          const id = fb.byNode.get(node as object)
          if (id) blocks.push({ kind: 'fragment', fragId: id, fragMode: 'mermaid' })
          else blocks.push({ kind: 'para', runs: [run(String(node.value ?? ''), { font: 'mono', scale: 0.86 })] })
        } else {
          blocks.push({ kind: 'code', codeLines: await shikiLines(String(node.value ?? ''), lang, src) })
        }
        break
      }
      case 'math': {
        const id = fb.byNode.get(node as object)
        if (id) blocks.push({ kind: 'fragment', fragId: id, fragMode: 'math' })
        break
      }
      case 'blockquote': blocks.push({ kind: 'quote', runs: flattenRuns(node.children, ctx, { colorKey: 'muted' }) }); break
      case 'alert': {
        const variant = String(node.variant ?? 'note').toLowerCase()
        blocks.push({ kind: 'quote', variant, label: variant.toUpperCase(), runs: flattenRuns(node.children, ctx) })
        break
      }
      case 'list': walkList(node, 0); break
      case 'table': {
        const rows: Run[][][] = (node.children ?? []).map((row: any) =>
          (row.children ?? []).map((cell: any) => inlineRuns(cell.children, {}, ctx)))
        blocks.push({ kind: 'table', rows, align: node.align ?? [] })
        break
      }
      case 'thematicBreak': blocks.push({ kind: 'hr' }); break
      case 'html': {
        const id = fb.byNode.get(node as object)
        if (id) blocks.push({ kind: 'fragment', fragId: id, fragMode: 'html' })
        else {
          const t = stripTags(String(node.value ?? ''))
          if (t.trim()) blocks.push({ kind: 'para', runs: [run(t, { colorKey: 'muted' })] })
        }
        break
      }
      case 'footnoteDefinition': {
        const label = String(node.identifier ?? '')
        // 描述用正文字号（webview 的 .footnote-content 不缩放），
        // 颜色是正文色 0.6 透明 → tokens.footnoteInk 已预混。
        blocks.push({ kind: 'footnote', label, anchor: `fn-${footnoteSlug(label)}`,
          runs: flattenRuns(node.children, ctx, { colorKey: 'footnoteInk' }) })
        break
      }
      case 'definition': case 'yaml': case 'toml': break
      default:
        if (Array.isArray(node.children)) for (const c of node.children) await walkNode(c)
        break
    }
  }

  for (const node of tree.children as any[]) await walkNode(node)
  return { blocks, headings }
}

// ---- 断行 / 分页 --------------------------------------------------------------

interface Piece { run: Run; text: string; w: number; frag: boolean; h: number; padX?: number }
interface Line { pieces: Piece[]; w: number; fragH: number }
function runColor(r: Run, t: Tokens, dark: boolean): string {
  if (r.hex) return dark ? (r.hexDark ?? r.hex) : r.hex
  return t[r.colorKey ?? 'ink'] ?? t.ink
}

/** 自写 HTML 标签的底衬算子（kbd / mark / 自定义标签）。画在文字下层。 */
function decoOp(x: number, baseline: number, w: number, size: number, d: NonNullable<Run['deco']>, shiftEm = 0): DisplayOp {
  const padX = size * 0.35
  return {
    op: 'deco',
    x: x - padX,
    y: baseline + shiftEm * size - size * 0.95,
    w: w + padX * 2,
    h: size * 1.28,
    fill: d.fill ?? null,
    stroke: d.stroke ?? null,
    width: d.strokeWidth ?? 1,
    radius: d.radius ?? 3,
  }
}

interface WrapOpts {
  /**
   * 保留行首空白（代码块用）。正文 / 列表为 false：Markdown 语义下行首空白
   * 本就无意义，折叠掉可以避免前导空格把段落撑出多余行。
   * 代码块为 true：缩进是内容的一部分，必须原样保留。
   */
  pre?: boolean
}

/** 断行：优先按空白分词，超长单词再逐字拆；富片段当原子盒。 */
function wrap(runs: Run[], maxW: number, base: number, opts: WrapOpts = {}): Line[] {
  const lines: Line[] = []
  let cur: Line = { pieces: [], w: 0, fragH: 0 }
  const fresh = (): Line => ({ pieces: [], w: 0, fragH: 0 })
  const flush = () => { if (cur.pieces.length) lines.push(cur); cur = fresh() }

  // 0.5pt 容差：正好填满一行时浮点误差（504.58000000000004 > 504.58）
  // 会把已经排好的前缀单独挤成一行，视觉上出现「Markdown」孤字行。
  const EPS = 0.5
  const pushRaw = (r: Run, text: string, w: number, padX = 0) => {
    if (cur.w + w > maxW + EPS && cur.pieces.length) flush()
    cur.pieces.push({ run: r, text, w, frag: false, h: 0, padX })
    cur.w += w
  }

  for (const r of runs) {
    if (r.fragId) {
      const w = Math.min(r.fragW ?? 0, maxW)
      const h = (r.fragH ?? 0) * (w / Math.max(1, r.fragW ?? 1))
      if (cur.w + w > maxW && cur.pieces.length) flush()
      cur.pieces.push({ run: r, text: '', w, frag: true, h })
      cur.w += w
      cur.fragH = Math.max(cur.fragH, h)
      continue
    }
    const size = base * r.scale * (r.deco?.scale ?? 1)
    const chunks = r.text.match(/\s+|[^\s]+/g) ?? []
    // run 级内边距：整段只加一次（首块携带 2*padX 的宽度与左侧 padX 偏移）。
    const pad = r.padX ?? 0
    let firstChunk = true
    const pushRun = (text: string, w: number) => {
      const head = firstChunk
      firstChunk = false
      pushRaw(r, text, w + (head ? pad * 2 : 0), head ? pad : 0)
    }
    for (const chunk of chunks) {
      const cw = measureMixed(chunk, r.font, size)
      if (/^\s+$/.test(chunk)) {
        // 代码块行首缩进：整段空白按字符裁进行宽后保留（不能整段 push，
        // 否则超出页宽的缩进会把行撑爆）。折行产生的续行 cur.pieces 为空时
        // 同样走这里，但续行的下一个 chunk 一定是非空白 token，不受影响。
        if (opts.pre && !cur.pieces.length) {
          let buf = '', bw = 0
          for (const ch of chunk) {
            const w = glyph(ch, r.font).w / 1000 * size
            if (cur.w + bw + w > maxW + EPS) break
            buf += ch; bw += w
          }
          if (buf) {
            cur.pieces.push({ run: r, text: buf, w: bw, frag: false, h: 0 })
            cur.w += bw
            firstChunk = false
          }
          continue
        }
        if (cur.pieces.length && cur.w + cw <= maxW + EPS) pushRun(chunk, cw)
        else if (cur.pieces.length) flush()
        continue
      }
      // 中文可以逐字断行；若把整句当成「一个词」，一句接近页宽的中文会
      // 被整体挪到下一行，把行首的 "Markdown " 孤零零留在上一行。
      // 拉丁词仍按词换行（不拆单词），超长 URL / 代码则逐字拆。
      const cjk = /[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(chunk)
      if (!cjk && cw <= maxW) {
        if (cur.w + cw > maxW + EPS && cur.pieces.length) flush()
        pushRun(chunk, cw)
        continue
      }
      let buf = '', bw = 0
      for (const seg of segmentGraphemes(chunk)) {
        const w = measureMixed(seg, r.font, size)
        if (cur.w + bw + w > maxW + EPS && buf) { pushRun(buf, bw); buf = ''; bw = 0 }
        buf += seg; bw += w
      }
      if (buf) pushRun(buf, bw)
    }
  }
  if (cur.pieces.length) lines.push(cur)
  return lines
}

interface DrawOpts {
  bg?: string
  /** 覆盖行高（pt）；不传则按字号推 */
  lh?: number
  /** 影响基线位置的名义字号 */
  size?: number
  /** 同一行前置片段（列表 marker），绝对 x */
  prefix?: { pieces: Piece[]; x: number }
  /**
   * 行尾绝对定位的 run（脚注回链 ↩ 右对齐用）。不参与行宽推进，
   * 只按给定 x 画，基线与本行一致。
   */
  tail?: { run: Run; x: number }
  /** 已由调用方 ensure 过整块高度，跳过逐行分页检查 */
  skipEnsure?: boolean
}

class Painter {
  pages: PdfPage[] = []
  cur: PdfPage = { ops: [] }
  y = 0
  /** 命名目标：锚点名 → 页码 + 页内落点 */
  dests: PdfDestinations = {}
  /** 同名目标的重复定义（mdast 里 heading / 脚注 label 重名） */
  private dupTargets = new Set<string>()
  constructor(
    readonly geo: ReturnType<typeof layoutGeometry>,
    readonly t: Tokens,
    readonly opts: PdfLayoutOptions,
    readonly frags: Record<string, RichFragment>,
  ) { this.y = geo.marginTop }

  private bottom(): number { return this.geo.pageHeight - this.geo.marginBottom }

  newPage(): void { this.pages.push(this.cur); this.cur = { ops: [] }; this.y = this.geo.marginTop }

  ensure(h: number): void {
    if (this.y + h > this.bottom() && this.y > this.geo.marginTop) this.newPage()
  }

  /** 注册命名目标；重名只记第一次（PDF 名称必须唯一）。 */
  addDest(name: string, x: number, y: number): void {
    if (!name) return
    if (this.dests[name]) { this.dupTargets.add(name); return }
    // 页索引在 finish() 统一 +1（此刻 cur 还没入 pages）。
    this.dests[name] = { page: this.pages.length + 1, x, y }
  }

  /**
   * 把某个 run 在本页的可见矩形并入 LinkOp。同一 (dest|uri) 连续出现时
   * 合并到同一条注解，避免跨行链接炸成几十条 Annot。
   */
  private addLink(kind: 'dest' | 'uri', key: string, x: number, y: number, w: number, h: number): void {
    const ops = this.cur.ops
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i]
      if (op.op !== 'link') continue
      const same = kind === 'dest' ? (op.dest === key && !op.uri) : (op.uri === key && !op.dest)
      if (!same) break // 只跟「紧邻」的同类合并，跨内容的不并
      op.rects.push({ x, y, w, h })
      return
    }
    const link: LinkOp = kind === 'dest'
      ? { op: 'link', dest: key, rects: [{ x, y, w, h }] }
      : { op: 'link', uri: key, rects: [{ x, y, w, h }] }
    ops.push(link)
  }

  text(x: number, baseline: number, text: string, r: Run, size: number): void {
    const color = runColor(r, this.t, this.opts.dark)
    const startX = x
    let spanUnits = 0
    for (const g of encodeMixed(text, r.font)) {
      const op: TextOp = {
        op: 'text', x, y: baseline, size, color, font: g.font, gids: g.gids,
        ...(g.kerns ? { kerns: g.kerns } : {}),
        text: g.text,
      }
      this.cur.ops.push(op)
      x += g.units / 1000 * size
      spanUnits += g.units
    }
    if ((r.dest || r.uri) && spanUnits > 0) {
      // 热区按整段文字的外接盒估：上探到 0.82em、下探到 0.35em，覆盖上下标。
      const w = spanUnits / 1000 * size
      const top = baseline - size * 1.05
      const h = size * 1.4
      if (r.dest) this.addLink('dest', r.dest, startX, top, w, h)
      else if (r.uri) this.addLink('uri', r.uri, startX, top, w, h)
    }
  }

  drawLine(line: Line, x0: number, base: number, o: DrawOpts = {}): number {
    const size = o.size ?? base
    const h = o.lh ?? Math.max(size * 1.4, line.fragH)
    if (!o.skipEnsure) this.ensure(h)
    const top = this.y
    const baseline = top + size * 0.82 + (h - size) / 2
    if (o.bg) {
      const w = Math.max(0, this.geo.pageWidth - this.geo.marginRight - x0) + 8
      this.cur.ops.push({ op: 'rect', x: x0 - 4, y: top, w, h, fill: o.bg })
    }
    if (o.prefix) {
      let px = o.prefix.x
      for (const p of o.prefix.pieces) {
        if (!p.frag) {
          const pSize = base * p.run.scale * (p.run.deco?.scale ?? 1)
          const shift = p.run.deco?.shiftEm ?? 0
          this.text(px + (p.padX ?? 0), baseline + shift * pSize, p.text, p.run, pSize)
        }
        px += p.w
      }
    }
    // 两遍绘制：先画整行所有片段的底色/底衬（bgKey / deco），再画前景文字/片段，
    // 避免相邻片段的 `x - 1` 扩展背景矩形盖住前一片段末字（如行内代码 `AV / To` 里 V、/ 右缘被遮）。
    let bgX = x0
    for (const p of line.pieces) {
      if (!p.frag) {
        const pSize = base * p.run.scale * (p.run.deco?.scale ?? 1)
        const padX = p.padX ?? 0
        const textW = p.w - padX * 2
        if (p.run.bgKey) {
          this.cur.ops.push({ op: 'rect', x: bgX + padX - 1, y: baseline - pSize * 1.02, w: textW + 2, h: pSize * 1.3, fill: this.t[p.run.bgKey] ?? this.t.inlineBg })
        }
        const shift = p.run.deco?.shiftEm ?? 0
        if (p.run.deco && (p.run.deco.fill || p.run.deco.stroke)) {
          this.cur.ops.push(decoOp(bgX + padX, baseline, textW, pSize, p.run.deco, shift))
        }
      }
      bgX += p.w
    }
    let x = x0
    for (const p of line.pieces) {
      const pSize = base * p.run.scale * (p.run.deco?.scale ?? 1)
      if (p.frag && p.run.fragId) {
        // 行内片段按行盒垂直居中，而不是用 basline * 0.82 硬推 ——
        // 公式的视觉盒含上下标 / 分母，按基线推算会把顶部顶出裁切区。
        this.cur.ops.push({ op: 'fragment', id: p.run.fragId, x, y: top + (h - p.h) / 2, w: p.w, h: p.h })
        x += p.w
        continue
      }
      // run 级内边距：文字从 padX 起画，宽度已含左右两段 pad。
      const padX = p.padX ?? 0
      const textW = p.w - padX * 2
      const shift = p.run.deco?.shiftEm ?? 0
      this.text(x + padX, baseline + shift * pSize, p.text, p.run, pSize)
      if (p.run.strike) {
        this.cur.ops.push({ op: 'line', x1: x + padX, y1: baseline - pSize * 0.3, x2: x + padX + textW, y2: baseline - pSize * 0.3, color: runColor(p.run, this.t, this.opts.dark), width: 0.6 })
      }
      x += p.w
    }
    if (o.tail) {
      const r = o.tail.run
      const tSize = base * r.scale * (r.deco?.scale ?? 1)
      const shift = r.deco?.shiftEm ?? 0
      this.text(o.tail.x, baseline + shift * tSize, r.text, r, tSize)
    }
    this.y = top + h
    return h
  }

  rule(y: number, x1: number, x2: number, color: string, width = 0.6): void {
    this.cur.ops.push({ op: 'line', x1, y1: y, x2, y2: y, color, width })
  }

  /** 页眉 / 页脚 / 页码：分页完成后统一追加，预览与导出都看得到。 */
  finish(): PdfPage[] {
    if (this.cur.ops.length || this.pages.length === 0) this.pages.push(this.cur)
    const total = this.pages.length
    // 目标页号此刻才最终确定：cur 已入 pages，之前记的 page+1 正好等于下标。
    for (const d of Object.values(this.dests)) {
      if (d.page < 1) d.page = 1
      if (d.page > total) d.page = total
    }
    const mid = this.geo.pageWidth / 2
    const put = (ops: DisplayOp[], text: string, x: number, y: number, size: number) => {
      let cx = x
      for (const g of encodeMixed(text, SANS)) {
        ops.push({
          op: 'text', x: cx, y, size, color: this.t.muted, font: g.font, gids: g.gids,
          ...(g.kerns ? { kerns: g.kerns } : {}),
          text: g.text,
        })
        cx += g.units / 1000 * size
      }
    }
    for (let i = 0; i < total; i++) {
      const page = this.pages[i]
      const ops: DisplayOp[] = []
      if (this.opts.showHeader) {
        const y = this.geo.marginTop * 0.5
        if (this.opts.headerText) put(ops, this.opts.headerText, this.geo.marginLeft, y, this.geo.bodySize * 0.72)
        ops.push({ op: 'line', x1: this.geo.marginLeft, y1: y + 6, x2: this.geo.pageWidth - this.geo.marginRight, y2: y + 6, color: this.t.hr, width: 0.5 })
      }
      if (this.opts.showFooter) {
        // 仅页码，不画横线（对齐导出 HTML / webview 版）。
        const y = this.geo.pageHeight - this.geo.marginBottom * 0.5
        const label = `${i + 1} / ${total}`
        const size = this.geo.bodySize * 0.72
        put(ops, label, mid - measureMixed(label, SANS, size) / 2, y, size)
      }
      page.ops.push(...ops)
    }
    return this.pages
  }

  fr(id: string): RichFragment | undefined { return this.frags[id] }
}

// ---- 块级间距（照抄主编辑器 CSS 的 margin） -----------------------------------
//
// 导出 HTML（webview 方案）与主编辑器共用 src/styles/ 下的同一套 partial，
// 所以把这些 margin 值抄过来，TS 版式就能与 webview 逐项对齐。
//
// 两个必须注意的点：
//  1) CSS 的 em 相对**块自身** font-size，不是正文字号 —— 标题的 margin 要乘
//     标题自己的字号，否则 h3 的 1em 会算成正文的 1em。
//  2) _editor-typography.scss 里 h3 / h4 / h5 / h6 **只写了 margin-top**，
//     margin-bottom 落回浏览器 UA 默认值（h3 1em / h4 1.33em / h5 1.67em /
//     h6 2.33em）。webview PDF 实测 h3→段落 baseline 间距正好 = 1em(h3)，
//     就是这个默认值在生效 —— 照抄它，不要「顺手补个 0」。

/** 标题字号（相对正文），对齐 _editor-typography.scss 的 h1..h6。 */
const HEADING_SCALE = [2, 1.6, 1.4, 1.2, 1, 1]

/** 标题 margin [before, after]，单位 em（相对标题自身字号）。 */
const HEADING_SPACE: [number, number][] = [
  [2, 1],       // h1
  [1.5, 0.5],   // h2
  [1, 1],       // h3（after = UA 默认 1em）
  [0.5, 1.33],  // h4（after = UA 默认 1.33em）
  [1.2, 1.67],  // h5（after = UA 默认 1.67em）
  [1.2, 2.33],  // h6（after = UA 默认 2.33em）
]

/**
 * 块的 margin（pt，相对正文 body）。值域见各 partial：
 *   _editor-typography / _editor-lists / _editor-code / _editor-tables /
 *   _editor-toc / _editor-alerts / _editor-image。
 */
function blockSpace(b: Block, body: number): { before: number; after: number } {
  switch (b.kind) {
    case 'heading': {
      const i = Math.min(Math.max(b.level ?? 1, 1), 6) - 1
      const em = body * (HEADING_SCALE[i] ?? 1)
      return { before: HEADING_SPACE[i][0] * em, after: HEADING_SPACE[i][1] * em }
    }
    case 'para': return { before: body * 0.5, after: body * 0.5 }
    // blockquote margin:0；带 variant 的 quote 是 alert(.velo-alert) margin:1em 0。
    case 'quote': return b.variant ? { before: body, after: body } : { before: 0, after: 0 }
    // pre margin:1em 0（em 相对 pre，而 pre 继承正文字号）
    case 'code': return { before: body, after: body }
    case 'hr': return { before: body, after: body }
    // .tableWrapper margin:1.8em 0 1em
    case 'table': return { before: body * 1.8, after: body }
    // .velo-toc margin:.25em 0
    case 'toc': return { before: body * 0.25, after: body * 0.25 }
    // 富片段按外层容器取 margin：图片 .velo-image-inline .25em/.15em；
    // mermaid .mermaid-node 与 katex-display 都是 1em 0；HTML 块按正文段落 .5em。
    case 'fragment': {
      const k = b.fragMode
      if (k === 'mermaid' || k === 'math') return { before: body, after: body }
      if (k === 'html') return { before: body * 0.5, after: body * 0.5 }
      return { before: body * 0.25, after: body * 0.15 }
    }
    // li margin:.25em 0；列表首尾由 relayout 换成 ul/ol 的 .5em
    case 'listItem': return { before: body * 0.25, after: body * 0.25 }
    // .footnote-definition margin:1em 0 .5em
    case 'footnote': return { before: body, after: body * 0.5 }
    case 'spacer': return { before: 0, after: 0 }
    default: return { before: 0, after: 0 }
  }
}

/**
 * 列表 marker 文本，对齐 _editor-lists.scss 的 list-style-type：
 *   ul: disc → circle → square（第 3 层起恒定 square）
 *   ol: decimal → lower-alpha → lower-roman
 */
function markerText(ordered: boolean, ordinal: number, depth: number): string {
  if (!ordered) return depth === 0 ? '•' : depth === 1 ? '◦' : '▪'
  if (depth === 0) return `${ordinal}.`
  if (depth === 1) return `${String.fromCharCode(97 + ((ordinal - 1) % 26))}.`
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ]
  let out = ''
  let v = ordinal
  for (const [n, sym] of table) while (v >= n) { out += sym; v -= n }
  return `${out}.`
}

/** 同步重排：改任意 PdfLayoutOptions 都只走这里，不重新解析 mdast / 不重渲染富片段。 */
export function relayout(ir: BlockIR, fragments: Record<string, RichFragment>, opts: PdfLayoutOptions): PdfDocument {
  resetMissingGlyphs()
  const geo = layoutGeometry(opts)
  const t = tokensOf(opts)
  const body = geo.bodySize
  const contentW = geo.pageWidth - geo.marginLeft - geo.marginRight
  const p = new Painter(geo, t, opts, fragments)
  const x0 = geo.marginLeft
  const lineH = geo.lineHeight

  // 相邻块的 margin 按 CSS 规则 collapse（取大者），而不是相加。
  let prevAfter = 0
  for (let bi = 0; bi < ir.blocks.length; bi++) {
    const b = ir.blocks[bi]
    const sp = blockSpace(b, body)
    // 连续同深度列表项：首项 / 末项吃 ul/ol 的 .5em，中间仍是 li 的 .25em。
    if (b.kind === 'listItem') {
      const d = b.depth ?? 0
      const prev = ir.blocks[bi - 1]
      const next = ir.blocks[bi + 1]
      if (prev?.kind !== 'listItem' || (prev.depth ?? 0) !== d) sp.before = body * 0.5
      if (next?.kind !== 'listItem' || (next.depth ?? 0) !== d) sp.after = body * 0.5
    }
    const gap = Math.max(prevAfter, sp.before)
    // 间距计入分页判定，避免标题被留在页底、正文去了下一页。
    p.ensure(gap + lineH)
    p.y += gap
    prevAfter = sp.after

    switch (b.kind) {
      case 'spacer': p.ensure(b.spacer ?? lineH * 0.5); p.y += b.spacer ?? lineH * 0.5; break

      case 'heading': {
        const lvl = b.level ?? 1
        // 字号 / 行高都与主编辑器一致（line-height 继承 .velo-editor 的 1.75）
        const size = body * (HEADING_SCALE[lvl - 1] ?? 1)
        const lh = size * 1.75
        p.ensure(lh)
        // 目录 / 正文锚点都指向标题行顶（PDF 会滚到该行）
        if (b.anchor) p.addDest(b.anchor, x0, p.y)
        for (const l of wrap(b.runs ?? [], contentW, size)) {
          p.drawLine(l, lvl === 1 ? x0 + (contentW - l.w) / 2 : x0, size, { lh })
        }
        if (lvl === 2) p.rule(p.y + 3, x0, x0 + contentW, t.h2Border)
        break
      }

      case 'para': {
        for (const l of wrap(b.runs ?? [], contentW, body)) p.drawLine(l, x0, body, { lh: lineH })
        break
      }

      case 'quote': {
        const indent = 14, width = contentW - indent - 10
        const color = b.variant ? (ALERT_COLORS[b.variant] ?? t.quoteBorder) : t.quoteBorder
        // webview `.velo-alert` / `blockquote` 都是 4px 左竖条 + 无底色
        // （亮色模式），这里不铺 bg，只画竖条。
        const rows: Line[] = []
        if (b.label) rows.push(...wrap([run(b.label, { font: 'bold', scale: 0.85, hex: color, hexDark: color })], width, body))
        rows.push(...wrap(b.runs ?? [], width, body))
        // blockquote padding:.25em 1em，内部段落 margin:.5em 0（被 padding 挡住
        // 不穿透）→ 顶 / 底各 .75em。alert(.velo-alert) padding:.15em 1em。
        const padV = body * (b.variant ? 0.15 : 0.75)
        const rowsH = rows.reduce((s, l) => s + Math.max(lineH, l.fragH), 0)
        p.ensure(padV * 2 + rowsH)
        const top = p.y
        p.y += padV
        for (const l of rows) {
          const h = Math.max(lineH, l.fragH)
          p.drawLine(l, x0 + indent, body, { lh: h })
        }
        p.y += padV
        // 竖条贯穿 padding，贴合 border-left 画在块盒上的效果
        p.cur.ops.push({ op: 'line', x1: x0 + 2, y1: top, x2: x0 + 2, y2: p.y, color, width: 3 })
        break
      }

      case 'listItem': {
        const depth = b.depth ?? 0
        // ul / ol { padding-left:2em }，嵌套每层再 +2em
        const base = 2 * body * (depth + 1)
        const isTask = b.checked != null
        const ordered = b.ordered === true
        // task li 另有 padding-left:1.8em（checkbox 占位）
        const textX = x0 + base + (isTask ? 1.8 * body : 0)
        // li::marker 走主色（_editor-lists.scss:20-23），不再是灰的
        const bullet = markerText(ordered, b.ordinal ?? 1, depth)
        const marker = run(bullet, { colorKey: 'primary' })
        // 无序 marker 用矢量图形而不是 '•' 字形：字形墨迹只有 0.22em（偏小），
        // 且 Chromium 的 marker 尺寸随字体度量漂移（实测 0.30–0.39em）。
        // 直径固定 0.32em —— 参考截图实测 11px ÷ em 34.6px ≈ 0.318em；
        // 右缘到文字 0.55em（同图实测 0.577em）。有序 marker 仍走文字层（可搜索）。
        const dot = 0.32 * body
        const markerGap = 0.55 * body
        const vectorMarker = !isTask && !ordered
        const markerW = vectorMarker
          ? dot + markerGap
          : measureMixed(bullet, marker.font, body) + 8
        // 勾选态：整段 muted + 删除线（[data-checked="true"] .task-content）
        const done = isTask && !!b.checked
        const runs: Run[] = (b.runs ?? []).map(r => (done
          ? {
              ...r,
              strike: true,
              colorKey: (r.colorKey === 'ink' || !r.colorKey ? 'muted' : r.colorKey) as keyof Tokens,
            }
          : r))
        const lines = wrap(runs, contentW - (textX - x0) - (isTask ? 0 : markerW), body)
        const use = lines.length ? lines : [{ pieces: [], w: 0, fragH: 0 } as Line]
        if (isTask) {
          // checkbox 1em × 1em，与首行垂直居中；勾选填主色 + 白对勾
          const cb = body
          const h0 = Math.max(lineH, use[0].fragH)
          const cbX = x0 + base
          const cbY = p.y + (h0 - cb) / 2
          p.ensure(h0)
          if (b.checked) {
            p.cur.ops.push({ op: 'rect', x: cbX, y: cbY, w: cb, h: cb, fill: t.primary })
            const lw = Math.max(1, cb * 0.14)
            const x1 = cbX + cb * 0.24, y1 = cbY + cb * 0.52
            const x2 = cbX + cb * 0.42, y2 = cbY + cb * 0.72
            const x3 = cbX + cb * 0.78, y3 = cbY + cb * 0.3
            p.cur.ops.push({ op: 'line', x1, y1, x2, y2, color: '#ffffff', width: lw })
            p.cur.ops.push({ op: 'line', x1: x2, y1: y2, x2: x3, y2: y3, color: '#ffffff', width: lw })
          } else {
            // 白底 + #aaa 边框（.task-checkbox background:#fff / border:1px solid #aaa）
            p.cur.ops.push({ op: 'rect', x: cbX, y: cbY, w: cb, h: cb, fill: '#ffffff' })
            p.cur.ops.push({ op: 'strokeRect', x: cbX, y: cbY, w: cb, h: cb, color: '#aaaaaa', width: 1 })
          }
        }
        use.forEach((l, i) => {
          const h = Math.max(lineH, l.fragH)
          if (isTask) { p.drawLine(l, textX, body, { lh: h }); return }
          // 有序列表：marker 是文字（'1.' / 'a.' / 'i.'），保持可选中
          if (i === 0 && !vectorMarker) {
            const prefix = { pieces: [{ run: marker, text: bullet, w: markerW, frag: false, h: 0 } as Piece], x: textX - markerW }
            p.drawLine(l, textX, body, { lh: h, prefix })
            return
          }
          const top = p.y
          p.drawLine(l, textX, body, { lh: h })
          if (i > 0) return
          // 圆点圆心对齐首行文字的 x-height 中线（主编辑器 li::marker 的视觉位置）
          const baseline = top + body * 0.82 + (h - body) / 2
          const x = textX - markerGap - dot
          const y = baseline - 0.25 * body - dot / 2
          if (depth === 0) {
            // disc：实心正圆
            p.cur.ops.push({ op: 'deco', x, y, w: dot, h: dot, fill: t.primary, radius: dot / 2 })
          } else if (depth === 1) {
            // circle：空心圆（描边居中，外径 ≈ dot + width ≈ 0.375em）
            p.cur.ops.push({ op: 'deco', x, y, w: dot, h: dot, stroke: t.primary, width: 0.055 * body, radius: dot / 2 })
          } else {
            // square：实心方块
            p.cur.ops.push({ op: 'rect', x, y, w: dot, h: dot, fill: t.primary })
          }
        })
        break
      }

      case 'code': {
        // 对齐 _editor-code.scss：pre { margin:1em 0; padding:.75em 1em }
        // （margin 由循环的 blockSpace 给）；行距 = pre 的 1.6em 绝对值继承给 code；
        // pre code { font-size:.9em }。
        // 注意：**不画** webview 那个空的 header 占位条（pre::before / 2.75em 预留）——
        // 需求明确不要它，所以 padding-top 保持 .75em。
        const codeSize = body * 0.9
        const lh = body * 1.6
        const padX = body
        const padTop = body * 0.75
        const padBottom = body * 0.75
        const wrappedAll = (b.codeLines ?? []).map(line => {
          const w = wrap(line.length ? line : [run('', { font: 'mono', scale: 0.9 })], contentW - padX * 2, body, { pre: true })
          return w.length ? w : [{ pieces: [], w: 0, fragH: 0 } as Line]
        })
        if (!wrappedAll.length) wrappedAll.push([{ pieces: [], w: 0, fragH: 0 } as Line])
        const boxH = padTop + wrappedAll.reduce((s, ls) => s + ls.length * lh, 0) + padBottom
        p.ensure(boxH)
        const top = p.y
        // pre 整块底色（含 padding），避免逐行画导致顶 / 底出现无底色的缝
        p.cur.ops.push({ op: 'rect', x: x0, y: top, w: contentW, h: boxH, fill: t.codeBg })
        p.y = top + padTop
        for (const ls of wrappedAll) {
          for (const one of ls) {
            // drawLine 内部会推进 this.y（= top + lh），不要重复加
            p.drawLine(one, x0 + padX, body, { lh, size: codeSize, skipEnsure: true })
          }
        }
        p.y = top + boxH
        break
      }

      case 'table': {
        const raw = b.rows ?? []
        if (!raw.length) break
        // 表头对齐 webview `th`（font-weight:600 + 灰字）：只覆盖默认 ink 的
        // run，链接 / 代码等自带颜色的 run 保持原样。
        const rows = raw.map((row, ri) => ri === 0
          ? row.map(cell => cell.map(r => ({
              ...r,
              font: 'bold' as FontKey,
              colorKey: (r.colorKey === 'ink' ? 'muted' : r.colorKey) as keyof Tokens,
            })))
          : row)
        const cols = Math.max(...rows.map(r => r.length))
        const cellBody = body * 0.92
        const widths = new Array<number>(cols).fill(0)
        for (const row of rows) for (let c = 0; c < cols; c++) {
          widths[c] = Math.max(widths[c], (row[c] ?? []).reduce((s, r) => s + measureMixed(r.text, r.font, cellBody * r.scale) + (r.fragW ?? 0), 0) + 10)
        }
        const total = widths.reduce((a, b2) => a + b2, 0) || 1
        const colW = widths.map(w => Math.max(36, w / total * contentW))
        const k = contentW / colW.reduce((a, b2) => a + b2, 0)
        const cw = colW.map(w => w * k)
        for (let ri = 0; ri < rows.length; ri++) {
          const cellLines = Array.from({ length: cols }, (_, ci) => wrap(rows[ri][ci] ?? [], cw[ci] - 8, cellBody))
          const rowH = Math.max(...cellLines.map(ls => Math.max(1, ls.length) * lineH * 0.92)) + 6
          p.ensure(rowH)
          const top = p.y
          if (ri === 0) p.cur.ops.push({ op: 'rect', x: x0, y: top, w: contentW, h: rowH, fill: t.codeBg })
          p.rule(top, x0, x0 + contentW, t.tableBorder, 0.5)
          let cx = x0
          for (let ci = 0; ci < cols; ci++) {
            p.y = top + 3
            for (const l of cellLines[ci]) p.drawLine(l, cx + 4, cellBody, { lh: lineH * 0.92, skipEnsure: true })
            cx += cw[ci]
          }
          p.y = top + rowH
          p.rule(p.y, x0, x0 + contentW, t.tableBorder, 0.5)
          let gx = x0
          for (const w of cw) {
            p.cur.ops.push({ op: 'line', x1: gx, y1: top, x2: gx, y2: p.y, color: t.tableBorder, width: 0.4 })
            gx += w
          }
          p.cur.ops.push({ op: 'line', x1: x0 + contentW, y1: top, x2: x0 + contentW, y2: p.y, color: t.tableBorder, width: 0.4 })
        }
        break
      }

      case 'hr': {
        // hr margin:1em 0（循环已给）；border-top:2px solid #ddd
        p.ensure(2)
        p.rule(p.y, x0, x0 + contentW, t.hr, 2)
        p.y += 2
        break
      }

      case 'toc': {
        // 结构对齐 _editor-toc.scss 的 .velo-toc 容器：整块浅底 + 左侧主色竖条
        // （border-left .25em）+ 项缩进 (level-1)*1.2em + 链接字号 .9em / #666。
        // 编辑器 TocDecoration 与导出 HTML 的 renderTocHtml 都**没有**「目录」
        // 标题，ts 之前多画的标题是独有差异，这里去掉。
        const padV = body * 0.5
        const padH = body
        const barW = Math.max(2, body * 0.25 * 0.75)
        const rows: { lines: Line[]; dest?: string; indent: number }[] = []
        for (const h of ir.headings) {
          // 目录项可点击跳到对应标题。h.anchor 已是 'h-xxx'（heading 分支注册
          // addDest 用的同一个值），不要再拼一次 'h-' —— 否则 dest 变成
          // 'h-h-xxx' 匹配不上 destinations，注解会被丢弃。
          const anchor = h.anchor || undefined
          const item = run(h.text, { scale: 0.9, colorKey: 'muted', dest: anchor })
          const indent = padH + (h.level - 1) * 1.2 * body
          const lines = wrap([item], contentW - indent, body)
          rows.push({
            lines: lines.length ? lines : [{ pieces: [], w: 0, fragH: 0 } as Line],
            dest: anchor,
            indent,
          })
        }
        // 空态对齐 webview 的 .velo-toc-empty（斜体灰字），避免渲染出一个空盒子。
        if (!rows.length) {
          const lines = wrap([run('No headings in this document', { scale: 0.85, colorKey: 'muted' })], contentW - padH, body)
          rows.push({ lines: lines.length ? lines : [{ pieces: [], w: 0, fragH: 0 } as Line], indent: padH })
        }
        const rowH = (l: Line) => Math.max(lineH, l.fragH)
        const total = padV * 2 + rows.reduce((s, r) => s + r.lines.reduce((a, l) => a + rowH(l), 0), 0)
        p.ensure(total)
        const top = p.y
        p.cur.ops.push({ op: 'rect', x: x0, y: top, w: contentW, h: total, fill: t.tocBg })
        p.cur.ops.push({ op: 'line', x1: x0, y1: top, x2: x0, y2: top + total, color: t.tocBorder, width: barW })
        p.y = top + padV
        for (const r of rows) {
          for (const l of r.lines) {
            const t2 = p.y
            if (r.dest) p.addDest(r.dest, x0 + r.indent, t2)
            p.drawLine(l, x0 + r.indent, body, { lh: rowH(l), skipEnsure: true })
          }
        }
        p.y = top + total
        break
      }

      case 'footnote': {
        // 对齐导出 HTML 的 .footnote-definition（flex + align-items:baseline）：
        //   <div class="footnote-label">label</div>   ← 与文中引用同款：主色 / 加粗 / 正文字号
        //   <div class="footnote-content">描述</div>   ← 正文色 opacity 0.6
        //   <a class="footnote-backref">↩</a>          ← 主色 opacity 0.6，贴右缘、首行基线
        // label 与内容之间、内容与回链之间各 0.4em；整块从内容左缘起，无缩进。
        const label = b.label ?? ''
        const labelW = measureMixed(label, BOLD, body)
        const gap = body * 0.4
        const backRun = run('↩', { font: 'bold', colorKey: 'footnoteBack', dest: `fnref-${footnoteSlug(label)}` })
        const backW = Math.max(measureMixed('↩', BOLD, body), body * 0.6)
        const textX = x0 + labelW + gap
        const maxW = Math.max(body, contentW - labelW - gap * 2 - backW)
        const wrapped = wrap(b.runs ?? [], maxW, body)
        const lines = wrapped.length ? wrapped : [{ pieces: [], w: 0, fragH: 0 }]
        // 整块 ensure：脚注定义不被分页从中间劈开（webview 侧是连续的一块，
        // 之前逐行 drawLine 会把 4 条脚注拆到第 5、6 页，看起来像丢了一条）。
        const total = lines.reduce((s, l) => s + Math.max(lineH, l.fragH), 0)
        // .footnote-definition padding:0.8em 0 0（margin 由循环的 blockSpace 给）
        const padTop = body * 0.8
        p.ensure(padTop + total)
        p.y += padTop
        // 回链 ↩ 指向的 ref 锚点：真实引用在正文里，定义处先兜一个退路，
        // 正文出现 footnoteReference 时会被更精确的位置覆盖。
        const refAnchor = b.anchor ? `fnref-${footnoteSlug(label)}` : undefined
        if (refAnchor) p.addDest(refAnchor, x0, p.y)
        lines.forEach((l, i) => {
          const top = p.y
          const h = Math.max(lineH, l.fragH)
          if (i === 0) {
            if (b.anchor) p.addDest(b.anchor, x0, top)
            p.drawLine(l, textX, body, {
              lh: h,
              skipEnsure: true,
              // label 走 prefix：不占行宽、与描述同基线（webview 的 flex 首项）。
              // 颜色 / 字重与文中引用 .footnote-ref 保持一致（主色加粗），不用黑色。
              prefix: { pieces: [{ run: run(label, { colorKey: 'primary', font: 'bold' }), text: label, w: labelW, frag: false, h: 0 }], x: x0 },
              tail: { run: backRun, x: x0 + contentW - backW },
            })
          } else {
            p.drawLine(l, textX, body, { lh: h, skipEnsure: true })
          }
        })
        break
      }

      case 'fragment': {
        const fr = b.fragId ? p.fr(b.fragId) : undefined
        if (!fr) break
        const scale = Math.min(1, contentW / Math.max(1, fr.w))
        const w = fr.w * scale
        const h = fr.h * scale
        p.ensure(Math.min(h, geo.pageHeight - geo.marginTop - geo.marginBottom))
        // 图片 / 公式 / mermaid 在版心内水平居中：编辑器里 mermaid 是
        // .mermaid-svg-area 的 flex 居中（_mermaid.scss:58-67），图片走
        // .velo-image-inline 的居中 wrapper，公式是 .katex-display 居中。
        const left = (b.fragMode === 'image' || b.fragMode === 'math' || b.fragMode === 'mermaid')
          ? x0 + (contentW - w) / 2
          : x0
        p.cur.ops.push({ op: 'fragment', id: fr.id, x: left, y: p.y, w, h })
        p.y += h
        break
      }
      default: break
    }
  }

  return {
    pages: p.finish(), fragments, destinations: p.dests, warnings: [], missingGlyphs: drainMissingGlyphs(),
    pageWidth: geo.pageWidth, pageHeight: geo.pageHeight, options: opts,
  }
}

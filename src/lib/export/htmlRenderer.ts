// Markdown → 自包含 HTML 文档。
//
// 复用 editor/markdownIO.ts 的同一份 unified pipeline(parse + 7 个 remark 插件),
// 保证导出 HTML 跟编辑器内看到的语义一致(GFM / 数学 / 警告框 / 高亮 / 空行
// 保留 / 链接 URL 空格 encode)。parse 出 mdast 后不走 PM doc(避免重复桥接),
// 也不走 remarkStringify(我们要 HTML 不是 markdown)—— 自写一个轻量 walker
// 把 mdast 树转成 HTML string,节点类型逐个 dispatch 到对应 helper:
//
//   - text → escapeHtml
//   - heading → h1..h6
//   - code (lang='mermaid') → mermaidHtml.renderMermaidSvg
//   - code (其他) → shikiHtml.renderCodeBlockHtml
//   - math (block / inline) → katexHtml.renderKatexHtml
//   - html (block / inline) → sanitizeHtml.sanitizeHtml
//   - image → <img>,src 走 convertFileSrc(asset:// 协议)
//   - link → <a href>
//   - inline marks(strong/emphasis/strike/highlight/link) → 嵌套 <em>/<strong>/...
//   - list / listItem / blockquote / thematicBreak / table → 对应 HTML
//   - alert → <div class="velo-alert velo-alert-{variant}">(对齐 editor schema toDOM)
//   - paragraph → <p>
//
// 整体文档包成 <!DOCTYPE html><html><head><style>...</style></head><body
// class="velo-editor {dark?}">...content...</body></html>。
//
// 关键设计:
// 1) **不走 PM doc**:markdown 源直接 parse 成 mdast → HTML 字符串,省去
//    pm doc → mdast 二次桥接,代码量更少,语义由 remark 一手决定。
// 2) **降级策略**:mermaid / katex 失败的块不会抛 —— 降级为源码 <pre> 显示
//    + 收进 warnings 数组,导出 HTML 完整无截断。
// 3) **dual themes → 单 theme + 自适应**:
//    - token 仍写 --shiki-light / --shiki-dark 双 hex(同编辑器)
//    - dark 命中靠 exportStyles.scss 的 @media (prefers-color-scheme: dark)
//    - 浏览器 / 打印机的系统暗色会接管,跟 GitHub README 同款
// 4) **image src 走 asset:// 协议**:convertFileSrc 拿到 asset:// URL,导出
//    HTML 在 Tauri webview 内打开能正常显示;若用户拿导出 HTML 到外部浏览器
//    看,asset:// 不会解析(已知限制,见 DECISIONS ADR-20251231-...)

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Root, RootContent, PhrasingContent, Table } from 'mdast'

import { remarkPreserveEmptyLine } from '@/components/ProseMirrorEditor/plugins/preserveEmptyLine'
import { remarkAlert } from '@/components/ProseMirrorEditor/plugins/remarkAlert'
import { remarkEncodeLinkUrls } from '@/components/ProseMirrorEditor/plugins/remarkEncodeLinkUrls'
import { remarkHighlight } from '@/components/ProseMirrorEditor/plugins/remarkHighlight'
import {
  ensureLanguage,
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
} from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import { extractLangsFromDoc } from '@/components/ProseMirrorEditor/editor/markdownIO'
import { resolveImageAssetAbsPath } from '@/utils/imagePath'

import { renderKatexHtml } from './katexHtml'
import { renderMermaidSvg, mermaidErrorHtml } from './mermaidHtml'
import { renderCodeBlockHtml, codeBlockFallbackHtml } from './shikiHtml'
import { sanitizeHtml } from './sanitizeHtml'

// ========== 入口 ==========

export interface ExportOptions {
  /** markdown 源文本。 */
  content: string
  /** 仅用于导出 HTML 的 <title> 标签。 */
  fileName: string
  /** 编辑器当前 darkMode —— 决定导出 HTML 的初始暗色(可被浏览器系统暗色覆盖)。 */
  darkMode: boolean
  /** 编辑器的 primaryColor(导出 HTML 用,跟编辑器主题色一致)。 */
  primaryColor: string
  /** 编辑器的 fontFamily。 */
  fontFamily: string
  /** 编辑器的 fontSize(导出 HTML 用 px string)。 */
  fontSize: string
  /** 当前文件路径,用于解析相对图片路径;untitled 时为 null。 */
  currentFilePath: string | null
  /** 编辑器用户选的 light 主题;settings.codeLightTheme 兜底。 */
  lightTheme: string
  /** 编辑器用户选的 dark 主题;settings.codeDarkTheme 兜底。 */
  darkTheme: string
}

export interface ExportResult {
  /** 完整 HTML 文档字符串(含 <!DOCTYPE html><head><style>...</style>...</head><body>)。 */
  html: string
  /** 导出过程中产生的警告(失败的 mermaid 块 / 失败的代码块等),用于调试 / 反馈用户。 */
  warnings: string[]
}

// ========== HTML 转义 ==========

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// ========== 主入口 ==========

export async function buildExportHtml(opts: ExportOptions): Promise<ExportResult> {
  const warnings: string[] = []
  const { content, fileName, darkMode, primaryColor, fontFamily, fontSize, currentFilePath, lightTheme, darkTheme } = opts

  // 1) markdown → mdast(复用 editor/markdownIO.ts 的同一份 pipeline)
  const processor = unified()
    .use(remarkParse)
    .use(remarkPreserveEmptyLine)
    .use(remarkEncodeLinkUrls)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkAlert)
    .use(remarkHighlight)
  // 必须走 runSync —— remarkAlert / remarkHighlight / remarkEncodeLinkUrls 是
  // transformer(返回 `tree => {...}`),在 run 阶段才执行,parse 只跑 parser。
  // 只 parse 不 run 会导致 alert 节点不被改写(仍是 blockquote)、`==高亮==`
  // 不生效等。对齐 editor/markdownIO.ts:fromMarkdown 的 processor.runSync(parse)。
  // (preserveEmptyLine 是 parser 拦截,parse 期已生效;它注入的 <br /> 空段占位
  // 由下方 walker 的 isEmptyBrPlaceholder 兜成 '',导出 HTML 不保留空行占位。)
  const tree = processor.runSync(processor.parse(content) as Root) as Root

  // 2) 预装 doc 用到的 lang(getTokensSync miss 会触发 ensureLanguage,
  //    但我们想 await 完再走,避免首帧无高亮)
  const usedLangs = extractLangsFromDoc(content).filter((l: string) => l !== 'mermaid')
  // 同步预装只对 list 中存在的 lang 起效;shiki 内部去重,重复 call 安全
  await Promise.all(usedLangs.map((l: string) => ensureLanguage(l).catch(() => {})))

  // 3) mdast → HTML
  const bodyHtml = await mdastToHtml(tree.children, {
    currentFilePath,
    lightTheme,
    darkTheme,
    warnings,
  })

  // 4) 组装完整 HTML 文档
  const bodyClasses = ['velo-editor']
  if (darkMode) bodyClasses.push('dark')

  // editor stylesheet 通过 ?inline 拿到编译后 CSS 字符串(同 _editor-base.scss 等所有 partials)
  // 走 Vite ?inline 静态 import 编译时 inline 进 bundle,运行时是字符串变量
  const editorCss = (await import('./exportStyles.scss?inline')).default
  // KaTeX CSS 单独 inline —— editor 在 EditorInner.vue:45 走 import 'katex/dist/katex.min.css',
  // 那个 import 是 side-effect,不会出现在我们的 bundle 里;导出场景走 ?inline 拿字符串
  const katexCss = (await import('katex/dist/katex.min.css?inline')).default

  const title = fileName || 'Velo Export'
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
:root {
  --md-primary-color: ${escapeHtml(primaryColor)};
  --md-font-family: ${escapeHtml(fontFamily)};
  --md-font-size: ${escapeHtml(fontSize)};
}
${editorCss}
${katexCss}
/* 导出 HTML 自适应:浏览器 / 打印机的系统暗色会翻面,不需要 <html class="dark"> */
@media (prefers-color-scheme: dark) {
  .velo-editor {
    background: #1a1a1a;
    color: #e5e5e5;
  }
  .velo-editor pre,
  .velo-editor pre span {
    background-color: var(--shiki-dark-bg, #0d1117);
    border-color: var(--shiki-dark-border, #30363d);
    color: var(--shiki-dark, #c9d1d9);
  }
  .velo-editor code {
    background: rgba(255, 255, 255, 0.08);
    color: #ff7b72;
  }
  .velo-editor blockquote { color: #aaa; }
  .velo-editor h1, .velo-editor h2, .velo-editor h3, .velo-editor h4 {
    color: var(--md-primary-color, #6aa3e0);
  }
  .velo-editor th, .velo-editor td { border-color: #30363d; }
  .velo-editor hr { border-top-color: #30363d; }
  .velo-editor kbd {
    color: #c9d1d9;
    background: #161b22;
    border-color: #30363d;
  }
  .velo-editor mark { background: #664d03; }
}
@media print {
  .velo-editor { background: white; color: #1a1a1a; }
  .velo-editor pre, .velo-editor pre span {
    background-color: var(--shiki-light-bg, #f6f8fa) !important;
    border-color: var(--shiki-light-border, #e1e4e8) !important;
    color: var(--shiki-light, #24292e) !important;
  }
  .velo-editor a { color: #576b95; }
}
</style>
</head>
<body class="${bodyClasses.join(' ')}">
${bodyHtml}
</body>
</html>
`
  return { html, warnings }
}

// ========== mdast → HTML walker ==========

interface WalkContext {
  currentFilePath: string | null
  lightTheme: string
  darkTheme: string
  warnings: string[]
}

async function mdastToHtml(nodes: RootContent[], ctx: WalkContext): Promise<string> {
  const out: string[] = []
  for (const node of nodes) {
    out.push(await mdastNodeToHtml(node, ctx))
  }
  return out.join('')
}

async function mdastNodeToHtml(node: RootContent | any, ctx: WalkContext): Promise<string> {
  switch (node.type) {
    case 'paragraph': {
      const children = await mdastInlineToHtml(node.children as PhrasingContent[], ctx)
      // preserveEmptyLine 注入的 <br /> 占位代表"1 个空段" —— 不渲染空 <p>
      if (isEmptyBrPlaceholder(node) || !children.trim()) return ''
      return `<p>${children}</p>`
    }
    case 'heading': {
      const level = Math.min(Math.max(node.depth, 1), 6)
      const id = slugify(textOfChildren(node.children))
      const children = await mdastInlineToHtml(node.children as PhrasingContent[], ctx)
      return `<h${level}${id ? ` id="${escapeHtml(id)}"` : ''}>${children}</h${level}>`
    }
    case 'blockquote': {
      const inner = await mdastToHtml(node.children as RootContent[], ctx)
      return `<blockquote>${inner}</blockquote>`
    }
    case 'alert': {
      // remarkAlert 把带 [!TYPE] 首行的 blockquote 原地改成 alert 节点
      // (variant ∈ note/tip/important/warning/caution,children 为去掉标记行后的块)。
      // 结构对齐 editor schema 的 alert toDOM —— 单层 div,不包 blockquote。
      const variant = String(node.variant ?? 'note').toLowerCase()
      const inner = await mdastToHtml(node.children as RootContent[], ctx)
      return `<div class="velo-alert velo-alert-${variant}" data-type="alert" data-variant="${variant}">${inner}</div>`
    }
    case 'thematicBreak':
      return '<hr />'
    case 'code': {
      const lang = (node.lang ?? '').toLowerCase()
      const value = node.value ?? ''
      // mermaid 走独立路径:渲染为 SVG,失败降级为原文 <pre>
      if (lang === 'mermaid') {
        const { svg, error } = await renderMermaidSvg(value, 'default')
        if (svg) {
          return `<div class="velo-mermaid-block">${svg}</div>`
        }
        if (error) ctx.warnings.push(`mermaid 块解析失败: ${error}`)
        return `<div class="velo-mermaid-block">${mermaidErrorHtml(value, error ?? '未知错误')}</div>`
      }
      // 其他代码块走 shiki 高亮
      const result = await renderCodeBlockHtml({
        code: value,
        lang,
        lightTheme: ctx.lightTheme,
        darkTheme: ctx.darkTheme,
      })
      if (result.html) return result.html
      ctx.warnings.push(`代码块高亮失败 (lang=${lang || 'plain'}): 降级为纯文本`)
      return codeBlockFallbackHtml(value, lang)
    }
    case 'math': {
      const { html, error } = renderKatexHtml(node.value, true)
      if (error) ctx.warnings.push(`块级公式渲染失败: ${error}`)
      return html
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : ''
      const items: string[] = []
      for (const item of node.children) {
        items.push(await listItemToHtml(item, !!node.ordered, ctx))
      }
      return `<${tag}${start}>${items.join('')}</${tag}>`
    }
    case 'table':
      return await tableToHtml(node, ctx)
    case 'html': {
      // mdast html 节点(块级),原 attrs.value 是 raw HTML —— 走 DOMPurify
      return `<div class="velo-html-block">${sanitizeHtml(node.value ?? '')}</div>`
    }
    case 'footnoteDefinition': {
      // 对齐编辑器 NodeView(FootnoteNodeViews.ts:createFootnoteDefinitionView)
      // 输出结构 —— 复用 _footnote.scss 已写好的 flex 三段布局,标号 + 描述 + 回链
      // 在同一行;命名 / id 也对齐:label/content/backref class,id 走 velo-fn-{slug}。
      // 描述里首段 paragraph 仍是 <p>,_footnote.scss 有
      //   `.footnote-definition .footnote-content > p { display: inline; margin: 0 }`
      // 把它解包成 inline,所以这里直接走 mdastToHtml 拿块级渲染就行。
      const label = String(node.identifier ?? '')
      const inner = await mdastToHtml(node.children as RootContent[], ctx)
      const slug = footnoteSlug(label)
      const labelEsc = escapeHtml(label)
      return `<div class="footnote-definition" id="velo-fn-${slug}" data-label="${labelEsc}">`
        + `<div class="footnote-label">${labelEsc}</div>`
        + `<div class="footnote-content">${inner}</div>`
        + `<a class="footnote-backref" href="#velo-fnref-${slug}">↩</a>`
        + `</div>`
    }
    case 'definition':
    case 'yaml':
    case 'toml':
      // 静默丢弃(跟 markdownIO 一致)
      return ''
    default:
      return ''
  }
}

async function listItemToHtml(item: any, _isOrdered: boolean, ctx: WalkContext): Promise<string> {
  // 任务列表:`checked` 不为 null 就是任务项,渲染 <input type="checkbox" disabled>
  const isTask = item.checked != null
  let checkbox = ''
  if (isTask) {
    const checked = item.checked ? ' checked' : ''
    checkbox = `<input type="checkbox" disabled${checked} /> `
  }
  // mdast listItem 必含首段 paragraph;复合格式(首段后跟嵌套 list / blockquote)
  // 也要求首段存在。导出 HTML 把首段 paragraph 解包成 inline(不包 <p>),
  // 跟 markdown 视觉一致;后续块级子节点原样渲染。
  const children = item.children as RootContent[]
  const parts: string[] = []
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    if (i === 0 && c.type === 'paragraph') {
      const inline = await mdastInlineToHtml((c as any).children ?? [], ctx)
      parts.push(inline)
    }
    else {
      parts.push(await mdastNodeToHtml(c, ctx))
    }
  }
  return `<li${isTask ? ' class="velo-task-item"' : ''}>${checkbox}${parts.join('')}</li>`
}

async function tableToHtml(node: Table, ctx: WalkContext): Promise<string> {
  if (!node.children?.length) return ''
  const align = node.align ?? []
  const rows: string[] = []
  for (let r = 0; r < node.children.length; r++) {
    const row = node.children[r]
    const cells: string[] = []
    for (let c = 0; c < row.children.length; c++) {
      const cell = row.children[c]
      const a = align[c]
      const style = a ? ` style="text-align:${a}"` : ''
      const tag = r === 0 ? 'th' : 'td'
      const inner = await mdastInlineToHtml(cell.children as PhrasingContent[], ctx)
      cells.push(`<${tag}${style}>${inner}</${tag}>`)
    }
    const rowTag = r === 0 ? 'tr' : 'tr'
    rows.push(`<${rowTag}>${cells.join('')}</${rowTag}>`)
  }
  return `<table>${rows.join('')}</table>`
}

// ========== inline → HTML ==========

async function mdastInlineToHtml(nodes: PhrasingContent[] | any[], ctx: WalkContext): Promise<string> {
  const out: string[] = []
  for (const node of mergeHtmlInlineRunsMdast(nodes)) {
    out.push(await inlineNodeToHtml(node, ctx))
  }
  return out.join('')
}

/**
 * 合并相邻的 html 行内节点 + 其间的纯文本节点,形成完整的 HTML 区域。
 *
 * 跟 editor/markdownIO.ts:mergeHtmlInlineRuns 同一问题:remark 把 `<kbd>Mod</kbd>`
 * 拆成 3 个 mdast 节点(html("<kbd>") / text("Mod") / html("</kbd>"))。若逐个
 * 走 sanitizeHtml,DOMPurify 把孤立的开标签 `<kbd>` 自动闭合成 `<kbd></kbd>`,
 * 文本 "Mod" 游离在外,闭标签被当 stray 丢弃 —— 视觉上 `<kbd>Mod</kbd>` 变成
 * `<kbd></kbd>Mod`,<sub>/<sup>/<mark> 同理失效。
 *
 * 这里复刻 editor 的标签栈状态机:遇到 html 节点开始缓冲,持续收 html + text
 * 直到标签栈清空(完整标签对已收齐),flush 成单个 html 节点,再由 inlineNodeToHtml
 * 的 `case 'html'` 把整段 raw HTML 一次性 sanitize —— 配对完整,DOMPurify 不会
 * 错位自闭。
 *
 * 已知限制(同 editor):HTML 区域内若夹带 mark(emphasis/strong 等)会丢 ——
 * 遇到非 html/text 节点先 flush 再透传,跟 editor 行为一致。
 */
function mergeHtmlInlineRunsMdast(nodes: PhrasingContent[] | any[]): PhrasingContent[] | any[] {
  const out: any[] = []
  let buf: string | null = null
  let openTags: string[] = []

  const flush = () => {
    if (buf !== null) {
      out.push({ type: 'html', value: buf })
      buf = null
      openTags = []
    }
  }

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g

  for (const node of nodes) {
    if (node.type === 'html') {
      if (buf === null) buf = ''
      buf += node.value ?? ''
      for (const m of (node.value ?? '').matchAll(tagRe)) {
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
      if (openTags.length === 0) flush()
    }
    else if (node.type === 'text' && buf !== null) {
      buf += node.value ?? ''
    }
    else {
      flush()
      out.push(node)
    }
  }
  flush()
  return out
}

async function inlineNodeToHtml(node: PhrasingContent | any, ctx: WalkContext): Promise<string> {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value ?? '')
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`
    case 'emphasis': {
      const inner = await mdastInlineToHtml(node.children, ctx)
      return `<em>${inner}</em>`
    }
    case 'strong': {
      const inner = await mdastInlineToHtml(node.children, ctx)
      return `<strong>${inner}</strong>`
    }
    case 'delete': {
      const inner = await mdastInlineToHtml(node.children, ctx)
      return `<del>${inner}</del>`
    }
    case 'highlight': {
      // remarkHighlight 注入的 custom node,渲染为 <mark> 跟 editor 一致
      const inner = await mdastInlineToHtml(node.children, ctx)
      return `<mark>${inner}</mark>`
    }
    case 'link': {
      // remarkEncodeLinkUrls 已把内部空格 encode 成 %20;导出 HTML 在外部
      // 浏览器里展示时需要可读 href,这里 decode 回原值(对照 markdownIO.ts:366-373)
      let href = node.url
      try { href = decodeURIComponent(href) } catch { /* 原样 */ }
      // 内部锚点:fragment 必须跟 heading id 同源 slugify,否则浏览器把空格
      // url-encode 成 %20(地址栏出现 #%20Foo%20Bar)而 heading id 走的是
      // slugify(小写 + 空格替 `-`),两边对不上 → HTML 点了没效果、PDF 不变成
      // 可点击链接。编辑器内 ctrl+click 是靠 linkClick.ts 运行时 fallback
      // 匹配命中的,导出的静态 HTML 没这层 JS 兜底,只能在产出时把 fragment
      // 写对。外部 URL 的 fragment(https://x.com/page#sec)不动 —— 远端 id
      // 由远端决定。
      if (href.startsWith('#')) {
        href = '#' + slugify(href.slice(1))
      }
      const title = node.title ? ` title="${escapeHtml(node.title)}"` : ''
      const inner = await mdastInlineToHtml(node.children, ctx)
      return `<a href="${escapeHtml(href)}"${title}>${inner}</a>`
    }
    case 'image': {
      let src = node.url
      // 跟 editor 内 proxyDomURL 一致:有 currentFilePath 时把相对路径走
      // convertFileSrc 转成 asset://;无 currentFilePath 走原值(可能已
      // 是 http(s):// / data: / 等)
      if (ctx.currentFilePath) {
        const abs = resolveImageAssetAbsPath(node.url, ctx.currentFilePath)
        const isRemote = /^(https?:|data:|asset:|tauri:|file:)/i.test(node.url)
        if (!isRemote) src = convertFileSrc(abs)
      }
      const alt = escapeHtml(node.alt ?? '')
      const title = node.title ? ` title="${escapeHtml(node.title)}"` : ''
      return `<img src="${escapeHtml(src)}" alt="${alt}"${title} />`
    }
    case 'break':
      return '<br />'
    case 'inlineMath': {
      const { html, error } = renderKatexHtml(node.value, false)
      if (error) ctx.warnings.push(`行内公式渲染失败: ${error}`)
      return html
    }
    case 'footnoteReference': {
      // 对齐编辑器 NodeView:id=velo-fnref-{slug},href=#velo-fn-{slug}。
      // class 用 footnote-ref(无 velo- 前缀,跟 _footnote.scss 的 .footnote-ref-node 同源,
      // 但导出场景不需要 contentEditable 编辑态,纯文本 <sup><a> 即可)。
      const label = String(node.identifier ?? '')
      const slug = footnoteSlug(label)
      const labelEsc = escapeHtml(label)
      return `<sup class="footnote-ref" id="velo-fnref-${slug}"><a href="#velo-fn-${slug}">${labelEsc}</a></sup>`
    }
    case 'html': {
      // mdast html 节点(行内),DOMPurify 清洗
      return sanitizeHtml(node.value ?? '')
    }
    default:
      return ''
  }
}

// ========== helper ==========

function isEmptyBrPlaceholder(para: any): boolean {
  // preserveEmptyLine 注入的占位是 <br /> html 节点
  return Array.isArray(para.children) && para.children.length === 1
    && para.children[0].type === 'html'
    && para.children[0].value === '<br />'
}

function textOfChildren(children: any[]): string {
  const parts: string[] = []
  for (const c of children ?? []) {
    if (c.type === 'text') parts.push(c.value ?? '')
    else if (c.type === 'inlineCode') parts.push(c.value ?? '')
    else if (c.children) parts.push(textOfChildren(c.children))
  }
  return parts.join('').trim()
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{Letter}\p{Number}\-_]/gu, '')
    .slice(0, 80)
}

/**
 * 脚注 id 用的 slug —— 对齐编辑器 NodeView 的 slug 规则
 * (FootnoteNodeViews.ts:67),保证 ref ↔ def 的锚点能互跳。
 * 注:不复用上面 `slugify` —— 那个是 heading id 用,会 toLowerCase,
 * 脚注 label 大小写敏感不能丢。
 */
function footnoteSlug(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'
}

/** 给测试用:把缺省 light / dark 主题填充成 DEFAULT_*。 */
export function resolveExportThemes(opts: Partial<ExportOptions> & Pick<ExportOptions, 'content' | 'fileName' | 'darkMode' | 'primaryColor' | 'fontFamily' | 'fontSize' | 'currentFilePath'>): ExportOptions {
  return {
    ...opts,
    lightTheme: opts.lightTheme ?? DEFAULT_LIGHT_THEME,
    darkTheme: opts.darkTheme ?? DEFAULT_DARK_THEME,
  }
}

// 图片源码编辑态用的 parse / serialize 纯函数。
//
// 两种格式:
//  - markdown 格式 `![alt](src "title")` —— 普通 markdown 图片
//  - html 格式 `<img src="..." alt="..." width="...">` —— 从 HTML 块接管的图片
//
// NodeView 编辑态把 image atom 节点替换成源码文本,blur 时解析回 src/alt/title
// attrs。这里集中维护正则,避免散在 NodeView 里,也方便单测覆盖边界用例。

export interface ImageSource {
  src: string
  alt: string
  title: string
}

/** html 格式图片源码解析结果,额外携带 src/alt/title 之外的属性(width/style 等)。 */
export interface HtmlImageSource extends ImageSource {
  /** src/alt/title 之外的额外 HTML 属性(width/style/class 等)。 */
  extraAttrs: Record<string, string>
}

// ============================================================
//  markdown 格式:![alt](src "title")
// ============================================================

// src 允许含 `(` `)`(本地文件路径常见,如 `(null).png`),靠 `\)\s*$` 锚定
// 最后一个 `)` 为语法收尾,non-greedy `[^']*?` 让 title 分支优先匹配。
// `(` `)` 不转义 —— 与 toMarkdown 自定义 image handler 保持一致,
// 用户在任何模式下看到的都是 `![img](assets/(null).png)` 无转义形态。
//   ^!\[([^\]]*)\]            [alt],alt 任意非 ]
//   \(([^']*?)                (src,任意非单引号字符,non-greedy 让 title 分支优先)
//   (?:\s+"([^"]*)")?          可选 " title",title 非 "
//   \s*\)\s*$                  ) 收尾,允许前后空白;锚定最后一个 ) 为语法收尾
const IMAGE_SOURCE_RE = /^!\[([^\]]*)\]\(([^']*?)(?:\s+"([^"]*)")?\s*\)\s*$/

/** 合法 → {src, alt, title};残缺 → null。title 缺省为 ""。 */
export function parseImageSource(raw: string): ImageSource | null {
  const m = raw.match(IMAGE_SOURCE_RE)
  if (!m) return null
  return { alt: m[1], src: m[2], title: m[3] ?? '' }
}

/** {src, alt, title} → `![alt](src "title")`,title 为空则省略。不转义 alt 内 ] / title 内 "(非标准 attrs 来源,round-trip 走 mdast 正规序列化不归这里管)。不转义 src 中的 `(` `)` —— 本地路径常含括号,与 toMarkdown 自定义 image handler 保持一致。 */
export function serializeImageSource({ src, alt, title }: ImageSource): string {
  const t = title ? ` "${title}"` : ''
  return `![${alt}](${src}${t})`
}

// ============================================================
//  html 格式:<img src="..." alt="..." width="...">
// ============================================================

// 匹配独立 <img> 标签(可自闭合 />),接受任意属性。
// 不匹配 img 嵌套在 HTML 内部的形态(如 `<div><img></div>`)——
// 那些 `<img` 前面不是行首空白,`^<img` 锚定拦不住。
// 属性顺序任意;值支持双引号 / 单引号 / 无引号。
const HTML_IMG_RE = /^<img\s+(.*?)\s*\/?>$/is

const ATTR_RE = /([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>\s]+))/g

/** 从属性字符串解析 key=value 对。返回 null 表示有无法识别的残留(布尔属性等)。 */
function parseImgAttrs(s: string): Record<string, string> | null {
  const attrs: Record<string, string> = {}
  let m: RegExpExecArray | null
  while ((m = ATTR_RE.exec(s)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4]
  }
  // 剥离所有合法属性后还有残留 → 含布尔属性 / 垃圾 → 不接管,保留 html_block
  if (s.replace(ATTR_RE, '').trim()) return null
  return attrs
}

/**
 * html 格式图片源码 → HtmlImageSource(含 src/alt/title + extraAttrs)。
 *
 * 接受任意属性的独立 `<img>` 标签:
 * - `<img src="x" alt="y">` → {src:"x", alt:"y", title:"", extraAttrs:{}}
 * - `<img src="x" alt="y" width="100">` → {src:"x", alt:"y", title:"", extraAttrs:{width:"100"}}
 * - `<div><img src="x"></div>` → null(不是独立 img 标签,img 嵌套在 HTML 内)
 * - `<img>` → null(无 src)
 * - `<img src="x" hidden>` → null(布尔属性无 =value,有残留)
 *
 * 既用于 markdownIO.fromMarkdown 检测独立 img,也用于编辑态 commit 解析。
 * 两处共用同一逻辑,保证"能进编辑态的图片 → commit 也能解析回来"。
 */
export function parseHtmlImageSource(raw: string): HtmlImageSource | null {
  const m = raw.match(HTML_IMG_RE)
  if (!m) return null
  const attrs = parseImgAttrs(m[1])
  if (!attrs || !attrs.src) return null
  const extraAttrs: Record<string, string> = {}
  for (const k of Object.keys(attrs)) {
    if (k !== 'src' && k !== 'alt' && k !== 'title') {
      extraAttrs[k] = attrs[k]
    }
  }
  return {
    src: attrs.src,
    alt: attrs.alt || '',
    title: attrs.title || '',
    extraAttrs,
  }
}

/** HtmlImageSource → `<img src="..." alt="..." width="...">`,空 alt / title 省略,额外属性原样写回。 */
export function serializeHtmlImageSource({ src, alt, title, extraAttrs }: HtmlImageSource): string {
  let attrs = `src="${src}"`
  if (alt) attrs += ` alt="${alt}"`
  if (title) attrs += ` title="${title}"`
  for (const [k, v] of Object.entries(extraAttrs)) {
    attrs += ` ${k}="${v}"`
  }
  return `<img ${attrs}>`
}

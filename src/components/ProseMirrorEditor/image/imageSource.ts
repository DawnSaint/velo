// 图片源码编辑态用的 parse / serialize 纯函数。
//
// NodeView 编辑态 textarea 里放的是 markdown 源码 `![alt](src "title")`,
// blur 时要解析回 image 节点的 src/alt/title attrs。这里集中维护正则,
// 避免散在 NodeView 里,也方便单测覆盖边界用例。

export interface ImageSource {
  src: string
  alt: string
  title: string
}

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

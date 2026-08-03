/**
 * Group 1 — 通用规则。适用于任何文本，CJK 或非 CJK。
 */

/** 将分散省略号（. . .）归一化为标准省略号（...）。 */
export function normalizeEllipsis(text: string): string {
  text = text.replace(/[ \t]*\.[ \t]+\.[ \t]+\.(?:[ \t]+\.)*/g, '...')
  text = text.replace(/\.\.\.(?!\.)[ \t]*(?=\S)/g, '... ')
  return text
}

/** 折叠过多换行（3+ → 2），处理遗留 <br /> 标签。 */
export function collapseNewlines(text: string): string {
  text = text.replace(/(\n\n)(<br\s*\/?>\n\n)+/g, '\n\n')
  text = text.replace(/\n\n<br\s*\/?>\n\n/g, '\n\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text
}

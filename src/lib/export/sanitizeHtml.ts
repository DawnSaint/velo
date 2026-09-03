// DOMPurify 清洗 HTML 字符串。
//
// 复用 editor/HtmlNodeView.ts 的 PURIFY_CONFIG 字段(FORBID_TAGS / FORBID_ATTR
// / ALLOWED_URI_REGEXP)—— 这是显式禁危险项的"安全网",与编辑器内的 html_block /
// html_inline 渲染口径完全一致。导出 HTML 时 html_block / html_inline 节点走
// 这里,保证用户写的 <details> / <abbr> / <kbd> 等合法 HTML 透传,但 script /
// iframe / onerror 等危险内容被洗掉。
//
// 与 HtmlNodeView.ts 的 PURIFY_CONFIG 同步约束:这份配置必须在两者之间
// 保持一致;若任一处变更,另一处也要同步改。后续 v0.5+ 若重构可抽到
// src/lib/sanitizeConfig.ts(留 TODO)。

import DOMPurify from 'dompurify'

type PurifyConfig = Parameters<typeof DOMPurify.sanitize>[1]

const PURIFY_CONFIG: PurifyConfig = {
  FORBID_TAGS: ['script', 'iframe', 'form', 'object', 'embed'],
  FORBID_ATTR: [
    'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur',
    'onchange', 'onsubmit', 'onkeydown', 'onkeyup', 'onkeypress',
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp|asset|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
}

/** 清洗用户写的原始 HTML 字符串,返回安全 HTML。 */
export function sanitizeHtml(raw: string): string {
  if (!raw) return ''
  return DOMPurify.sanitize(raw, PURIFY_CONFIG) as unknown as string
}

// 轻量 Markdown → HTML 渲染。
//
// 用于更新卡片等小场景(非编辑器、非导出),只处理 release notes 会用到的
// 基础语法:heading / list / paragraph / strong / emphasis / inlineCode /
// link / blockquote / thematicBreak / html(行内)。
//
// 不处理 mermaid / shiki / katex / table / [TOC] / frontmatter —— 这些在
// 更新日志场景不会出现,走 htmlRenderer.ts 那套重管线不划算。
//
// 复用 createParseProcessor() 保证 parse 语义与编辑器一致(GFM / 高亮 /
// alert / emoji 等),parse 出 mdast 后用同步 walker 转 HTML 字符串,
// 最后走 sanitizeHtml(DOMPurify)洗危险项。

import type { Root, RootContent, PhrasingContent } from 'mdast'
import { createParseProcessor } from '@/components/ProseMirrorEditor/editor/parseProcessor'
import { sanitizeHtml } from '@/lib/export/sanitizeHtml'

const processor = createParseProcessor()

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/** 把 markdown 字符串渲染为安全 HTML 字符串。 */
export function renderMarkdown(md: string): string {
  if (!md.trim()) return ''
  const tree = processor.runSync(processor.parse(md) as Root) as Root
  const html = mdastToHtml(tree.children as RootContent[])
  return sanitizeHtml(html)
}

function mdastToHtml(nodes: RootContent[]): string {
  return nodes.map(mdastNodeToHtml).join('')
}

function mdastNodeToHtml(node: RootContent | any): string {
  switch (node.type) {
    case 'paragraph': {
      const children = mdastInlineToHtml(node.children as PhrasingContent[])
      if (!children.trim()) return ''
      return `<p>${children}</p>`
    }
    case 'heading': {
      const level = Math.min(Math.max(node.depth, 1), 6)
      const children = mdastInlineToHtml(node.children as PhrasingContent[])
      return `<h${level}>${children}</h${level}>`
    }
    case 'blockquote': {
      const inner = mdastToHtml(node.children as RootContent[])
      return `<blockquote>${inner}</blockquote>`
    }
    case 'thematicBreak':
      return '<hr />'
    case 'code': {
      const value = escapeHtml(node.value ?? '')
      return `<pre><code>${value}</code></pre>`
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul'
      const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : ''
      const items = (node.children as any[]).map(listItemToHtml).join('')
      return `<${tag}${start}>${items}</${tag}>`
    }
    case 'html':
      // 块级 raw HTML —— sanitizeHtml 在最终出口统一洗
      return node.value ?? ''
    case 'alert': {
      const variant = String(node.variant ?? 'note').toLowerCase()
      const inner = mdastToHtml(node.children as RootContent[])
      return `<div class="velo-alert velo-alert-${variant}">${inner}</div>`
    }
    case 'yaml':
    case 'toml':
      return ''
    default:
      return ''
  }
}

function listItemToHtml(item: any): string {
  const children = item.children as RootContent[]
  const parts: string[] = []
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    if (i === 0 && c.type === 'paragraph') {
      parts.push(mdastInlineToHtml((c as any).children ?? []))
    } else {
      parts.push(mdastNodeToHtml(c))
    }
  }
  const isTask = item.checked != null
  const checkbox = isTask ? `<input type="checkbox" disabled${item.checked ? ' checked' : ''} /> ` : ''
  return `<li${isTask ? ' class="velo-task-item"' : ''}>${checkbox}${parts.join('')}</li>`
}

function mdastInlineToHtml(nodes: PhrasingContent[] | any[]): string {
  return nodes.map(inlineNodeToHtml).join('')
}

function inlineNodeToHtml(node: PhrasingContent | any): string {
  switch (node.type) {
    case 'text':
      return escapeHtml(node.value ?? '')
    case 'inlineCode':
      return `<code>${escapeHtml(node.value ?? '')}</code>`
    case 'emphasis':
      return `<em>${mdastInlineToHtml(node.children)}</em>`
    case 'strong':
      return `<strong>${mdastInlineToHtml(node.children)}</strong>`
    case 'delete':
      return `<del>${mdastInlineToHtml(node.children)}</del>`
    case 'highlight':
      return `<mark>${mdastInlineToHtml(node.children)}</mark>`
    case 'underline':
      return `<u>${mdastInlineToHtml(node.children)}</u>`
    case 'link': {
      let href = node.url
      try { href = decodeURIComponent(href) } catch { /* 原样 */ }
      const title = node.title ? ` title="${escapeHtml(node.title)}"` : ''
      const inner = mdastInlineToHtml(node.children)
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`
    }
    case 'break':
      return '<br />'
    case 'html':
      // 行内 raw HTML —— sanitizeHtml 在最终出口统一洗
      return node.value ?? ''
    case 'emoji': {
      const shortcode = String(node.shortcode ?? '')
      return `:${shortcode}:`
    }
    default:
      return ''
  }
}

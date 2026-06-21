// KaTeX → HTML 字符串。
//
// 复用 katex.renderToString(自带同步 API),失败时降级为 <span class="math-error">,
// 与 editor 的 MathNodeViews.ts:13-21 行为对齐,让用户在导出的 HTML 也能看到
// "公式语法错 + 原文 + 错误提示",而不是整段不见。
//
// 注:导出 HTML 跟编辑器内的 KaTeX 渲染走同一份 katex 库,字体 / 主题色一致;
// .katex 样式表来自 ./katexCss.ts —— Vite `?raw` 拿 katex.min.css 原文
// 再走 inlineKatexWoff2Fonts 把 woff2 inline 成 base64 data URI 并 strip
// woff/ttf 引用,保证导出 HTML 完全自包含(无 fonts/ 目录也能渲染)。

import katex from 'katex'

export interface KatexRenderResult {
  html: string
  error: string | null
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function renderKatexHtml(source: string, displayMode: boolean): KatexRenderResult {
  if (!source || !source.trim()) {
    // 与 MathNodeViews 的"(空)"占位行为对齐
    return {
      html: displayMode
        ? '<div class="math-block math-error">(空)</div>'
        : '<span class="math-inline math-error">(空)</span>',
      error: null,
    }
  }
  try {
    const html = katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      output: 'html',
    })
    return { html, error: null }
  }
  catch (e: unknown) {
    const msg = (e instanceof Error ? e.message : String(e)) || 'LaTeX 语法错误'
    const safe = escapeHtml(source)
    return {
      html: displayMode
        ? `<div class="math-block math-error" title="${escapeHtml(msg)}">${safe}</div>`
        : `<span class="math-inline math-error" title="${escapeHtml(msg)}">${safe}</span>`,
      error: msg,
    }
  }
}

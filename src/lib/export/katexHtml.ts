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

import type Katex from 'katex'

// katex 懒加载 —— 与 editor 侧 MathNodeViews.ts 的 getKatex 共享 Vite 拆出的
// katex chunk(同 dynamic import 路径,ESM 缓存同一模块实例)。导出场景不需要
// katex.min.css(CSS 走 ./katexCss.ts 的 base64 inline),所以这里只 import
// katex 库本身。

let katexMod: typeof Katex | null = null
let katexPromise: Promise<typeof Katex> | null = null

function getKatex(): Promise<typeof Katex> {
  if (katexMod) return Promise.resolve(katexMod)
  if (!katexPromise) {
    katexPromise = import('katex').then((m) => {
      katexMod = m.default
      return m.default
    })
  }
  return katexPromise
}

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

export async function renderKatexHtml(source: string, displayMode: boolean): Promise<KatexRenderResult> {
  if (!source || !source.trim()) {
    // 与 MathNodeViews 的"(空)"占位行为对齐
    return {
      html: displayMode
        ? '<div class="math-block math-error">(空)</div>'
        : '<span class="math-inline math-error">(空)</span>',
      error: null,
    }
  }
  const katex = await getKatex()
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

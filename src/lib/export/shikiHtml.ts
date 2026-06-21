// Shiki → 着色后的 <pre><code> HTML 字符串。
//
// 复用 CodeBlockLangs 的 getHighlighter / getHighlighterSync / ensureLanguage /
// getTokensSync —— 与 editor/CodeHighlightWidget.ts 的 token 渲染走完全同套
// API,保证编辑器和导出 HTML 的代码块配色一致(同一组 light/dark 主题)。
//
// 关键设计:导出 HTML **单主题 + prefers-color-scheme 自适应**。
// - 编辑器内是 dual themes(两个 hex 写到 --shiki-light / --shiki-dark,通过
//   <html class="dark"> 切色)。但导出 HTML 是给读者看的静态页面,没有
//   class 切换能力 —— 我们仍然写双 hex 到 inline 变量,但用 CSS 媒体查询
//   @media (prefers-color-scheme: dark) 接管选色,跟 GitHub README 同款。
// - 单主题由调用方选(opts.lightTheme / opts.darkTheme),默认走 settings 里的
//   codeLightTheme / codeDarkTheme(用户在编辑器选的)。
//
// **降级**:lang 未注册 / shiki 加载失败 → 返回 null,htmlRenderer 降级为
// <pre class="velo-code-block"><code>原 code</code></pre>(无高亮)。

import {
  ensureLanguage,
  getHighlighter,
  getHighlighterSync,
} from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import type { ThemedTokenWithVariants } from 'shiki'

export interface ShikiRenderOptions {
  code: string
  lang: string
  lightTheme: string
  darkTheme: string
}

export interface ShikiRenderResult {
  /** 完整 <pre><code>...</code></pre> 字符串,失败时 null(由调用方降级)。 */
  html: string | null
}

/** 给单 token 写 inline style 字符串,跟 CodeHighlightWidget.ts:507-525 同形。 */
function tokenStyle(token: ThemedTokenWithVariants): string {
  const light = token.variants?.light?.color
  const dark = token.variants?.dark?.color
  const parts: string[] = []
  if (light) parts.push(`--shiki-light:${light}`)
  if (dark) parts.push(`--shiki-dark:${dark}`)
  return parts.length ? ` style="${parts.join(';')}"` : ''
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export async function renderCodeBlockHtml(opts: ShikiRenderOptions): Promise<ShikiRenderResult> {
  const { code, lang, lightTheme, darkTheme } = opts
  if (!code) return { html: null }

  // 1) 确保 highlighter + lang 都装好
  //    getHighlighter 内部走 singleton,可能由 editor / App.vue 启动期已 resolve;
  //    await 是为了未 resolve 场景(如单元测试单独跑 export 路径)也能跑通。
  await getHighlighter(undefined, lightTheme, darkTheme)
  if (lang) await ensureLanguage(lang)

  const hl = getHighlighterSync()
  if (!hl) return { html: null }

  // 2) 走 getTokensSync(同步,实时拿 token);lang 未装返回 null → 降级
  const result = (() => {
    // 同步分支:CodeBlockLangs 内部已经做了 lang 是否注册 / 是否 in-flight 的判别,
    // miss 时静默 return null,我们外层 catch-all 走降级
    try {
      // 同 CodeHighlightWidget.ts:493,直接调内部 API
      return (hl as any).codeToTokensWithThemes(code, {
        lang: lang || 'text',
        themes: { light: lightTheme, dark: darkTheme },
      })
    }
    catch {
      return null
    }
  })()

  if (!result) return { html: null }

  // 3) 把 token 转成 HTML span,与 CodeHighlightWidget.ts:507-525 同形
  const lines: string[] = []
  for (const line of result as ThemedTokenWithVariants[][]) {
    if (line.length === 0) {
      lines.push('')
      continue
    }
    let lineHtml = ''
    for (const token of line) {
      if (!token.content) continue
      lineHtml += `<span${tokenStyle(token)}>${escapeHtml(token.content)}</span>`
    }
    lines.push(lineHtml)
  }

  // 4) 组装 <pre><code>:<pre> 上挂 language-X class + data-shiki-theme-* 让
  //    后续 CSS 媒体查询可以基于 prefers-color-scheme 选色。
  const langClass = lang ? ` language-${lang}` : ''
  const html
    = `<pre class="velo-code-block${langClass}" data-shiki-theme-light="${escapeHtml(lightTheme)}" data-shiki-theme-dark="${escapeHtml(darkTheme)}">`
      + `<code${langClass}>${lines.join('\n')}</code>`
      + `</pre>`
  return { html }
}

/** 失败的代码块降级为 <pre><code> 纯文本(无高亮)。 */
export function codeBlockFallbackHtml(code: string, lang: string): string {
  const langClass = lang ? ` language-${lang}` : ''
  return `<pre class="velo-code-block${langClass}"><code${langClass}>${escapeHtml(code)}</code></pre>`
}

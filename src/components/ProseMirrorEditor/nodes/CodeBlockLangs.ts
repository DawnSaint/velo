// shiki v4 + 代码块语言配置。
//
// 设计要点:
// - **Dual Themes 集成**:用真实 vitesse-light + vitesse-dark 主题,shiki
//   给每个 token 输出 --shiki-light / --shiki-dark 局部 CSS 变量。切
//   <html class="dark"> 时 CSS cascade 选 dark 变量值,ProseMirror / shiki
//   不参与(零重渲)。官方已不推荐 css-variables 主题模式,转 Dual Themes
//   走真实主题颜色更准确。
// - **bundled themes**:createHighlighter 直接传主题名字符串,shiki 内部
//   从 @shikijs/themes 自动加载,不用手 import 主题对象。
// - **LANG_OPTIONS 是 shiki langs 的唯一来源**:浮层下拉清单 == createHighlighter
//   喂进去的 lang 集,改一处即同步;'' 留给 "plain text"(shiki 不参与)。
//   用户手敲的 lang 字符串(不在 LANG_OPTIONS 里)走 hl.getLanguage 内置
//   alias 解析(jsx→typescript 等由 shiki 维护),解析不到 fallback 纯文本。
// - **singleton + 异步**:createHighlighter 异步返回,内部用 Promise 缓存;
//   第一次 getHighlighter() 启动 grammar 加载,后续 await 拿到的都是同一个实例。

import { createHighlighter } from 'shiki'
import type { Highlighter, ThemedTokenWithVariants } from 'shiki'


// ============================================================
//  浮层下拉开放清单
//  ''     → "plain text"(shiki 不参与)
//  其他    → 候选 lang 字符串;shiki 认识的注册高亮,不认识的 fallback 纯文本
// ============================================================

export const LANG_OPTIONS: readonly string[] = [
  '',
  'javascript', 'typescript', 'jsx', 'tsx',
  'python', 'go', 'rust', 'java', 'c', 'cpp', 'csharp',
  'html', 'css', 'scss', 'sass', 'less',
  'json', 'yaml', 'toml', 'xml',
  'sql', 'bash', 'shell', 'powershell',
  'markdown', 'diff', 'dockerfile', 'makefile',
  'vue', 'svelte',
]

// ============================================================
//  Highlighter singleton
// ============================================================

let highlighterPromise: Promise<Highlighter> | null = null

/**
 * 拿(或创建)highlighter。第一次调用启动 grammar / wasm 加载,后续调用
 * 复用同一个 Promise——调用方拿到的都是同一个 Highlighter 实例。
 */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      langs: LANG_OPTIONS.filter(l => l),
      themes: ['vitesse-light', 'vitesse-dark'],
    })
  }
  return highlighterPromise
}

/**
 * 测试用:重置 singleton,让下一次 getHighlighter() 重新创建。生产代码
 * 不应调用。
 */
export function __resetHighlighterForTest(): void {
  highlighterPromise = null
}

// ============================================================
//  同步 token 提取(inline decoration 路径用)
// ============================================================

/** 计算文本的简单 hash(用于 cache key)。 */
export function hashCode(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}

/** 同步跑 token 解析:lang 未注册或 highlighter 还没好 → 返回 null。
 *  走 codeToTokensWithThemes + defaultColor: false,shiki 只输出
 *  --shiki-light / --shiki-dark 局部 CSS 变量,切 darkMode 走 CSS cascade
 *  翻面,ProseMirror / shiki 不参与(零重渲)。lang 走 shiki 内置 alias
 *  + 大小写无关(js→javascript 等不手维护)。 */
export function getTokensSync(
  hl: Highlighter | null,
  code: string,
  lang: string,
): { tokens: ThemedTokenWithVariants[][] } | null {
  if (!hl || !lang) return null
  const grammar = hl.getLanguage(lang)
  if (!grammar) return null
  try {
    const tokens = hl.codeToTokensWithThemes(code, {
      lang: grammar.name as any,
      themes: { light: 'vitesse-light', dark: 'vitesse-dark' }
    })
    return { tokens }
  }
  catch {
    return null
  }
}

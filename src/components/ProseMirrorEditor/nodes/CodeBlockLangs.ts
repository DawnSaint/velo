// shiki v4 + 代码块语言 / 主题配置。
//
// 设计要点:
// - **Dual Themes 集成**:每个 token 在 inline style 写局部 CSS 变量
//   --shiki-light / --shiki-dark,切 <html class="dark"> 时走 CSS cascade
//   翻面,ProseMirror / shiki 不参与(零重渲)。pre 背景写死(始终白/深灰),
//   跟主题色解耦 — 用户切主题不会白屏跳跃。
// - **bundled themes + 懒加载**:createHighlighter 启动时只装当前选中的
//   [light, dark] 2 个主题(默认 vitesse-light / vitesse-dark),切主题时
//   调 loadTheme(themeId) ~100-300ms 异步追加,append-only 不重建 highlighter。
//   启动期由 App.vue 主动 ensureTheme 预加载 settings 里的持久化主题,
//   避免首屏代码块空白。
// - **bundledThemesInfo 拿主题元数据**:shiki 主包 export 的 ThemeMetadata[]
//   含 id / displayName / type('light' | 'dark')。设置面板下拉从这里读,
//   build 时 tree-shake 不会把全 themes JSON 拖进 bundle。
// - **LANG_OPTIONS 是 shiki langs 的唯一来源**:浮层下拉清单 == createHighlighter
//   喂进去的 lang 集,改一处即同步;'' 留给 "plain text"(shiki 不参与)。
//   用户手敲的 lang 字符串走 hl.getLanguage 内置 alias 解析。
// - **singleton + 异步**:createHighlighter 异步返回,内部用 Promise 缓存。

import { createHighlighter, bundledThemesInfo } from 'shiki'
import type { BundledTheme, Highlighter, ThemedTokenWithVariants } from 'shiki'

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
//  主题清单(给设置面板下拉用,按 displayName 字母排序)
// ============================================================

/** 主题元数据,来自 shiki bundledThemesInfo。
 *  字段: id / displayName / type('light' | 'dark') */
export const BUNDLED_THEMES: ReadonlyArray<{ id: string, displayName: string, type: string }> = bundledThemesInfo
  .map(t => ({ id: t.id, displayName: t.displayName, type: t.type }))
  .sort((a, b) => a.displayName.localeCompare(b.displayName))

/** 默认浅色 / 深色主题,首启动 + 设置缺失时用。 */
export const DEFAULT_LIGHT_THEME = 'one-light'
export const DEFAULT_DARK_THEME = 'one-dark-pro'

// ============================================================
//  Highlighter singleton(懒加载主题)
// ============================================================

let highlighterPromise: Promise<Highlighter> | null = null
/** 已 resolve 的 highlighter 缓存 — promise 一旦 resolve 就同步可读。
 *  用于 plugin `state.init` 这种同步入口:App.vue 在 PM mount 前已经
 *  `await getHighlighter()` 完,这里 getHighlighterSync() 直接拿到 hl,
 *  state.init 就有 highlighter,plugin.decorations 第一次跑就写 token
 *  inline style → 首屏零闪烁。 */
let cachedHighlighter: Highlighter | null = null

/** 正在 await 的 themeId set — loadTheme 重复 call 同 id 不重起 promise。 */
const loadingThemes = new Set<string>()

/**
 * 拿(或创建)highlighter。第一次调用启动 grammar / wasm 加载 + 初始 2 个主题;
 * 后续调用复用同一个 Promise(拿到同一个 Highlighter 实例)。
 * lightTheme / darkTheme 是启动期要装的主题;若 highlighterPromise 已存在(被先
 * 一步的 plugin factory 用默认主题创建),返回的 hl 不一定装了这俩,调用方应紧接
 * 着调 ensureTheme 追加;本函数只保证 lightTheme/darkTheme **在 init 时被装**。
 *
 * **resolved 后同步缓存**:`cachedHighlighter` 在 promise resolve 时填好,
 * 之后 `getHighlighterSync()` 同步可读。App.vue 在 PM mount 前 await 完成
 * → PM mount 时 `getHighlighterSync()` 同步拿到 hl → plugin state.init
 * 就能拿到 highlighter,避免首屏"先默认色后用户主题色"的闪烁。
 */
export function getHighlighter(
  lightTheme = DEFAULT_LIGHT_THEME,
  darkTheme = DEFAULT_DARK_THEME,
): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      langs: LANG_OPTIONS.filter(l => l),
      themes: [lightTheme, darkTheme],
    }).then((hl) => {
      cachedHighlighter = hl
      return hl
    })
  }
  return highlighterPromise
}

/**
 * 同步拿 highlighter。仅在 getHighlighter() 的 promise 已 resolve 后
 * 返回非 null;否则返回 null。给 plugin `state.init` 等同步入口用:
 * PM mount 时 highlighterPromise 必然已 resolve(App.vue codeBlockReady
 * 守门),这里同步拿到 hl,init state 就有 highlighter,第一次 decorations
 * 就出 token style → 零闪烁。
 */
export function getHighlighterSync(): Highlighter | null {
  return cachedHighlighter
}

/**
 * 懒加载一个主题(append-only,不重建 highlighter)。已加载直接 resolve。
 * 重复并发 call 同 id 走同一 promise。返回的 hl 已是装好该主题的实例,
 * 调用方 dispatch tr.setMeta(codeHighlightKey, { highlighter: hl }) 触发 rebuild。
 */
export async function ensureTheme(themeId: string): Promise<Highlighter> {
  const hl = await getHighlighter()
  if (hl.getLoadedThemes().includes(themeId)) return hl
  if (loadingThemes.has(themeId)) {
    // 等别人装好,自己 return hl
    await new Promise<void>((resolve) => {
      const check = () => {
        if (hl.getLoadedThemes().includes(themeId)) resolve()
        else setTimeout(check, 16)
      }
      check()
    })
    return hl
  }
  loadingThemes.add(themeId)
  try {
    // settings store 里的 codeLightTheme / codeDarkTheme 是 string;UI 面板
    // 只暴露 shiki bundled themes 列表(bundledThemesInfo 驱动),不会出现外部字符串。
    // 这里 `as BundledTheme` 是把 string 缩窄成 shiki 接受的 string literal union。
    await hl.loadTheme(themeId as BundledTheme)
  }
  finally {
    loadingThemes.delete(themeId)
  }
  return hl
}

/**
 * 测试用:重置 singleton,让下一次 getHighlighter() 重新创建。生产代码
 * 不应调用。
 */
export function __resetHighlighterForTest(): void {
  highlighterPromise = null
  cachedHighlighter = null
  loadingThemes.clear()
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
 *  走 codeToTokensWithThemes 双主题 API,返回 ThemedTokenWithVariants[][],每个
 *  token 在 variants.light / variants.dark 各有一套 hex。inline style 怎么写由
 *  调用方 buildDecorations 决定 —— 拼成 `--shiki-light:xxx;--shiki-dark:yyy`
 *  局部 CSS 变量(不写 `color:` 前缀,纯靠 SCSS 那边 `color: var(--shiki-light)`
 *  选色)。切 darkMode 翻面走 CSS cascade,ProseMirror / shiki 不参与(零重渲);
 *  切主题需 rebuild decoration(新主题颜色不同,CSS 变量值变了得重新生成 inline style)。 */
export function getTokensSync(
  hl: Highlighter | null,
  code: string,
  lang: string,
  lightTheme: string,
  darkTheme: string,
): { tokens: ThemedTokenWithVariants[][] } | null {
  if (!hl || !lang) return null
  let grammar
  try {
    grammar = hl.getLanguage(lang.toLowerCase())
  }
  catch {
    return null
  }
  if (!grammar) return null
  try {
    const tokens = hl.codeToTokensWithThemes(code, {
      lang: grammar.name as any,
      themes: { light: lightTheme as BundledTheme, dark: darkTheme as BundledTheme },
    })
    return { tokens }
  }
  catch {
    return null
  }
}

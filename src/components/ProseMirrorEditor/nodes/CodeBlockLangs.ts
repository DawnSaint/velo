// shiki v4 + 代码块语言 / 主题配置。
//
// 设计要点:
// - **Dual Themes 集成**:每个 token 在 inline style 写局部 CSS 变量
//   --shiki-light / --shiki-dark,切 <html class="dark"> 时走 CSS cascade
//   翻面,ProseMirror / shiki 不参与(零重渲)。pre 背景写死(始终白/深灰),
//   跟主题色解耦 — 用户切主题不会白屏跳跃。
// - **预扫 + 懒加载 lang**:createHighlighter 启动时只装 doc
//   实际用到的 lang(由 App.vue 调 extractLangsFromDoc 预扫 `code` 节点
//   的 lang 字段),不传完整 LANG_OPTIONS 全表。空 doc 走 5 项 BASELINE
//   兜底(javascript / typescript / python / bash / json),覆盖最高频
//   输入。运行时用户切到未预装的 lang(粘贴 / picker 选)→ `getTokensSync`
//   检测 `hl.getLoadedLanguages()` miss → 异步 `ensureLanguage(lang)` 追加
//   + resolve 后 dispatch setMeta 触发 plugin rebuild。`bundledThemes` 同
//   理,ensureTheme 走另一路径(只追加主题不重建 hl)。
// - **bundled themes + 懒加载**:createHighlighter 启动时只装当前选中的
//   [light, dark] 2 个主题(默认 vitesse-light / vitesse-dark),切主题时
//   调 loadTheme(themeId) ~100-300ms 异步追加,append-only 不重建 highlighter。
//   启动期由 App.vue 主动 ensureTheme 预加载 settings 里的持久化主题,
//   避免首屏代码块空白。
// - **bundledThemesInfo 拿主题元数据**:shiki 主包 export 的 ThemeMetadata[]
//   含 id / displayName / type('light' | 'dark')。设置面板下拉从这里读,
//   build 时 tree-shake 不会把全 themes JSON 拖进 bundle。
// - **LANG_OPTIONS 是浮层下拉 + 测试兜底清单**:不直接喂给 createHighlighter
//   (启动期只装 doc 用到的 lang,见上"预扫 + 懒加载 lang");`getHighlighter()`
//   无参调用时 fallback 到 LANG_OPTIONS 全集,给测试 / 旧调用方用。'' 留给
//   "plain text"(shiki 不参与)。用户手敲的 lang 字符串走 hl 内置 alias 解析。
// - **singleton + 异步**:createHighlighter 异步返回,内部用 Promise 缓存。

import { createHighlighter, bundledLanguages, bundledThemesInfo } from 'shiki'
import type { BundledLanguage, BundledTheme, Highlighter, ThemedTokenWithVariants } from 'shiki'

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
  'mermaid',
]  

/** 启动期最小预装 lang 清单(空 doc / 首次打开新文件时兜底用)。
 *  覆盖 markdown 编辑器最高频的 5 种:js / ts / py / bash / json。
 *  跟 LANG_OPTIONS 不重叠,LANG_OPTIONS 是浮层下拉用的全集。
 *  export 是给 App.vue 拼"doc 用到的 ∪ baseline"用。 */
export const BASELINE_LANGS: readonly string[] = [
  'javascript', 'typescript', 'python', 'bash', 'json',
  'mermaid',
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

/** 正在 await 的 langId set — ensureLanguage 重复 call 同 id 不重起 promise。
 *  同时给 getTokensSync 当 gate:lang 已在 in-flight 时不再触发第二次 load。 */
const loadingLangs = new Set<string>()

/** Decoration rebuild 通知钩子(单 slot,跟 ensureTheme 模式一致)。
 *  plugin `view` factory mount 时注册、destroy 时清空。ensureLanguage
 * 完成后调一次,plugin 端走 rAF 节流后 dispatch setMeta 触发 rebuild。 */
let decorationRebuildCallback: (() => void) | null = null

/**
 * 拿(或创建)highlighter。第一次调用启动 grammar / wasm 加载 + 初始 2 个主题;
 * 后续调用复用同一个 Promise(拿到同一个 Highlighter 实例)。
 *
 * @param langs   启动期要装的 lang 列表。`undefined` → 默认装 LANG_OPTIONS
 *                全集(测试 / 未走 pre-scan 的旧调用方走这条);`[]` → 不预装
 *                任何 lang(完全靠运行时 ensureLanguage 兜底);正常路径由
 *                App.vue 传 `extractLangsFromDoc(content) ∪ BASELINE_LANGS`。
 * @param lightTheme / darkTheme  启动期要装的主题;若 highlighterPromise 已存在
 *                (被先一步的 plugin factory 用默认主题创建),返回的 hl 不一定
 *                装了这俩,调用方应紧接着调 ensureTheme 追加;本函数只保证
 *                lightTheme/darkTheme **在 init 时被装**。
 *
 * **resolved 后同步缓存**:`cachedHighlighter` 在 promise resolve 时填好,
 * 之后 `getHighlighterSync()` 同步可读。App.vue 在 PM mount 前 await 完成
 * → PM mount 时 `getHighlighterSync()` 同步拿到 hl → plugin state.init
 * 就能拿到 highlighter,避免首屏"先默认色后用户主题色"的闪烁。
 */
export function getHighlighter(
  langs?: string[],
  lightTheme = DEFAULT_LIGHT_THEME,
  darkTheme = DEFAULT_DARK_THEME,
): Promise<Highlighter> {
  if (!highlighterPromise) {
    // undefined(未传)→ 测试 / 旧调用方,装全集;显式 [] 走兜底空集;显式数组用之
    const resolvedLangs = langs === undefined
      ? LANG_OPTIONS.filter(l => l)
      : langs
    highlighterPromise = createHighlighter({
      langs: resolvedLangs,
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
 * 注册 / 注销 Decoration rebuild 通知钩子。plugin `view` factory mount
 * 时注册(destroy 时清 null)。`ensureLanguage` resolve 后调一次注册
 * 的 callback,plugin 端走 rAF 节流后 dispatch setMeta 触发 rebuild。
 *
 * 单 slot(当前项目一个 PM instance);若未来多编辑器要并存再改 Set<cb>。
 */
export function setDecorationRebuildCallback(cb: (() => void) | null): void {
  decorationRebuildCallback = cb
}

/**
 * 懒加载一个 lang(append-only,不重建 highlighter)。已加载直接 resolve;
 * 重复并发 call 同 id 走同一 promise;完成后通知 rebuild 钩子。
 *
 * 启动期 App.vue 已经预扫过 doc 用到的 lang + BASELINE;本函数兜底
 * 运行时"用户切到 / 粘贴未预装 lang"。未注册的 lang(shiki 抛 ShikiError)
 * 在内部 catch + warn,不重试。
 */
export async function ensureLanguage(lang: string): Promise<void> {
  const hl = await getHighlighter()
  const id = lang.toLowerCase()
  if (hl.getLoadedLanguages().includes(id)) return
  if (loadingLangs.has(id)) return
  loadingLangs.add(id)
  try {
    // LANG_OPTIONS 是手维护的 30 项清单;运行时用户走 picker 选 / 粘贴
    // 自定义 lang,可能不在清单里。`bundledLanguages` 是 shiki 全套 200+
    // bundling,任何合法的 lang id 都能 load。这里 `as BundledLanguage`
    // 是把 string 缩窄成 shiki 接受的 string literal union,运行时 shiki
    // 自己校验是否在 bundled 列表里(不在则 throw → 走 catch warn)。
    await hl.loadLanguage(id as BundledLanguage)
  }
  catch (err) {
    // 未注册 lang / 加载失败:静默 warn,UI 走 SCSS 默认色(无 token 配色)
    console.warn(`[shiki] ensureLanguage("${id}") failed:`, err)
  }
  finally {
    loadingLangs.delete(id)
  }
  // 无论成功失败都通知 rebuild —— 失败的那次 getTokensSync 还是 null,
  // 但 rebuild 让 getTokensSync 重新被调到一次,确保后续请求走统一路径
  decorationRebuildCallback?.()
}

/**
 * 懒加载 markdown grammar（append-only,不重建 highlighter）。
 * 源码模式高亮用。已加载直接 resolve。
 */
export async function ensureMarkdownGrammar(): Promise<void> {
  await ensureLanguage('markdown')
}
export function __resetHighlighterForTest(): void {
  highlighterPromise = null
  cachedHighlighter = null
  loadingThemes.clear()
  loadingLangs.clear()
  decorationRebuildCallback = null
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

/** 同步跑 token 解析:lang 未装或 highlighter 还没好 → 返回 null。
 *  走 codeToTokensWithThemes 双主题 API,返回 ThemedTokenWithVariants[][],每个
 *  token 在 variants.light / variants.dark 各有一套 hex。inline style 怎么写由
 *  调用方 buildDecorations 决定 —— 拼成 `--shiki-light:xxx;--shiki-dark:yyy`
 *  局部 CSS 变量(不写 `color:` 前缀,纯靠 SCSS 那边 `color: var(--shiki-light)`
 *  选色)。切 darkMode 翻面走 CSS cascade,ProseMirror / shiki 不参与(零重渲);
 *  切主题需 rebuild decoration(新主题颜色不同,CSS 变量值变了得重新生成 inline style)。
 *
 * **lang 未装兜底**:用 `hl.getLoadedLanguages()` 探活(而非 `hl.getLanguage()`,
 * 后者在 lang 不存在时 throw ShikiError,不适合做"未装"探测)。未装 → 触发
 * `ensureLanguage` 异步加载,本次 return null;resolve 后 rebuild 钩子通知
 * plugin 重新跑 `decorations(state)`,届时再调 `getTokensSync` 拿真 token。
 * 未注册的 lang(`xyz-not-registered` 之类)走 ensureLanguage 内部 try/catch
 * warn,不会无限重试。 */
export function getTokensSync(
  hl: Highlighter | null,
  code: string,
  lang: string,
  lightTheme: string,
  darkTheme: string,
): { tokens: ThemedTokenWithVariants[][] } | null {
  if (!hl || !lang) return null
  const id = lang.toLowerCase()
  if (!hl.getLoadedLanguages().includes(id)) {
    // lang 不在 shiki bundled 列表(用户手敲 `xyz-not-registered` 之类)
    // → 直接 return null,不触发 ensureLanguage 也不 warn(避免控制台刷屏)。
    // `bundledLanguages` 是 shiki 全套 200+ 列表的 Record<id, loader>,
    // 包含 `js` 这种 alias,跟 `getLoadedLanguages()` 的 alias 路由一致。
    if (!(id in bundledLanguages)) return null
    // 已在 in-flight 不重起;首次 miss 触发异步加载,本次 return null
    if (!loadingLangs.has(id)) {
      void ensureLanguage(id)
    }
    return null
  }
  try {
    const tokens = hl.codeToTokensWithThemes(code, {
      lang: id as any,
      themes: { light: lightTheme as BundledTheme, dark: darkTheme as BundledTheme },
    })
    return { tokens }
  }
  catch {
    return null
  }
}

// ============================================================
//  Token 缓存(per-keystroke 性能关键路径)
// ============================================================
//
// `props.decorations(state)` 契约无脏区间钩子,每次 transaction 全量重跑;
// 1000 行文档对所有 code_block 同步跑 `codeToTokensWithThemes` 累计 100ms+
// 卡顿。按 `(lang + 两套主题 + content-hash)` LRU 缓存 token 数组,普通段落
// 键入 ~99% 命中,单键 decoration build 从 ~100ms 降到 ~5ms。详见
// docs/architecture/editor.md 的 shiki token cache 说明。
//
// 缓存值是 token 而非 Decoration —— token.offset 是块首相对偏移,与 doc 位置
// 无关;`buildDecorations` 仍走 `blockStart + offset` 重算绝对 pos。直接缓存
// Decoration 会脏(`Decoration.inline` from/to 是绝对位置,块在 doc 里移动就过时)。
const TOKEN_CACHE_CAP = 200
const tokenCache = new Map<string, ThemedTokenWithVariants[][]>()

/** `getTokensSync` 的带缓存版本 —— 命中跳过 shiki 同步分词。 */
export function getTokensCached(
  hl: Highlighter | null,
  code: string,
  lang: string,
  lightTheme: string,
  darkTheme: string,
): { tokens: ThemedTokenWithVariants[][] } | null {
  if (!hl || !lang) return null
  const key = `${lang}:${lightTheme}:${darkTheme}:${hashCode(code)}`
  const cached = tokenCache.get(key)
  if (cached) {
    // LRU 提到末尾(Map iteration 序 = 插入序)
    tokenCache.delete(key)
    tokenCache.set(key, cached)
    return { tokens: cached }
  }
  const result = getTokensSync(hl, code, lang, lightTheme, darkTheme)
  if (!result) return null
  if (tokenCache.size >= TOKEN_CACHE_CAP) {
    // 淘汰最老条目:Map.keys() 迭代序就是插入序,第一个是 LRU 端
    const oldest = tokenCache.keys().next().value
    if (oldest !== undefined) tokenCache.delete(oldest)
  }
  tokenCache.set(key, result.tokens)
  return result
}

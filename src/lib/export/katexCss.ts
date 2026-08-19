// KaTeX CSS 自包含:把 woff2 字体 inline 成 base64 data URI,strip woff/ttf 引用。
//
// 背景:
//  - 编辑器在 EditorInner.vue:45 走 `import 'katex/dist/katex.min.css'`(side-effect
//    import),Vite 在 dev / build 都把 url(fonts/KaTeX_*.{woff2,woff,ttf}) 重写
//    成 bundled 资源路径,字体在主 webview 内能解析。
//  - 导出 HTML 走 `?inline` 拿到 CSS 原文,Vite **不**改 url() 引用,导出文件
//    旁没有 fonts/ 目录 → 浏览器 / 打印用的 WebView2 找不到 KaTeX_*.{woff2,
//    woff,ttf} → 控制台 ERR_FILE_NOT_FOUND → 字体回退到系统 serif / sans-serif,
//    公式外观与编辑器不一致。
//
// 修法:
//  - 走 `import.meta.glob` + Vite `?inline` 把 20 个 woff2 全部 inline 成 base64
//    data URI(build 期完成,运行时已是字符串),拼回 katex.min.css 的 @font-face src
//    里;woff / ttf 同步 strip(现代浏览器含 WebView2 都首选 woff2,后两条只是
//    fallback)。
//  - 改写后整段 src 只有一个 woff2 data URI,体积从 ~1MB raw / ~1.3MB base64
//    (60 文件) 压到 ~260KB raw / ~340KB base64(20 woff2);同时少了 40 条
//    解析不到的 url(),console 干净。
//
// 副作用:
//  - 主 bundle 多 ~340KB 静态 base64(常驻,即使没导出也在;导出功能必用,可接受)
//  - dev / build 路径一致(Vite 静态分析 glob,eager: true 同步拿到对象字面量)
//
// 为什么不走 fetch(...?url) 异步拿二进制再 FileReader 转 data URI:可以省主
// bundle,但每个 export 触发 20 次 fetch + 转码,启动到 PDF 写出多几百 ms,而且
// 写一份自包含文件要承担 race / 网络错。导出本身就不频繁(用户主动点),静态
// inline 的简单/可靠 > bundle 大小。

// Vite `?inline` 对 binary 资源返回 `data:<mime>;base64,...` 完整 data URI 字符串,
// text 资源返回原文。20 个 woff2 一次性走 glob 拿到。
const katexWoff2Modules = import.meta.glob(
  '../../../node_modules/katex/dist/fonts/*.woff2',
  { query: '?inline', import: 'default', eager: true },
) as Record<string, string>

// 抽出 filename → dataUri 的查找表,运行时替换用。
// modulePath 形如 `'../../../node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2'`。
const katexWoff2DataUris: Record<string, string> = {}
for (const [modulePath, dataUri] of Object.entries(katexWoff2Modules)) {
  const filename = modulePath.split('/').at(-1) ?? ''
  katexWoff2DataUris[filename] = dataUri
}

/**
 * 把 katex.min.css 里所有 `@font-face` 的 src 改写成 woff2 base64 data URI。
 *
 * katex.min.css 里每个字体的 @font-face src 形如:
 *   `src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),
 *         url(fonts/KaTeX_AMS-Regular.woff) format("woff"),
 *         url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")`
 *
 * 重写成:
 *   `src:url(data:font/woff2;base64,XXX) format("woff2")`
 *
 * 整个改写一次完成,保留原始格式声明、CSS 语法(逗号 / 大括号 / 引号)不动。
 *
 * 抽成纯函数以便测试 —— vitest 下 `?inline` import 与 prod build 行为不一致
 * (返回空),真正在 prod 走 prod 这条路,测试只验转换逻辑。
 *
 * url() 路径形式多样(必须都处理):
 *   - `url(fonts/KaTeX_AMS-Regular.woff2)` —— 原始 katex.min.css
 *   - `url(/node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2)` —— Vite dev
 *   - `url(/assets/KaTeX_AMS-Regular-Cx986IdX.woff2)` —— Vite prod build 带 hash
 *   - `url(C:/.../node_modules/katex/dist/fonts/KaTeX_AMS-Regular.woff2)` —— Vite SSR 偶尔
 * 路径前缀千变万化,匹配按**basename**对齐:`KaTeX_<NAME>[-<HASH>].woff2` → 去掉可选
 * 8 字符 Vite hash → 在 `fontDataUris` 表里查 `KaTeX_<NAME>.woff2` → 拿到 data URI。
 */
export function inlineKatexWoff2Fonts(
  css: string,
  fontDataUris: Record<string, string>,
): string {
  // 整段 src 声明匹配:从 src: 到 ; 或 } 之前。
  // 内部再 grep 找 woff2 那条 url;不依赖前缀,所以各种 Vite 改写都能命中。
  const srcRe = /src:\s*([^;}]+)/g

  return css.replace(srcRe, (match, srcValue: string) => {
    // 找 src 里 woff2 那条 url(任意路径前缀都行)
    const woff2UrlMatch = srcValue.match(/url\(\s*(['"]?)([^'")]+?\.woff2)\1\s*\)\s*format\("woff2"\)/)
    if (!woff2UrlMatch) return match

    const woff2Path = woff2UrlMatch[2]
    // basename:取最后一段(去掉路径前缀),再剥 Vite 8 字符 hash
    const basename = woff2Path.split('/').pop() ?? woff2Path
    const keyNoHash = basename.replace(/-[A-Za-z0-9_-]{8}\.woff2$/, '.woff2')

    const dataUri = fontDataUris[keyNoHash] ?? fontDataUris[basename]
    if (!dataUri) {
      // 不应发生:glob 应当覆盖 katex.min.css 引用的所有 woff2。
      // 失败时保留原 src,导出 HTML 仍能在能访问原 URL 的环境(开发 webview)工作。
      return match
    }
    return `src:url(${dataUri}) format("woff2")`
  })
}

/**
 * 生产路径:走 Vite `?raw` 拿 katex.min.css 原文,再走 `inlineKatexWoff2Fonts`
 * 改写 src。**用 `?raw` 而非 `?inline`**:Vite 的 `?inline` 在 dev / SSR 模式下
 * 返回经 CSS 插件处理过的 CSS(把 url() 改成 /node_modules/... 绝对路径或
 * `new URL(...,import.meta.url).href` JS 表达式),这两类形态的"url"都不是
 * 普通字符串,简单 regex 匹配不到;只有 `?raw` 完全绕开 Vite 的 CSS 流水线,
 * 返回原文件 byte-for-byte 文本(url(fonts/...) 原样保留)。模块顶层
 * import.meta.glob 已在 build / dev 阶段把所有 woff2 拿到 base64 data URI 串,
 * 函数内只做字符串 replace,无 I/O。
 */
export async function loadKatexCssWithFontsInlined(): Promise<string> {
  const css = (await import('katex/dist/katex.min.css?raw')).default
  return inlineKatexWoff2Fonts(css, katexWoff2DataUris)
}

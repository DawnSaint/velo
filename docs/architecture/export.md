# Export Architecture

> **本文件负责**: HTML/PDF 导出管线、mdast walker、DOMPurify、KaTeX 字体、shiki/mermaid 导出与 Tauri PrintToPDF。
>
> **何时阅读**: 改 `lib/export/*`、`stores/export.ts`、PDF Rust command、导出样式或新增 mdast node 输出时。
>
> **先记住**:
> - 导出复用 markdownIO 的 unified pipeline，必须 `processor.runSync(processor.parse(md))`。
> - walker 未显式 case 的 mdast node 会静默丢失；新增语法必须补 walker + CSS。
> - DOMPurify 配置需与 `HtmlNodeView.ts` 同步。
> - 导出 DOM class 名要与 editor NodeView verbatim 对齐，样式才会命中。
> - Windows PDF 必须 `SetShouldPrintBackgrounds(true)`，KaTeX 字体必须 inline。
>
> **相关文件**: [架构索引](../ARCHITECTURE.md) / [编辑器](./editor.md) / [Tauri](./tauri.md)


## 禁令速查

- 导出不要只 `parse(md)`，必须 `runSync`。
- 行内 raw HTML 不要孤立 sanitize，先合并再 sanitize。
- DOMPurify 配置改一处必须同步另一处。
- 新增 mdast node 类型不要假设 walker 会自动递归 children。
- PDF 新建窗口必须在 async command 里做。

## 设计要点

- **导出管线**: `lib/export/htmlRenderer.ts` 复用 `markdownIO.ts` 的同一份 unified pipeline(8 个 remark 插件)parse 出 mdast,自写轻量 walker 转 HTML 字符串,**不走 ProseMirror doc**(省去 PM doc → mdast 二次桥接)。**必须 `processor.runSync(processor.parse(md))` 而非只 `parse`** —— transformer 类插件(remarkAlert/remarkHighlight/remarkEncodeLinkUrls)在 run 阶段才执行(见下方"导出必须 runSync")。节点逐个 dispatch:code lang='mermaid' 走 mermaidHtml、其他 code 走 shikiHtml(复用 `CodeBlockLangs` 的 getHighlighterSync/getTokensSync,与编辑器 `CodeHighlightWidget` 同套 API 保证配色一致)、math 走 katexHtml(失败降级 `<span class="math-error">`)、html 走 sanitizeHtml(DOMPurify,配置与 `HtmlNodeView.ts` 同步,见下方"导出 DOMPurify 配置必须同步")、行内 html 先 `mergeHtmlInlineRunsMdast` 合并再 sanitize(见下方"行内 raw HTML 必须先合并再 sanitize")、image src 走 `convertFileSrc` 转 `asset://`(外部浏览器不解析——已知限制)、inline marks 嵌套、list 抽首段 paragraph 解包避免 `<li><p>` 割裂、alert → `<div class="velo-alert velo-alert-{variant}">`(对齐 editor schema toDOM,不包 blockquote)、table 标准化、**[TOC] 独占段落 → `<div class="velo-toc">` 嵌套目录**(headings 整篇预扫,链接用 `<a href="#slug">` 走原生锚点跳转)、**YAML frontmatter (`yaml` 节点) → `''` 剥离**(元数据非内容,walker 显式返回空串)。降级:mermaid/katex/shiki 任一失败 → 原文/`math-error` + 收进 `warnings`,不中断。Dual theme token 仍写双 hex,dark 靠 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)` 接管(同 GitHub README 自适应);`@media print` 强制 light 给 PDF 用。**KaTeX 字体 inline base64**(`katexCss.ts` 走 `import.meta.glob` 把 20 个 woff2 inline,改写 `@font-face` src,否则相对 `url(fonts/...)` 在导出环境解析不到 → 字体回退,见下方"导出 KaTeX 字体必须 inline")

- **PDF 路径**: 不走 `iframe + window.print()` 弹系统对话框,改走 Tauri `with_webview` 调平台原生 PrintToPDF,与 Typora / Obsidian 同款静默写盘 UX。链路:前端 `invoke('export_pdf', { outputPath, html })` → Rust `pdf::export_pdf`(`src-tauri/src/pdf.rs`)新建 `visible(false)` 隐藏打印窗口(label `velo-pdf-printer-<n>`,`PRINTER_ID` 自增)→ `with_webview` 拿平台 handle → **Windows(完整实现,`pdf_windows.rs`)** cast `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`(`SetShouldPrintBackgrounds(true)` 必开,默认不打印背景),NavigationCompleted 后发起 PrintToPdf,`oneshot` 桥接 async;**macOS / Linux** 当前返回 `PdfError::Unsupported`。HTML 靠 `navigate("data:text/html;base64,...")`(需 tauri `webview-data-url` feature);`PRINT_LOCK` 全局 `tokio::Mutex` 防并发,30s 超时兜底;打印完 `printer.close()`。**走隐藏窗口而非主 webview**:`Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 所在 JS 上下文,弹不出反馈且回不来(见下方“PDF 走隐藏打印窗口而非主 webview”)

- **store (`stores/export.ts`)**: `exportDocument()` 调 `saveDialog` 多 filter(HTML / PDF),按扩展名 dispatch:`.html` → `buildExportHtml` + `writeTextFile`;`.pdf` → `invoke('export_pdf', { outputPath, html })`。**reentrant 守门**(`exporting.value` 期间第二次调用立刻返回);成功/失败弹原生 `message`(故 Rust 端走隐藏打印窗口保主 webview 活着);**不**改 `currentFilePath`/`lastSavedContent`/`fs:watch` —— 导出是"产出一份静态文件",与"切换到那个文件继续编辑"是不同语义(见 DECISIONS ADR-20260621-001)


---

## 维护者注意点

- **导出 DOMPurify 配置必须与 `HtmlNodeView.ts` 同步**: `lib/export/sanitizeHtml.ts` 的 `PURIFY_CONFIG` 与 `nodes/HtmlNodeView.ts` 字段一致(FORBID_TAGS / FORBID_ATTR / ALLOWED_URI_REGEXP);任一处变更两处同步改。后续可抽 `src/lib/sanitizeConfig.ts` 共用
- **PDF 走隐藏打印窗口而非主 webview**: `Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 上下文,弹不出反馈且应用回不来;隐藏窗口让主应用全程不动。初始 URL 选 `about:blank`(tauri-runtime-wry 对其特判为"不设初始 URL",避免"初始页 vs data URL"两个 NavigationCompleted 竞态)。Windows: cast `ICoreWebView2_7` 拿 PrintToPdf、cast `ICoreWebView2Environment6` 拿 CreatePrintSettings(v1 环境没这方法);`SetShouldPrintBackgrounds(true)` 必开(默认不打印背景,alert SVG / 代码块底色 / 暗色底全丢)。HTML 注入靠 `navigate("data:text/html;base64,...")`(需 `webview-data-url` feature)。`PRINT_LOCK` 防并发,30s 超时兜底。**新建窗口必须在 async command 里做**(`WebviewWindowBuilder::build` 从同步 command / 事件 handler 调会死锁);**闭包不能 self-reference**(webview7/settings 必须 move 进 handler)。macOS / Linux 待实现
- **行内 raw HTML 必须先合并再 sanitize**: remark 把 `<kbd>Mod</kbd>` 拆成 html/text/html 3 个 mdast 节点,孤立开标签被 DOM parser 自动闭合成 `<kbd></kbd>` → `Mod` 游离到标签外。编辑器(`markdownIO.ts:mergeHtmlInlineRuns`)/导出(`htmlRenderer.ts:mergeHtmlInlineRunsMdast`)各走一个标签栈状态机(开标签 push、闭标签 pop、栈空 flush)合并成整段再一次性 sanitize,两份逻辑刻意同构,改一处同步另一处。**已知限制(两侧一致)**:HTML 区域内夹带 mark(emphasis/strong/link 等)会丢,保 mark 需重写成 span tree,留后续
- **导出必须 `runSync(parse(md))` 不能只 `parse`**: unified 的 `parse()` 只跑 parser,transformer 类插件(remarkAlert/remarkHighlight/remarkEncodeLinkUrls,返回 `tree => {...}`)在 `run()`/`runSync()` 阶段才执行。只 parse 会导致 alert 仍是 blockquote、`==高亮==` 不生效、链接 URL 空格不 encode。修复后导出与 editor `fromMarkdown` 同形:`processor.runSync(processor.parse(md) as Root)`。`remarkGfm` 不受影响(同时注册 micromark 扩展,parse 期生效)。`remarkPreserveEmptyLine` 是 parser 拦截,注入的 `<br />` 空段占位由 walker `isEmptyBrPlaceholder` 兜成 `''`,加 runSync 不改变
- **Windows PDF 必须开 `SetShouldPrintBackgrounds(true)`**: WebView2 `ICoreWebView2_7::PrintToPdf` 默认 `ShouldPrintBackgrounds=false`,不打印任何 `background-color`/`background-image`(alert `::before` SVG 图标、shiki 代码块底色、表格条纹、暗色底全丢)。`CreatePrintSettings()` 后必须调该 setter;设置失败不致命,best-effort `let _ =` 忽略。导出 HTML 的 `@media print` 把底色翻 light 供 PDF 用,前提就是背景会被打印。导出 task list `<li>` 挂 `class="velo-task-item"`(exportStyles.scss 给 `list-style:none`)去默认 disc 圆点 —— editor 侧靠 `li[data-item-type="task"]` 去圆点,导出走 native `<input type="checkbox">`,用 class 单独兜
- **导出 DOM class 名必须与 editor NodeView verbatim 一致**: 导出样式来源是 `_editor-*.scss` 经 `@forward` 注入 `exportStyles.scss`,前提是 walker 输出 DOM 的 class 名跟 editor NodeView 一致;class 跑偏 → 样式落空(踩坑:footnote `footnote-ref-node` vs `footnote-ref`)。规约:加 NodeView / 重命名 class 时,grep `class="...` 看 export 侧 walker 写的类名,两边字符串 verbatim 一致。**非原生控件(task checkbox / 自定义折叠箭头等)editor / export DOM 形态必然不同**:editor 靠 `data-item-type` / `.task-content` 等选择器,导出走 native `<input>`,那些规则不命中 —— 要么在 `exportStyles.scss` 末尾补 export-only 覆盖规则,要么改 walker 复刻 editor DOM,不要假设 @forward 进来就有了
- **导出脚注 def 对齐编辑器 flex 三段**: `_footnote.scss` 把 `.footnote-definition` 写成 `display:flex` 三段(`.footnote-label` 标号 + `.footnote-content` 描述 + `.footnote-backref` 回链 ↩)+ `.footnote-content > p { display:inline; margin:0 }` 拉平首段。导出 walker 必须输出同款 class/id:`<div class="footnote-definition" id="velo-fn-{slug}">...</div>`。**ref 端类名有意拆开**:导出是静态 `<sup><a href="#...">label</a></sup>`,套编辑器 `.footnote-ref-node` 的 contentEditable 专有样式(cursor/outline/user-select/:focus)无意义或冲突,所以 walker 走单独的 `.footnote-ref` class;`_footnote.scss` 必须有 `.footnote-ref` 块镜像 `.footnote-ref-node` 视觉(主色 + hover 高亮 + border-radius/font-size),`.footnote-ref a` 显式 `color:inherit; text-decoration:none`。`htmlRenderer.test.ts` 的 SCSS 源断言守住这条规则。slug 用 `label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'`(大小写敏感保留、非 ASCII 替 `_`,**不能**复用 heading slugify 的 toLowerCase)
- **blockquote 必须 reset `margin:0`**: 浏览器默认 `blockquote { margin: 1em 40px }`,那 40px 让 border-left 离行头 40px(引用线右偏)。`_editor-typography.scss` 只设 `padding` 没 reset margin。导出 HTML / 编辑器内一并修(共用同一份 typography partial)
- **导出内部锚点 fragment 必须同源 slugify**: heading id 走 `slugify()`,外部浏览器把 href 字面空格 url-encode 成 `%20` 作 fragment,两边对不上 → HTML 点了没效果、PDF 不可点击(编辑器内 ctrl+click 有 `linkClick.ts:scrollToAnchor` 运行时 fallback,导出静态 HTML 没这层)。修法:导出 `case 'link'` 在 decode 后若 `href.startsWith('#')`,把 fragment 喂同款 `slugify()` 重写;**外部 URL fragment 不动**(远端 id 由远端决定)。规约:heading id 与内部链接 fragment 必须出自同一个 slugify 函数
- **导出 KaTeX 字体必须 inline**: katex.min.css 里 `@font-face` 引用 `url(fonts/KaTeX_*.{woff2,woff,ttf})`,编辑器侧 Vite side-effect import 会改写 url();但**导出走 `?inline` 拿 CSS 原文,Vite 不改 url()**,导出旁无 `fonts/` → 字体回退。`lib/export/katexCss.ts` 顶层 `import.meta.glob` 拿 20 个 woff2 base64 data URI,`inlineKatexWoff2Fonts` 把每条 `@font-face` 的 src 改写成单条 woff2 data URI 并 strip woff/ttf(现代浏览器含 WebView2 首选 woff2,后两条只是 fallback;只 inline woff2 压到 ~340KB 而非全部 60 文件 ~1.3MB)。vitest 走纯函数 `inlineKatexWoff2Fonts(css, fontMap)` 验转换逻辑(`?inline` 在 vitest 与 prod build 行为不一致返回空)
- **新增暗色规则要两处同步**: editor 走 `_editor-dark.scss` 的 `:is(.dark .velo-editor, .velo-editor.dark)`(Vue 控制 `<html class="dark">`),export 走 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)`(**自写副本,不 forward `_editor-dark.scss`**,导出 HTML 无 `.velo-editor.dark` 依赖)。两套语义不等价:导出只跟系统暗色偏好走,不能跟应用内 toggle 走。新增暗色规则必须两边写
- **新增 mdast node 类型必须改 walker + CSS**: 导出 walker 的 `mdastNodeToHtml` switch `default: return ''` **静默丢节点**(无 warn 无错误)—— 任何 mdast 类型 walker 不显式 case,导出 HTML 直接消失。规约:新增自定义 mdast type = walker 加 case + 输出 DOM + class 名跟 editor NodeView 一致(联动“导出 DOM class 名必须与 editor NodeView verbatim 一致”);新增 block 容器类型(children-recurse,类似 alert/blockquote)也要加专门 case 内部 `node.children.map(mdastNodeToHtml)`,**不要假设 walker 会自动递归未知 children** —— walker 只对已知 case 递归。checklist:加新 syntax 同时 grep `case '` 看 walker 是否覆盖

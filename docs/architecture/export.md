# Export Architecture

> **本文件负责**：HTML / PDF / DOCX 导出管线、mdast walker、DOMPurify、KaTeX 字体、shiki / mermaid 导出、SVG 光栅化与 Tauri PrintToPDF。
>
> **何时阅读**：改 `lib/export/*`、`stores/export.ts`、PDF Rust command、导出样式或新增 mdast node 输出时。
>
> **代码入口**：`src/lib/export/{htmlRenderer,docxRenderer,svgRaster,katexHtml,mermaidHtml,shikiHtml,sanitizeHtml,katexCss,fontFaceCss}.ts`、`src/lib/export/exportStyles.scss`、`src/components/ExportPanel.vue`、`src/stores/export.ts`、`src-tauri/src/{pdf,pdf_windows}.rs`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [编辑器](./editor.md) · [Tauri 架构](./tauri.md)

## 红线

- **导出必须 `processor.runSync(processor.parse(md))`**，不能只 `parse` —— transformer 类插件在 `run` 阶段才执行。
- **walker 未显式 case 的 mdast node 会静默丢失**（`default: return ''`，无 warn）；新增 mdast type 必须改 walker + CSS，并 grep `case '` 确认覆盖。
- **DOMPurify 配置改一处必须同步 `HtmlNodeView.ts`**（`FORBID_TAGS` / `FORBID_ATTR` / `ALLOWED_URI_REGEXP`）。
- **行内 raw HTML 必须先 `mergeHtmlInlineRunsMdast` 合并再 sanitize**，不要孤立开标签。
- **导出 DOM class 名必须与 editor NodeView verbatim 一致**，否则 `@forward` 进来的样式落空。
- **PDF 新建窗口必须在 async command 里做**；闭包不能 self-reference（webview7 / settings 必须 move 进 handler）。
- **Windows PDF 必须 `SetShouldPrintBackgrounds(true)`**，否则 alert SVG / 代码块底色 / 暗色底全丢。
- **PDF 的 HTML 必须走本地文件 + asset 协议，不能走 data URL**：WebView2/Chromium 对 data: URL 主文档有 ~2MB 上限，导出 HTML 内联字体后必然超限（`Navigate` 报 `0x80070057`）。asset 协议三处配置必须一致 —— config `assetProtocol.enable` + `scope: ["**"]`、CSP 含 `http://asset.localhost`、Rust 侧按 `convertFileSrc` 同构规则拼 URL；少一处就静默 403 / 拒绝访问。
- **导出内部锚点 fragment 必须与 heading id 同源 `slugify()`**，外部 URL fragment 不动。
- **KaTeX 字体必须 inline base64**，导出环境无 `fonts/` 目录。
- **新增暗色规则 editor / export 两处同步**（编辑器走 class，导出走 `@media (prefers-color-scheme: dark)`）。

## 架构

### 导出管线

`buildExportHtml`（`htmlRenderer.ts`）复用 `markdownIO.ts` 的同一份 unified pipeline parse 出 mdast，自写轻量 walker（`mdastNodeToHtml`）转 HTML 字符串，**不走 ProseMirror doc**（省二次桥接）。

节点 dispatch：

| mdast node | 输出 |
| --- | --- |
| `code` (lang=mermaid) | `mermaidHtml`（失败降级原文）；`inlineAssets` 时 `svgRaster` 光栅化 SVG→PNG（docx 的 SVG PNG fallback 是 1×1 占位，失败降级回内联 SVG + warning） |
| `code` (其他) | `shikiHtml`（复用 `CodeBlockLangs` 的 `getHighlighterSync` / `getTokensSync`，与编辑器 `CodeHighlightWidget` 同套 API） |
| `math` | `katexHtml`（失败降级 `<span class="math-error">`） |
| `html` | `sanitizeHtml`（DOMPurify，配置与 `HtmlNodeView.ts` 同步） |
| 行内 html | 先 `mergeHtmlInlineRunsMdast` 合并再 sanitize |
| `image` | 默认 `convertFileSrc` 转 `asset://`（外部浏览器不解析 —— 已知限制）；`inlineAssets` 时读文件转 data URI（DOCX 自包含，失败降级 + warning） |
| `list` | 抽首段 paragraph 解包，避免 `<li><p>` 割裂 |
| `alert` | `<div class="velo-alert velo-alert-{variant}">`（对齐 schema toDOM，不包 blockquote） |
| `[TOC]` 独占段落 | `<div class="velo-toc">` 嵌套目录（headings 整篇预扫，`<a href="#slug">` 走原生锚点） |
| `yaml` / `toml` | `''` 剥离（元数据非内容） |
| `footnoteDefinition` | `<div class="footnote-definition" id="velo-fn-{slug}">` 三段 flex（见「关键取舍」） |

- **降级**：mermaid / katex / shiki 任一失败 → 原文 / `math-error` + 收进 `warnings`，不中断。
- **dual theme token** 仍写双 hex，dark 靠 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)` 接管（同 GitHub README 自适应）；`@media print` 强制 light 给 PDF 用。
- **CSS 来源**：`exportStyles.scss` `@forward` 编辑器 `_editor-*.scss` partials + `buildFontFaceCss()`。
- **内嵌字体按需内联（v0.7.16）**：`buildFontFaceCss(fontFamily, fontMono)` 只内联两个 font-family 栈里实际命中的内嵌字体族（`resolveBundledFamilies` 从逗号分隔的 CSS 栈解析，大小写敏感匹配 `BUNDLED_FONTS` 注册名）。原先 `buildAllFontFaceCss()` 无条件内联全部 8 款（~5.2MB base64），用户没选中的字体纯属浪费；典型场景降到 ~0.5MB。`buildAllFontFaceCss()` 保留作测试对照基准与未来「全量内联」选项的挂载点。**已知取舍**：HTML 导出换一台没装该字体的机器打开会回退到系统字体（原先全量内联保证跨机器一致）。PDF / DOCX 不受影响 —— PDF 渲染的就是用户本机；DOCX 的 `htmlToContent` 显式丢弃 `@font-face`（见 `docx/dist/html.mjs` 注释），本来只用 font-family 名字。

### PDF 路径

不走 `iframe + window.print()` 弹系统对话框，改走 Tauri `with_webview` 调平台原生 PrintToPDF（Typora / Obsidian 同款静默写盘 UX）。

链路：前端 `invoke('export_pdf', { outputPath, html })` → Rust `pdf::export_pdf`（`src-tauri/src/pdf.rs`）把 HTML 写到 `app_cache_dir/velo-export/<label>.html`，转成 `http://asset.localhost/<percent-encoded-path>` 后 `Navigate` 进新建的 `visible(false)` 隐藏打印窗口（label `velo-pdf-printer-<n>`）→ `with_webview` 拿平台 handle → **Windows（完整实现，`pdf_windows.rs`）** cast `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`，NavigationCompleted 后发起 PrintToPdf，`oneshot` 桥接 async；**macOS / Linux** 当前返回 `PdfError::Unsupported`。`PRINT_LOCK` 全局 `tokio::Mutex` 防并发，30s 超时兜底；打印完 `printer.close()` + 删临时 HTML。

**为什么走隐藏窗口而非主 webview**：`Navigate(asset:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 所在 JS 上下文，弹不出反馈且应用回不来。初始 URL 选 `about:blank` —— tauri-runtime-wry 对其特判为「不设初始 URL」，避免「初始页 vs asset URL」两个 NavigationCompleted 竞态。

**为什么 HTML 必须走本地文件 + asset 协议，不能用 data URL**：WebView2/Chromium 对 **data: URL 主文档有 ~2MB 上限**（`NavigateToString` 明确 2MB），而导出 HTML 内联了 KaTeX（~340KB b64）+ 8 款内嵌字体（~5MB b64，见 `_fonts.scss`），必然超限 —— 早期实现用 `Navigate("data:text/html;base64,...")`，实测直接报 `Navigate: 拒绝访问 (0x80070057)`。asset 协议走 wry 的 custom protocol workaround：`http://asset.localhost/<encoded-path>` 被 `WebResourceRequested` filter 拦截 → revert 回真实路径 → tauri asset handler `File::open` 读盘，无大小限制。前置条件三处一致（见红线）：config `assetProtocol.enable` + `scope: ["**"]`、CSP 含 `http://asset.localhost`、Rust 侧按前端 `convertFileSrc` 同构规则构造 URL。

**临时文件落 cache 目录而非系统 temp**：`app_cache_dir/velo-export/` 随应用卸载 / 用户清缓存自然回收，不污染文档目录；asset scope 是 `**`，cache 目录天然在授权范围内。每次导出写 `<label>.html`（label 自增唯一），导出结束（成败都）`remove_file`，失败静默（缓存目录有系统兜底）。

### DOCX 路径

`docxRenderer.ts` 的 `buildExportDocx` 复用 `buildExportHtml`（`inlineAssets: true`）拿到自包含 HTML，再喂 `docx` 的 `htmlToContent`（`docx/html` 子路径）转 OOXML，`Packer.toBlob` 出字节。选它的理由是实测保真度最高（见 `docs/research/export-more.md` §1.3 / §2.8）：`htmlToContent` 读 `<style>` 与内联 `style`，CSS 变量 `var(--x, fallback)` 也能解析（取第一个可用值），Velo 导出 HTML 的 shiki 高亮 / alert 底纹边框 / KaTeX OMML / 脚注 / 内部锚点都能带过去。

**`inlineAssets` 的两个适配**（`ExportOptions.inlineAssets`，默认 false）：

- **图片**：`htmlToContent` 不下载任何图片，`asset://` 在它眼里就是 missing-image 直接丢。DOCX 模式下读本地文件转 `data:{mime};base64`；失败降级回 `convertFileSrc` + warning。远程 URL（`http(s)` / `data:`）不动。
- **mermaid**：Velo 输出内联 SVG，`htmlToContent` 会写成 `image1.svg` + 一个 PNG fallback —— 但那个 PNG 是 **1×1 透明占位符**（docx 的 `TRANSPARENT_PIXEL`，它自己不做光栅化）。Word 能显示 SVG，WPS 等不支持 SVG 的查看器打开就是空白。`svgRaster.ts` 在 DOCX 模式用 canvas 把 SVG 光栅化成真 PNG（2× 缩放，白底，`--pele-*` 变量固定取 light 值）；失败降级回内联 SVG + warning。

**懒加载**：`docx` 是 20MB 级包，`stores/export.ts` 用 `loadExportDocx()` 动态 import 推迟到首次导出，不进主 bundle。

### store 与内置导出面板

`stores/export.ts` 的 `openExportPanel()` 打开内置 `ExportPanel`（`src/components/ExportPanel.vue`，App.vue 挂载）：用户先选类型（PDF / Word / HTML）+ 确认文件名，确认后 `confirmExportPanel()` → `exportDocument(type, name)`。这样**类型选择内置化**，系统 `saveDialog` 只负责「存哪」，不再兼管「存成什么」（原先要先开系统框才能切 filter）。

`exportDocument(type, name)` 按类型锁死 `saveDialog` filter、默认路径后缀与类型一致，再按扩展名 dispatch：`.html` → `buildExportHtml` + `writeTextFile`；`.docx` → `buildExportDocx` + `writeFile`（二进制）；`.pdf` → `invoke('export_pdf', { outputPath, html })`。程序化调用仍可直接 `exportDocument(type)`（默认 pdf），面板只是 UI 前置。

**入口三处统一走面板**：顶栏「文件」菜单的导出项、命令面板「导出」、快捷键 `Ctrl+Shift+E` 都调 `openExportPanel()`（不再各自直接导出）。HTML / DOCX 走 `loadExportHtml` / `loadExportDocx` 懒加载模块（katex 字体 ~845KB + docx 包不常驻主 bundle）。**reentrant 守门**（`exporting.value` 期间第二次调用立刻返回）；成功 / 失败弹原生 `message`（故 Rust 端走隐藏打印窗口保主 webview 活着）；**不**改 `currentFilePath` / `lastSavedContent` / `fs:watch` —— 导出是「产出一份静态文件」，与「切换到那个文件继续编辑」是不同语义（见 DECISIONS ADR-20260621-004）。

**面板范围**：四项 —— `PDF` / `Word` / `HTML` / `PDF 预览`。前三项仍是「类型 + 文件名 → `saveDialog` 选路径」。第四项 `pdf-preview` 不是格式而是入口：确认后打开 `PdfPreviewPanel`，纸张大小 / 页边距 / 字号 / 行距 / 页眉页脚 / 页码 / 暗色版式参数在预览面板自己的侧栏，调完点「导出 PDF」才走 `saveDialog` + 前端 `writeFile`。旧 `PDF` 项保持 PrintToPdf 纯导出语义，不受影响。决策与实测见 `docs/research/pdf-preview.md` 附录 C / D。

## PDF 预览 / 导出（Display List 双后端）

`src/lib/export/pdfPreview/` 是一条与 PrintToPdf **并行**的链路：纯 TS 布局，不调 Rust、不依赖 WebView2 / Chromium 打印，三平台行为一致。

```
markdown ─ unified(runSync) ─ mdast
   ├─ buildFontSet()    文档字符集 → wawoff2 解压 → hb-subset(wasm) → opentype.js
   │                    → 三套子集 TTF + 运行时 fontmap（installFontSet 注入）
   ├─ buildFragments()  KaTeX / mermaid / shiki / 图片 / raw HTML → RichFragment
   └─ buildBlocks()     块级 IR（行内 run 序列，尚未断行）
            │
        relayout(opts)  ← 同步，改边距 / 字号 / 行距只走这一步
            │
        PdfDocument.pages: PdfPage[]  (DisplayOp[])
            ├─ previewRenderer.ts  → 绝对定位 DOM（分页画布）
            └─ pdfWriter.ts        → PDF 内容流 + CIDFontType2 字体
```

- **一致性来源是同一棵布局树**，不是同一个慢引擎。预览与导出消费完全相同的 `PdfPage.ops`。
- **两段式**：`buildPdf()` 只做一次（解析 mdast + 异步渲染富片段），按内容 hash 缓存最多 4 份；`relayout()` 是同步纯计算，实测 sample.md 首次布局 ~8ms、改边距 + 字号重排 ~4–5ms、DOM 绘制 ~17ms（`renderAllPages` 一次画**全部页**，未做可见页虚拟化）。dev 下 `buildPdf()` ~1.65s（shiki / KaTeX 模块加载 + 公式位图化）、`serializePdf()` ~257ms；正文变化才重新 `buildPdf()`（180ms 防抖）。
- **字体（运行时子集化，`fontSubset.ts`）**：无 Python 脚本、无提交的静态字体资产。`buildPdf()` 阶段从文档全文 + 版式字面量收集字符集，走 `项目自带 woff2 → wawoff2(wasm 解压) → hb-subset(wasm 子集化) → opentype.js 解析` 生成三套子集 TTF + 运行时 fontmap（`installFontSet` 注入 `tokens.ts`）。**生僻字不再缺字**（字符集随文档走，不再焊死 GB2312 一级）；fontmap 是子集 TTF 的派生数据，不存在人工同步漂移。子集结果按字符集 hash 缓存 4 份；完整 woff2 解压只做一次。**两处 wasm 堆约束**：wawoff2 是单实例共享堆，三套解压必须**串行**且每套完成后立刻 `slice()` 出独立副本（并行会让先完成者的输出缓冲区被后续调用覆盖，实测首套 sfnt 头部变垃圾数据）；hb-subset 同理三套串行子集化，`heap()` 视图在 `malloc` 之后现取（ALLOW_MEMORY_GROWTH 下 malloc 可能 detach 旧 ArrayBuffer）。**wawoff2 加载不走官方 `decompress.js` 包装**（`woff2Decode.ts`）：其 emscripten binding 只在 `ENVIRONMENT_IS_NODE` 分支写 `module.exports = Module`，Vite 预构建按浏览器环境执行时返回空 exports，包装把 `onRuntimeInitialized` 注册到空对象上 → runtimeInit 永久悬挂 → 面板卡「重排中…」（dev / 生产构建都会踩）。修法：`?raw` 拿 binding 源码用 `new Function` 受控执行，Module 对象身份自持 + 执行后立即注册回调（`calledRun` 兜底同步完成、15s 超时兜底异常）。实测（Node spike）：3888 字全流程首次 ~250ms / 热态 ~130ms，gid / 字宽 / ascent / descent 与 fontTools 产物完全一致。回归测试 `pdfPreview/__tests__/fontSubset.test.ts` 在 vitest 里跑**真实 wasm**（mock 的只是 ?url 资产 fetch）：字符集收集 / 子集自洽 / 生僻字覆盖 / 回退链 / 缓存 / writePdf 字节同源与 ToUnicode 可逆，16 例。PDF 侧仍是 `Type0 / Identity-H` + `CIDFontType2` + `/W` + `/CIDToGIDMap /Identity` + `FontFile2` + `ToUnicode CMap`，文字是 PDF text 算子，可选中 / 可搜索 / 可复制。**文本测量不用 `measureText`**，布局查运行时 fontmap 字形宽度表（纯计算，三平台一致）。预览 `@font-face` 指向子集 TTF 的 blob URL，与 PDF `FontFile2` 嵌入**同一份字节**。新增依赖：`harfbuzzjs`（取 hb-subset.wasm ~668KB，?url 懒加载）+ `wawoff2`（wasm base64 内嵌 ~315KB）+ `opentype.js`（~516KB），全部在 pdfPreview 懒加载 chunk 内，不进主 bundle；hb-subset 胶水自写 ~80 行（`subset-font` 包协议同款，但该包依赖 node:fs 不能进浏览器）。**顺序约束**：`buildFragments` 里 mermaid 的 `svgToPdf` 会调 `glyph()`，必须先 `installFontSet` 再渲染富片段；多文档 IR 缓存命中时 `relayout` 前重新 install 对应字体集，防度量串台。
- **富片段三档**：mermaid SVG 走 B 档 `svgToPdf()` 转矢量（图内文字仍是 text 算子，可搜索）；shiki 代码块走 C 档按 token 颜色出 TextOp（文本层 100% 保留）；KaTeX / 块级 raw HTML 走 A 档 `foreignObject` 位图。图片走 `/Image XObject` + `/DCTDecode`。
- **A 档在 `buildPdf()` 阶段一次完成，预览直接显示同一张位图**：宽松画布（四周 40px bleed、2× 物理像素）渲染后扫描非背景像素求真实包围盒并裁剪，`previewEl` 就是该 JPEG 的 `<img>`，`RichFragment.image` 是同一份字节，导出不再二次光栅化。原因是 KaTeX 的 `.pstrut` / `.strut` 是零宽零高却落在 `top:-40~-60px` 的纯布局撑杆，隐藏 MathML 与 SVG `<path>` 又各自带回几千 px 的假矩形，叠加 base64 字体异步加载让测量量到 fallback 字宽 —— 靠「后代 `getBoundingClientRect()` 并集」推断视觉盒会同时**虚增高度、算小宽度**，导致预览和导出各自裁掉不同部分（行内公式缺 `mc²`、块级公式末行被切）。`foreignObject` 不可用时才退回惰性光栅化 + DOM 预览兜底。
- **坐标系**：DisplayOp 统一用「页面左上角原点、y 向下」的 pt；`pdfWriter` 做 `pageHeight - y` 翻转，`previewRenderer` 直接当 CSS 坐标。B 档内容流在 `svgToPdf` 内已翻成 y 向上，外层只需正缩放 `q sx 0 0 sy x y cm` —— 负 d 会把文字整体镜像，是 SVG→PDF 最容易踩的坑。
- **已知差异（放宽约束后允许）**：与 `buildExportHtml` 的分页位置、行盒细节不完全一致；KaTeX / raw HTML 位图放大有损且公式文字不可选中（公式改矢量的可行性评估见 `docs/research/pdf-katex-vector-spike.md`，结论：可做但独立排期，未实施）；图内文字用子集字体度量，与浏览器字形宽度有细微差别。缺字回退：任务勾选符等先走同形替换（`☑→✓` 等，mono），其余按首选字体 → sans → mono，仍缺则 `?` 并进面板的「字库缺字」列表（运行时子集化后，缺字只剩「三套字库本身都没有的字符」，如部分 emoji）。**暗色限制**：build 缓存 key 不含 `dark`，KaTeX / raw HTML 位图按首次 build 时的主题烘焙，面板内切「暗色版式」只翻转文本 / 线条令牌，位图片段不重渲染。禁则（避头尾）、`break-inside: avoid`、orphans/widows 未实现；pdfPreview 已有字体链路回归测试（`fontSubset.test.ts`）与脚注版式回归（`footnote.test.ts`），富片段 / 逐页对照仍无测试。

## 关键取舍

- **必须 `runSync(parse(md))`**：unified 的 `parse()` 只跑 parser，transformer 类插件（`remarkAlert` / `remarkHighlight` / `remarkEncodeLinkUrls`，返回 `tree => {...}`）在 `run()` / `runSync()` 阶段才执行。只 parse 会导致 alert 仍是 blockquote、`==高亮==` 不生效、链接 URL 空格不 encode。`remarkGfm` 不受影响（同时注册 micromark 扩展，parse 期生效）。`remarkPreserveEmptyLine` 是 parser 拦截，注入的 `<br />` 空段占位由 walker `isEmptyBrPlaceholder` 兜成 `''`。
- **行内 raw HTML 必须先合并再 sanitize**：remark 把 `<kbd>Mod</kbd>` 拆成 html/text/html 3 个 mdast 节点，孤立开标签被 DOM parser 自动闭合成 `<kbd></kbd>` → `Mod` 游离到标签外。编辑器（`markdownIO.ts:mergeHtmlInlineRuns`）/ 导出（`htmlRenderer.ts:mergeHtmlInlineRunsMdast`）各走一个标签栈状态机（开标签 push、闭标签 pop、栈空 flush）合并成整段再一次性 sanitize，两份逻辑刻意同构，改一处同步另一处。**已知限制（两侧一致）**：HTML 区域内夹带 mark（emphasis / strong / link 等）会丢，保 mark 需重写成 span tree，留后续。
- **导出 DOM class 名必须与 editor NodeView verbatim 一致**：导出样式来源是 `_editor-*.scss` 经 `@forward` 注入 `exportStyles.scss`，前提是 walker 输出 DOM 的 class 名跟 editor NodeView 一致；class 跑偏 → 样式落空（踩坑：footnote `footnote-ref-node` vs `footnote-ref`）。**非原生控件（task checkbox / 自定义折叠箭头等）editor / export DOM 形态必然不同**：editor 靠 `data-item-type` / `.task-content` 等选择器，导出走 native `<input>`，那些规则不命中 —— 要么在 `exportStyles.scss` 末尾补 export-only 覆盖规则，要么改 walker 复刻 editor DOM，不要假设 `@forward` 进来就有了。
- **导出脚注 def 对齐编辑器 flex 三段**：`_footnote.scss` 把 `.footnote-definition` 写成 `display:flex` 三段（`.footnote-label` 标号 + `.footnote-content` 描述 + `.footnote-backref` 回链 ↩）+ `.footnote-content > p { display:inline; margin:0 }` 拉平首段。导出 walker 必须输出同款 class / id。**ref 端类名有意拆开**：导出是静态 `<sup><a href="#...">label</a></sup>`，套编辑器 `.footnote-ref-node` 的 contentEditable 专有样式（cursor / outline / user-select / :focus）无意义或冲突，所以 walker 走单独的 `.footnote-ref` class；`_footnote.scss` 必须有 `.footnote-ref` 块镜像 `.footnote-ref-node` 视觉，`.footnote-ref a` 显式 `color:inherit; text-decoration:none`。`htmlRenderer.test.ts` 的 SCSS 源断言守住这条规则。slug 用 `label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'`（大小写敏感保留、非 ASCII 替 `_`，**不能**复用 heading slugify 的 toLowerCase）。
- **blockquote 必须 reset `margin:0`**：浏览器默认 `blockquote { margin: 1em 40px }`，那 40px 让 border-left 离行头 40px（引用线右偏）。`_editor-typography.scss` 只设 `padding` 没 reset margin，导出 HTML / 编辑器内一并修（共用同一份 typography partial）。
- **导出内部锚点 fragment 必须同源 slugify**：heading id 走 `slugify()`，外部浏览器把 href 字面空格 url-encode 成 `%20` 作 fragment，两边对不上 → HTML 点了没效果、PDF 不可点击（编辑器内 ctrl+click 有 `linkClick.ts:scrollToAnchor` 运行时 fallback，导出静态 HTML 没这层）。修法：导出 `case 'link'` 在 decode 后若 `href.startsWith('#')`，把 fragment 喂同款 `slugify()` 重写；**外部 URL fragment 不动**（远端 id 由远端决定）。
- **导出 KaTeX 字体必须 inline**：`katex.min.css` 里 `@font-face` 引用 `url(fonts/KaTeX_*.{woff2,woff,ttf})`，编辑器侧 Vite side-effect import 会改写 `url()`；但**导出走 `?inline` 拿 CSS 原文，Vite 不改 `url()`**，导出旁无 `fonts/` → 字体回退。`katexCss.ts` 顶层 `import.meta.glob` 拿 20 个 woff2 base64 data URI，`inlineKatexWoff2Fonts` 把每条 `@font-face` 的 src 改写成单条 woff2 data URI 并 strip woff / ttf（现代浏览器含 WebView2 首选 woff2；只 inline woff2 压到 ~340KB 而非全部 60 文件 ~1.3MB）。vitest 走纯函数 `inlineKatexWoff2Fonts(css, fontMap)` 验转换逻辑（`?inline` 在 vitest 与 prod build 行为不一致返回空）。
- **新增暗色规则要两处同步**：editor 走 `_editor-dark.scss` 的 `:is(.dark .velo-editor, .velo-editor.dark)`（Vue 控制 `<html class="dark">`），export 走 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)`（**自写副本，不 forward `_editor-dark.scss`**，导出 HTML 无 `.velo-editor.dark` 依赖）。两套语义不等价：导出只跟系统暗色偏好走，不能跟应用内 toggle 走。
- **Windows PDF 必须开 `SetShouldPrintBackgrounds(true)`**：WebView2 `ICoreWebView2_7::PrintToPdf` 默认 `ShouldPrintBackgrounds=false`，不打印任何 `background-color` / `background-image`（alert `::before` SVG 图标、shiki 代码块底色、表格条纹、暗色底全丢）。`CreatePrintSettings()` 后必须调该 setter；设置失败不致命，best-effort `let _ =` 忽略。导出 task list `<li>` 挂 `class="velo-task-item"`（`exportStyles.scss` 给 `list-style:none`）去默认 disc 圆点 —— editor 侧靠 `li[data-item-type="task"]` 去圆点，导出走 native `<input type="checkbox">`，用 class 单独兜。
- **PDF 的 HTML 不能走 data URL**：WebView2/Chromium 对 data: URL 主文档有 ~2MB 上限（`NavigateToString` 明确 2MB），而导出 HTML 内联字体后远超此限（改按需内联前是 ~5.2MB b64），`Navigate` 直接返回 `0x80070057`（E_INVALIDARG），表现为「导出失败:PrintToPdf failed: Navigate: 拒绝访问」。修法：HTML 写 `app_cache_dir/velo-export/<label>.html`，用 `http://asset.localhost/<percent-encoded-path>` 导航。wry 在 Windows 上把自定义 scheme 改写成 `{scheme}://{protocol}.localhost/...`，并用 `WebResourceRequested` filter 拦截后 revert 回真实路径交给 tauri asset handler `File::open`。三处配置必须一致（config `assetProtocol.enable` + `scope: ["**"]`、CSP 含 `http://asset.localhost`、Rust 侧按 `convertFileSrc` 同构规则拼 URL），少一处就静默 403 / 拒绝访问。**排查同类问题先看报错里的 HRESULT**：`0x80070057` = E_INVALIDARG（参数超限），不是权限问题。
- **内嵌字体按需内联而非全量**：`buildFontFaceCss(fontFamily, fontMono)` 只内联实际命中的族。全量内联 8 款约 5.2MB base64，其中 Noto Sans SC 一款占 3MB —— 用户没选它纯属浪费。**注意 bundle 体积不会因此变小**：`woff2DataUris` 是模块顶层 eager glob，所有字体仍进导出 chunk；按需减少的是导出 HTML 产物体积。真要减 bundle 得改惰性 fetch（每次导出多 20+ 次 fetch + 转码，取舍见 `katexCss.ts` 同段说明）。匹配逻辑放 `fontFaceCss.ts` 内部而非复用 `utils/fontStacks.ts`：后者是 UI 层，`src/lib/export/` 是叶模块，dep-cruiser `leaf-no-upper` 禁止反向依赖。
- **DOCX 选 `htmlToContent` 而非 mdast2docx**：后者架构更纯粹（mdast 直出、不依赖 HTML），但**丢失全部 CSS 样式**（颜色 / 底纹 / 边框 / 语法高亮全无）；`htmlToContent` 复用 Velo 已有的高质量 HTML，实测保真度最高。代价是 DOCX 质量与 `htmlRenderer` 输出强耦合 —— 改导出 HTML 的 DOM / class / CSS 会同时影响 DOCX，两类导出的样式回归要一起看。
- **PDF 列表 marker 必须矢量绘制、尺寸按 em 固定**：`li::marker` 走主色（`_editor-lists.scss`），但**不能画成 `•` 字形** —— PDF 侧 `•` 墨迹只有 0.22em（偏小），且 Chromium 的 marker 尺寸随字体度量漂移（headless 实测 `disc` 0.359em / `circle` 0.39em / `square` 0.359em，换 Arial 后 `disc` 仅 0.297em）。所以 `layoutEngine` 的 `listItem` 分支对无序列表画 `deco`（disc 填充、circle 描边，`radius = d/2`）与 `rect`（square），直径固定 `0.32 * body`、右缘到文字 `0.55 * body`，圆心对齐首行 x-height 中线（`baseline - 0.25em`）。取值依据：主编辑器参考截图实测 11px ÷ em 34.6px ≈ 0.318em、右缘间距 0.577em。**有序列表 marker 仍走 text 算子**（`1.` / `a.` / `i.`）—— 编号要可搜索 / 可复制，宽度随位数变化，不能定宽。改 marker 尺寸时同步这两个常量，不要退回字形方案。
- **DOCX 的 SVG 必须自己光栅化**：`htmlToContent` 对 SVG 的 PNG fallback 是 1×1 透明占位符（docx 无光栅化能力），WPS 打开空白。Velo 主要用户在中文环境、WPS 占比高，所以 DOCX 模式用 canvas 把 mermaid SVG 转真 PNG。光栅化固定走 light 主题（DOCX 通常白底查看，暗色图在 Word 里是黑块），`--pele-*` 变量在 `<img>` 里取不到外部 CSS，需先写进 SVG 根 style。

## 附录

- **walker 节点覆盖 checklist**：新增自定义 mdast type = walker 加 case + 输出 DOM + class 名跟 editor NodeView 一致；新增 block 容器类型（children-recurse，类似 alert / blockquote）也要加专门 case 内部 `node.children.map(mdastNodeToHtml)`，**不要假设 walker 会自动递归未知 children** —— walker 只对已知 case 递归。

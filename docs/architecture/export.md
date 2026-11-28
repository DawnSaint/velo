# Export Architecture

> **本文件负责**：HTML / PDF / DOCX / 图片(PNG / JPEG)导出管线、mdast walker、DOMPurify、KaTeX 字体、shiki / mermaid 导出、SVG 光栅化、Tauri PrintToPDF 与前端 foreignObject 图片渲染。
>
> **何时阅读**：改 `lib/export/*`、`stores/export.ts`、PDF Rust command、图片截图链路、导出样式或新增 mdast node 输出时。
>
> **代码入口**：`src/lib/export/{htmlRenderer,docxRenderer,imageRenderer,svgRaster,katexHtml,mermaidHtml,shikiHtml,sanitizeHtml,katexCss,fontFaceCss}.ts`、`src/lib/export/exportStyles.scss`、`src/components/ExportPanel.vue`、`src/stores/export.ts`、`src-tauri/src/{pdf,pdf_windows}.rs`。
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
- **图片导出走前端原生渲染，资源必须全内联**：`imageRenderer.ts` 把自包含 export HTML 塞隐藏 iframe，`XMLSerializer` 序列化后包进 SVG `foreignObject` → canvas。foreignObject 渲染 SVG-as-image **不加载外部资源**，字体 / 图片必须 data URI（`inlineAssets: true`），远程图 best-effort fetch 内联，否则空白或污染 canvas（`toBlob` 抛 SecurityError）。
- **canvas 尺寸上限跨平台不一致，必须自适应缩放**：Safari / 旧 WKWebView 桌面 canvas 面积上限长期 16.7MP（4096×4096），超了 `getContext` 返回 null / 出空白；Chromium 桌面 ~268MP / 32767 边。不能写死 2×：先试 2×，撑不下就降倍率重试 —— Windows 满 2× 高清，受限引擎优雅降级但整篇完整（不裁切）。
- **图片配色按 app `darkMode` 强制**：渲染 iframe 的 `@media (prefers-color-scheme: dark)` 只认系统主题，app 亮 + 系统暗会导出暗图。`buildExportHtml` 的 `forceColorScheme` 把该媒体查询改写成恒命中 / 恒不命中（同 PDF `@media print` 强制 light 的思路）。
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
- **内嵌字体按需内联**：`buildFontFaceCss(fontFamily, fontMono)` 只内联两个 font-family 栈里实际命中的内嵌字体族（`resolveBundledFamilies` 从逗号分隔的 CSS 栈解析，大小写敏感匹配 `BUNDLED_FONTS` 注册名）。字体资产走 `?url` 复用 `_fonts.scss` 的 `.woff2` 产物，导出时仅对命中族并行 `fetch` 转 base64 并做模块级缓存，避免在导出 chunk 中重复打包一份 ~5MB Base64 副本。`buildAllFontFaceCss()` 保留作测试对照基准与未来「全量内联」选项的挂载点。**已知取舍**：HTML 导出换一台没装该字体的机器打开会回退到系统字体；PDF / DOCX 不受影响 —— PDF 渲染的就是用户本机，DOCX 的 `htmlToContent` 显式丢弃 `@font-face`（见 `docx/dist/html.mjs` 注释）。

### PDF 路径

不走 `iframe + window.print()` 弹系统对话框，改走 Tauri `with_webview` 调平台原生 PrintToPDF（Typora / Obsidian 同款静默写盘 UX）。

链路：前端 `invoke('export_pdf', { outputPath, html })` → Rust `pdf::export_pdf`（`src-tauri/src/pdf.rs`）把 HTML 写到 `app_cache_dir/velo-export/<label>.html`，转成 `http://asset.localhost/<percent-encoded-path>` 后 `Navigate` 进新建的 `visible(false)` 隐藏打印窗口（label `velo-pdf-printer-<n>`）→ `with_webview` 拿平台 handle → **Windows（完整实现，`pdf_windows.rs`）** cast `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`，NavigationCompleted 后发起 PrintToPdf，`oneshot` 桥接 async；**macOS / Linux** 当前返回 `PdfError::Unsupported`。`PRINT_LOCK` 全局 `tokio::Mutex` 防并发，30s 超时兜底；打印完 `printer.close()` + 删临时 HTML。

**为什么走隐藏窗口而非主 webview**：`Navigate(asset:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 所在 JS 上下文，弹不出反馈且应用回不来。初始 URL 选 `about:blank` —— tauri-runtime-wry 对其特判为「不设初始 URL」，避免「初始页 vs asset URL」两个 NavigationCompleted 竞态。

**为什么 HTML 必须走本地文件 + asset 协议，不能用 data URL**：WebView2/Chromium 对 **data: URL 主文档有 ~2MB 上限**（`NavigateToString` 明确 2MB），而导出 HTML 内联了 KaTeX（~340KB b64）+ 8 款内嵌字体（~5MB b64，见 `_fonts.scss`），必然超限 —— 早期实现用 `Navigate("data:text/html;base64,...")`，实测直接报 `Navigate: 拒绝访问 (0x80070057)`。asset 协议走 wry 的 custom protocol workaround：`http://asset.localhost/<encoded-path>` 被 `WebResourceRequested` filter 拦截 → revert 回真实路径 → tauri asset handler `File::open` 读盘，无大小限制。前置条件三处一致（见红线）：config `assetProtocol.enable` + `scope: ["**"]`、CSP 含 `http://asset.localhost`、Rust 侧按前端 `convertFileSrc` 同构规则构造 URL。

**临时文件落 cache 目录而非系统 temp**：`app_cache_dir/velo-export/` 随应用卸载 / 用户清缓存自然回收，不污染文档目录；asset scope 是 `**`，cache 目录天然在授权范围内。每次导出写 `<label>.html`（label 自增唯一），导出结束（成败都）`remove_file`，失败静默（缓存目录有系统兜底）。

### DOCX 路径

`docxRenderer.ts` 的 `buildExportDocx` 复用 `buildExportHtml`（`inlineAssets: true`）拿到自包含 HTML，再喂 `docx` 的 `htmlToContent`（`docx/html` 子路径）转 OOXML，`Packer.toBlob` 出字节。选它的理由是实测保真度最高（见 DECISIONS ADR-20261114-001）：`htmlToContent` 读 `<style>` 与内联 `style`，CSS 变量 `var(--x, fallback)` 也能解析（取第一个可用值），Velo 导出 HTML 的 shiki 高亮 / alert 底纹边框 / KaTeX OMML / 脚注 / 内部锚点都能带过去。

**`inlineAssets` 的两个适配**（`ExportOptions.inlineAssets`，默认 false）：

- **图片**：`htmlToContent` 不下载任何图片，`asset://` 在它眼里就是 missing-image 直接丢。DOCX 模式下读本地文件转 `data:{mime};base64`；失败降级回 `convertFileSrc` + warning。远程 URL（`http(s)` / `data:`）不动。
- **mermaid**：Velo 输出内联 SVG，`htmlToContent` 会写成 `image1.svg` + 一个 PNG fallback —— 但那个 PNG 是 **1×1 透明占位符**（docx 的 `TRANSPARENT_PIXEL`，它自己不做光栅化）。Word 能显示 SVG，WPS 等不支持 SVG 的查看器打开就是空白。`svgRaster.ts` 在 DOCX 模式用 canvas 把 SVG 光栅化成真 PNG（2× 缩放，白底，`--pele-*` 变量固定取 light 值）；失败降级回内联 SVG + warning。

**懒加载**：`docx` 是 20MB 级包，`stores/export.ts` 用 `loadExportDocx()` 动态 import 推迟到首次导出，不进主 bundle。

### 图片路径(PNG / JPEG)

`buildExportHtml`（`inlineAssets: true` 自包含 + `forceColorScheme` 按 app 主题强制配色）→ 前端 `renderExportImage`（`src/lib/export/imageRenderer.ts`）→ `writeFile` 写二进制。**纯前端、跨平台、异步**，不建 OS 窗口、不碰 Rust UI 线程（编辑器不卡）。链路：

1. **隐藏 iframe 原生渲染**：自包含 HTML 走 `srcdoc` 塞进屏幕外 iframe，用浏览器原生 CSS 引擎渲染 —— 样式与主编辑器同源（`exportStyles.scss` `@forward` 编辑器 SCSS），像素级一致。等 `document.fonts.ready` + 所有 `<img>.complete`；远程图 best-effort fetch 成 data URI（foreignObject 不加载外部资源）。
2. **foreignObject 光栅化**：量 `scrollHeight`，`XMLSerializer` 把 iframe 文档序列化成良构 XHTML，包进 `<svg><foreignObject>`，加载成 `Image`（同 `svgRaster.ts` 的 SVG→Image→canvas 范式）。
3. **自适应倍率编码**：`drawImage` 到 canvas → `toBlob` 出 PNG / JPEG。先试 2×，引擎 canvas 撑不下（`getContext` null / `toBlob` 空）就降倍率重试（红线：Safari 旧版 16.7MP 上限）。Windows / Chromium 拿满 2×，受限引擎优雅降级但整篇完整。

**为什么放弃 Rust 离屏窗口 + CapturePreview**：只支持 Windows、走 UI 线程卡编辑器、约 10s。两条降采样弯路也试过都不行（`SetRasterizationScale` 被系统 DPI 锁死；CSS transform scale 让居中 body 比捕获区宽、右侧被裁）。前端原生渲染同时满足跨平台 / 快 / 不卡 / 样式一致，故退役 Rust 路径（`image.rs` / `image_windows.rs` 已删）。

**限制**：受引擎 canvas 上限约束，超长文档在受限引擎（旧 WKWebView）会自动降倍率（分辨率下降但完整）；Chromium 桌面 ~268MP / 32767 边内满 2×。远程图取不到时可能空白（best-effort 内联失败不中断）。

### store 与内置导出面板

`stores/export.ts` 的 `openExportPanel()` 打开内置 `ExportPanel`（`src/components/ExportPanel.vue`，App.vue 挂载）：用户只需选类型（PDF / Word / HTML / 图片），确认后 `confirmExportPanel()` → `exportDocument(type)`。这样**类型选择内置化**，系统 `saveDialog` 负责「存哪 + 文件名叫什么」（原先要先开系统框才能切 filter；文件名输入从面板移到了系统框）。面板的关闭语义：**只有「取消」能关**（点空白 / Esc 不关）；确认导出时面板保持打开（系统保存框 + 导出中），**成功才自动关**；导出中两个按钮都禁用、主按钮显示 spinner —— 且 loading 只在系统保存框返回路径后（真正开始导出）出现。

`exportDocument(type, name)` 按类型锁死 `saveDialog` filter、默认路径后缀与类型一致，再按扩展名 dispatch：`.html` → `buildExportHtml` + `writeTextFile`；`.docx` → `buildExportDocx` + `writeFile`（二进制）；`.pdf` → `invoke('export_pdf', { outputPath, html })`；图片 → `renderExportImage`（前端 iframe + foreignObject + canvas）+ `writeFile`。程序化调用仍可直接 `exportDocument(type)`（默认 pdf），面板只是 UI 前置。

**图片是唯一不锁死 filter 的类型**：`saveDialog` 给 PNG / JPEG 两个 filter，用户可在系统保存框里切换格式，最终按选中路径的扩展名 dispatch（`jpg/jpeg` → jpeg，其余 png；无图片扩展名补 `.png`）。

**图片导出成功提示带「打开预览」动作**：成功 Toast（`notify` store）除文字外可挂可选 `action`（下划线按钮，`ToastContainer.vue` 渲染）；仅图片类型传 `{ label: '打开预览', onClick }` → `previewExportedImage(absPath)` → 复用全局 lightbox（文件树点击图片 / 资产面板右键同一套 `useImagePreviewStore.open([{ url: convertFileSrc(absPath), name: basenameOfPath(absPath), absPath }])`），直接看刚落盘的长图；点击后 toast 自动关闭避免挡住浮层。其它类型维持纯告知。

**入口三处统一走面板**：顶栏「文件」菜单的导出项、命令面板「导出」、快捷键 `Ctrl+Shift+E` 都调 `openExportPanel()`（不再各自直接导出）。HTML / DOCX 走 `loadExportHtml` / `loadExportDocx` 懒加载模块（katex 字体 ~845KB + docx 包不常驻主 bundle）。**reentrant 守门**（`exporting.value` 期间第二次调用立刻返回）；成功 / 失败弹 Toast（`notify` store）—— PDF 在 Rust 端走隐藏打印窗口也是为保主 webview 活着，见上；**不**改 `currentFilePath` / `lastSavedContent` / `fs:watch` —— 导出是「产出一份静态文件」，与「切换到那个文件继续编辑」是不同语义（见 DECISIONS ADR-20260621-004）。

**面板范围**：五项 —— `PDF` / `Word` / `HTML` / `图片` / `PDF 预览`。前四项仍是「类型 + 文件名 → `saveDialog` 选路径」（图片项在系统框里可切 PNG / JPEG）。第五项 `pdf-preview` 不是格式而是入口：确认后打开 `PdfPreviewPanel`，纸张大小 / 页边距 / 字号 / 行距 / 页眉页脚 / 页码 / 暗色版式参数在预览面板自己的侧栏，调完点「导出 PDF」才走 `saveDialog` + 前端 `writeFile`，导出中按钮 loading、成功后自动关闭预览（失败保持打开可改参数重试）。旧 `PDF` 项保持 PrintToPdf 纯导出语义，不受影响。选型决策见 DECISIONS ADR-20261119-001。

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
- **两段式**：`buildPdf()` 只做一次（解析 mdast + 异步渲染富片段），按内容 hash 缓存最多 4 份；`relayout()` 是同步纯计算，实测 sample.md 首次布局 ~8ms、改边距 + 字号重排 ~4–5ms、DOM 绘制 ~17ms（`renderAllPages` 一次画**全部页**，未做可见页虚拟化）。dev 下 `buildPdf()` 冷启动 ~1.6s（shiki / KaTeX / wasm 模块加载），热态 ~0.4–0.5s（含公式 DOM 测量 + KaTeX 按需子集化）、`serializePdf()` ~260ms；正文变化才重新 `buildPdf()`（180ms 防抖）。
- **字体（动态字体栈 + 双通道运行时子集化，`fontSubset.ts` + `src-tauri/src/fonts.rs`）**：无 Python 脚本、无提交的静态字体资产。`buildPdf()` 按 `PdfSource.fontFamily / fontMono`（跟随编辑器字体设置，缺省回退 Noto Sans SC + JetBrains Mono）解析 CSS 栈，逐族分配尚未覆盖的字符并生成动态槽位 `FontSet { slots, chains }`（`installFontSet` 注入 `tokens.ts`，`FONT_RES` 顺序分配 `/F1..Fn`，公式字体紧随其后）：
  - **打包字体通道**（`src/fonts/**/*.woff2`，全部 10 族按需 `?url` 加载）：走 `woff2 → wawoff2(wasm 解压) → hb-subset(wasm 子集化) → opentype.js 解析`，产物保留 `cmap`，PDF 嵌入与预览 `@font-face` 共用同一份子集字节。**两处 wasm 堆约束**：wawoff2 是单实例共享堆，解压必须**串行**且完成后立刻 `slice()` 脱离堆；hb-subset 同理串行，`heap()` 视图在 `malloc` 之后现取（ALLOW_MEMORY_GROWTH 下 malloc 可能 detach 旧 ArrayBuffer）。**wawoff2 加载不走官方 `decompress.js` 包装**（`woff2Decode.ts`）：其 emscripten binding 只在 `ENVIRONMENT_IS_NODE` 写 `module.exports`，Vite 预构建按浏览器执行时返回空 exports → `onRuntimeInitialized` 永久悬挂；修法为 `?raw` 源码 + `new Function` 受控执行自持 Module（`calledRun` + 15s 超时兜底）。
  - **系统字体 & 缺字兜底 & Type3 彩色字形通道**（`src/tauri/fonts.ts` → Rust `fonts.rs` + `color_fonts.rs`）：经进程内 `OnceLock<fontdb::Database>` 查询系统字体并用 `ttf-parser` + `subsetter` 在 Rust 侧直接按文档字符集子集化 + 算度量，只跨 IPC 传几十 KB 子集 TTF（避免传输 18–70MB 完整系统字体；TTC 拆单 face 因共享 `glyf` 表几乎不减体积）。主字体栈均未覆盖的剩余字符再走 `fallback_subset_system_fonts` 补齐兜底槽位 `fb:N`（彩色 emoji 字体优先于单色符号字体，非 Tauri 环境静默跳过并回退打包字体 + 同形替换）。命中含 `COLR` v0/v1 矢量或 `sbix`/`CBDT` PNG 位图的彩色字形时，由 `color_fonts.rs` 按最多 255 字符/片提取为 PDF `Type3` 字体数据（`CharProcs` + `ExtGState` 透明度 + `Shading` Type 2/3 渐变 + `FlateDecode` RGB/SMask 位图），`pdfWriter` 与 `svgToPdf` 自动按槽位类型发单字节 `<XX> Tj` 并附 `/ToUnicode` CMap（含非 BMP UTF-16BE 代理对），保证彩色 emoji 在导出 PDF 中全彩显示且可选中 / 可搜索 / 可复制。**`subsetter` 约束**：单色子集产物刻意移除 `cmap` 表，仅供 PDF `CIDFontType2` 嵌入；系统字体（含 Type3 彩色 emoji）的 DOM 预览由 `previewRenderer` 直接用本机 `font-family`（`SubsetFont.previewCss`）渲染，与编辑器同源。
  - PDF 侧普通字体是 `Type0 / Identity-H` + `CIDFontType2` + `/W` + `/CIDToGIDMap /Identity` + `FontFile2` + `ToUnicode CMap`，彩色字体是 `/Subtype /Type3` + `/FontMatrix [0.001 0 0 0.001 0 0]` + `/CharProcs` + `/ToUnicode`；文字均是真 PDF text 算子，可选中 / 可搜索 / 可复制；文本测量查运行时 fontmap（纯计算），按字符集 + 字体栈 hash 缓存 4 份。**顺序约束**：`buildFragments` 里 mermaid 的 `svgToPdf` 会调 `encodeMixed()`，必须先 `installFontSet` 再渲染富片段；多文档 IR 缓存命中时 `relayout` 前重新 install 对应字体集，防度量串台。
- **富片段档位**：mermaid SVG 走 B 档 `svgToPdf()` 转矢量（图内文字仍是 text 算子，可搜索）；**pele 用 CSS 变量着色，PDF 不解析 `var()`，必须先按 SVG 内 fallback 静态展开**（否则整图黑块 —— 与 DOCX 光栅化、任何非 CSS 消费方同源坑）；shiki 代码块走 C 档按 token 颜色出 TextOp（文本层 100% 保留）；**KaTeX 公式走矢量**（见下条），块级 raw HTML 仍走 A 档 `foreignObject` 位图（KaTeX 转换失败时也回退这条）。图片走 `/Image XObject` + `/DCTDecode`。
- **KaTeX 矢量（DOM 实测提取，`katexVector.ts`）**：不手写 KaTeX 依赖的浏览器 CSS 排版语义（vlist / 字号级联 / spacing / `overflow:hidden` / svgGeometry），而是把 `katex.renderToString` 的结果挂进离屏容器，让 Chromium / WebKit 自己排，再用 `Range.getBoundingClientRect()` 逐字形、`getComputedStyle` 取字体 / 字号 / 颜色、SVG 分支按 `viewBox` + `preserveAspectRatio`（含 `slice`）映射 path/line/rect、HTML 分支取 `border-*` 与背景色。**10× 字号测量再 ÷10**：1× 下 `min-height:1px` 之类规则会引入取整误差。产物是 `{texts, paths, rects}`（pt、y 向上、原点为公式基线左端），存 `RichFragment.formula`；预览直接画这份算子（与 PDF 内容流同源），导出由 `pdfWriter` 发真 text/path/rect 算子。**字体按需 N 套**：收集公式实际用到的族（Main/Math/AMS/Size1-4/Caligraphic/…）走既有 `woff2 → wawoff2 → hb-subset → opentype.js` 链路（源是 `katexCss` 已内联的 base64 data URI，不新增打包资产），经 `tokens.installFormulaFonts` 注入，`pdfWriter` 从 `/F4` 起注册资源。缺字 / 遇到未适配 SVG 形状（`circle` / `use` / 带 transform 的 `g`）时**回退 A 档位图**并记 warning，与 mermaid 双编码器同策略。`\text{中文}` 这类被 KaTeX 分到 `KaTeX_Main` 但字库无字形的字符回退正文 sans（浏览器侧原本落系统 serif，属近似）。
- **公式坐标与两个渲染端的对偶**：formula 算子是「基线系 y 向上」，片段盒高 = `height + depth`，基线在盒内 `h - depth` 处。PDF 外层 `q sx 0 0 sy x bottom cm` + 内层 `q 1 0 0 1 0 depth cm` 原样铺设（`srcW/srcH == w/h`，sx=sy=1）；预览按 `y_down = (h - depth) - cy` 换算，路径整体走 `translate(0, h-depth) scale(1,-1)`、文字逐字绝对定位。**两个必须记住的坑**：① PDF 路径算子没有相对形式（`m/l/c` 全是绝对），而 SVG path 的小写命令是相对语义 —— 预览把算子转 `d` 时必须翻成大写；② `.katex` 盒不含 SVG 溢出（`\overbrace` / 大号可伸缩分隔符），预览的公式盒必须 `overflow:visible`，否则 brace 顶部被裁。
- **A 档在 `buildPdf()` 阶段一次完成，预览直接显示同一张位图**：宽松画布（四周 40px bleed、2× 物理像素）渲染后扫描非背景像素求真实包围盒并裁剪，`previewEl` 就是该 JPEG 的 `<img>`，`RichFragment.image` 是同一份字节，导出不再二次光栅化。raw HTML 与公式回退都走这里。`foreignObject` 不可用时才退回惰性光栅化 + DOM 预览兜底（此时 `previewEl` 是真实 DOM、`contentOffset` 非零）。
- **坐标系**：DisplayOp 统一用「页面左上角原点、y 向下」的 pt；`pdfWriter` 做 `pageHeight - y` 翻转，`previewRenderer` 直接当 CSS 坐标。B 档内容流在 `svgToPdf` 内已翻成 y 向上，外层只需正缩放 `q sx 0 0 sy x y cm` —— 负 d 会把文字整体镜像，是 SVG→PDF 最容易踩的坑。
- **已知差异（放宽约束后允许）**：与 `buildExportHtml` 的分页位置、行盒细节不完全一致；raw HTML 位图（含公式回退）放大有损且文字不可选中；图内文字 / 公式字形用子集字体度量，与浏览器字形宽度有细微差别。缺字回退：任务勾选符等先走同形替换（`☑→✓` 等，mono），其余按首选字体 → sans → mono，仍缺则 `?` 并进面板的「字库缺字」列表（运行时子集化后，缺字只剩「字库本身就没有的字符」，如部分 emoji）。**公式矢量边界**：`.katex` 盒不含 SVG 溢出，片段盒高可能低估（预览已放开 overflow，行距不会为 `\overbrace` 这类上溢额外撑开）；`\text{中文}` 用正文 sans 而非浏览器系统 serif；`\displaystyle` / `mhchem` 等长尾命令未逐一回归（P0 spike 覆盖 12 类复杂字形 + 端到端样张验证）。**暗色限制**：build 缓存 key 不含 `dark`，raw HTML 位图按首次 build 时的主题烘焙，面板内切「暗色版式」只翻转文本 / 线条令牌，位图片段不重渲染（公式矢量天然和墨水颜色走提取时的计算色）。禁则（避头尾）、`break-inside: avoid`、orphans/widows 未实现；pdfPreview 已有字体链路 / 脚注版式 / 纸张尺寸 / 链接注解 / 行内 HTML / 代码缩进 / 公式矢量发射等回归测试（`pdfPreview/__tests__/`），富片段 / 逐页对照仍无测试；长文档（>100 页）、macOS / Linux 实机、Acrobat / 打印 RIP 兼容性未验证。

## 关键取舍

- **必须 `runSync(parse(md))`**：unified 的 `parse()` 只跑 parser，transformer 类插件（`remarkAlert` / `remarkHighlight` / `remarkEncodeLinkUrls`，返回 `tree => {...}`）在 `run()` / `runSync()` 阶段才执行。只 parse 会导致 alert 仍是 blockquote、`==高亮==` 不生效、链接 URL 空格不 encode。`remarkGfm` 不受影响（同时注册 micromark 扩展，parse 期生效）。`remarkPreserveEmptyLine` 是 parser 拦截，注入的 `<br />` 空段占位由 walker `isEmptyBrPlaceholder` 兜成 `''`。
- **行内 raw HTML 必须先合并再 sanitize**：remark 把 `<kbd>Mod</kbd>` 拆成 html/text/html 3 个 mdast 节点，孤立开标签被 DOM parser 自动闭合成 `<kbd></kbd>` → `Mod` 游离到标签外。编辑器（`markdownIO.ts:mergeHtmlInlineRuns`）/ 导出（`htmlRenderer.ts:mergeHtmlInlineRunsMdast`）各走一个标签栈状态机（开标签 push、闭标签 pop、栈空 flush）合并成整段再一次性 sanitize，两份逻辑刻意同构，改一处同步另一处。**已知限制（两侧一致）**：HTML 区域内夹带 mark（emphasis / strong / link 等）会丢，保 mark 需重写成 span tree，留后续。
- **导出 DOM class 名必须与 editor NodeView verbatim 一致**：导出样式来源是 `_editor-*.scss` 经 `@forward` 注入 `exportStyles.scss`，前提是 walker 输出 DOM 的 class 名跟 editor NodeView 一致；class 跑偏 → 样式落空（踩坑：footnote `footnote-ref-node` vs `footnote-ref`）。**非原生控件（task checkbox / 自定义折叠箭头等）editor / export DOM 形态必然不同**：editor 靠 `data-item-type` / `.task-content` 等选择器，导出走 native `<input>`，那些规则不命中 —— 要么在 `exportStyles.scss` 末尾补 export-only 覆盖规则，要么改 walker 复刻 editor DOM，不要假设 `@forward` 进来就有了。
- **导出代码块要去掉空 header 条**：editor 的 `.velo-code-block:not(.velo-code-has-header)` 会画一条预留 header（`::before` + padding-top），与仅 editor 存在的 CodeHighlightWidget（语言名 / chevron / 复制按钮）共用高度、保证有 / 无 header 两态外框等高；导出 walker 只输出裸 `<pre>`（无 widget 无 class），这条就是纯空条。`exportStyles.scss` 末尾有 export-only 覆盖（去 `::before` + padding-top 归位），**改代码块样式时别把这条覆盖弄丢**（htmlRenderer.test.ts 有 SCSS 源断言）。
- **导出脚注 def 对齐编辑器 flex 三段**：`_footnote.scss` 把 `.footnote-definition` 写成 `display:flex` 三段（`.footnote-label` 标号 + `.footnote-content` 描述 + `.footnote-backref` 回链 ↩）+ `.footnote-content > p { display:inline; margin:0 }` 拉平首段。导出 walker 必须输出同款 class / id。**ref 端类名有意拆开**：导出是静态 `<sup><a href="#...">label</a></sup>`，套编辑器 `.footnote-ref-node` 的 contentEditable 专有样式（cursor / outline / user-select / :focus）无意义或冲突，所以 walker 走单独的 `.footnote-ref` class；`_footnote.scss` 必须有 `.footnote-ref` 块镜像 `.footnote-ref-node` 视觉，`.footnote-ref a` 显式 `color:inherit; text-decoration:none`。`htmlRenderer.test.ts` 的 SCSS 源断言守住这条规则。slug 用 `label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'`（大小写敏感保留、非 ASCII 替 `_`，**不能**复用 heading slugify 的 toLowerCase）。
- **blockquote 必须 reset `margin:0`**：浏览器默认 `blockquote { margin: 1em 40px }`，那 40px 让 border-left 离行头 40px（引用线右偏）。`_editor-typography.scss` 只设 `padding` 没 reset margin，导出 HTML / 编辑器内一并修（共用同一份 typography partial）。
- **导出内部锚点 fragment 必须同源 slugify**：heading id 走 `slugify()`，外部浏览器把 href 字面空格 url-encode 成 `%20` 作 fragment，两边对不上 → HTML 点了没效果、PDF 不可点击（编辑器内 ctrl+click 有 `linkClick.ts:scrollToAnchor` 运行时 fallback，导出静态 HTML 没这层）。修法：导出 `case 'link'` 在 decode 后若 `href.startsWith('#')`，把 fragment 喂同款 `slugify()` 重写；**外部 URL fragment 不动**（远端 id 由远端决定）。
- **导出 KaTeX 字体必须 inline**：`katex.min.css` 里 `@font-face` 引用 `url(fonts/KaTeX_*.{woff2,woff,ttf})`，编辑器侧 Vite side-effect import 会改写 `url()`；但导出走 `?raw` 拿 CSS 原文，导出旁无 `fonts/` → 字体回退。`katexCss.ts` 顶层用 `import.meta.glob(..., { query: '?url' })` 复用构建产物里的 20 个 `.woff2` URL（不重复内嵌 Base64 副本），首次导出并行 `fetch` 本地内存资产转 base64 data URI 后经 `inlineKatexWoff2Fonts` 改写 `@font-face`（strip woff/ttf）并缓存结果；`loadKatexWoff2Bytes` 供 `pdfPreview` 运行时子集化直接读原始字节。vitest 走纯函数 `inlineKatexWoff2Fonts(css, fontMap)` 验转换逻辑。
- **新增暗色规则要两处同步**：editor 走 `_editor-dark.scss` 的 `:is(.dark .velo-editor, .velo-editor.dark)`（Vue 控制 `<html class="dark">`），export 走 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)`（**自写副本，不 forward `_editor-dark.scss`**，导出 HTML 无 `.velo-editor.dark` 依赖）。两套语义不等价：导出只跟系统暗色偏好走，不能跟应用内 toggle 走。
- **图片导出的配色要按 app `darkMode` 强制**：渲染 iframe 里媒体查询只认**系统**主题，app 亮 + 系统暗会导出与编辑器不一致的暗图。`buildExportHtml` 加 `forceColorScheme` 选项把 `@media (prefers-color-scheme: dark)` 改写成 `@media all` / `@media not all`（仅图片导出传）；HTML / PDF / DOCX 路径不受影响（PDF 另有 `@media print` 强制 light）。
- **图片导出选前端原生渲染而非 Rust 截图**：Rust 离屏窗口 + CapturePreview 只支持 Windows、走 UI 线程卡编辑器、约 10s，三条都不满足诉求。前端隐藏 iframe 原生渲染 export HTML（与编辑器同源 SCSS，像素级一致）+ foreignObject + canvas，纯 Web API 跨平台、异步不卡、实测整篇 ~240ms。**两条降采样弯路留作踩坑**：① `SetRasterizationScale` 被系统 DPI 锁死、只能拉高不能调低；② CSS transform scale 整体缩小会让居中 body（`.velo-editor` `margin:0 auto`）比捕获区宽、右侧被 `overflow:hidden` 裁掉。前端方案不缩放宽度（iframe 恒 880），右侧永不裁；超长靠自适应倍率适配引擎 canvas 上限（见红线）。
- **Windows PDF 必须开 `SetShouldPrintBackgrounds(true)`**：WebView2 `ICoreWebView2_7::PrintToPdf` 默认 `ShouldPrintBackgrounds=false`，不打印任何 `background-color` / `background-image`（alert `::before` SVG 图标、shiki 代码块底色、表格条纹、暗色底全丢）。`CreatePrintSettings()` 后必须调该 setter；设置失败不致命，best-effort `let _ =` 忽略。导出 task list `<li>` 挂 `class="velo-task-item"`（`exportStyles.scss` 给 `list-style:none`）去默认 disc 圆点 —— editor 侧靠 `li[data-item-type="task"]` 去圆点，导出走 native `<input type="checkbox">`，用 class 单独兜。
- **PDF 的 HTML 不能走 data URL**：WebView2/Chromium 对 data: URL 主文档有 ~2MB 上限（`NavigateToString` 明确 2MB），而导出 HTML 内联字体后远超此限（改按需内联前是 ~5.2MB b64），`Navigate` 直接返回 `0x80070057`（E_INVALIDARG），表现为「导出失败:PrintToPdf failed: Navigate: 拒绝访问」。修法：HTML 写 `app_cache_dir/velo-export/<label>.html`，用 `http://asset.localhost/<percent-encoded-path>` 导航。wry 在 Windows 上把自定义 scheme 改写成 `{scheme}://{protocol}.localhost/...`，并用 `WebResourceRequested` filter 拦截后 revert 回真实路径交给 tauri asset handler `File::open`。三处配置必须一致（config `assetProtocol.enable` + `scope: ["**"]`、CSP 含 `http://asset.localhost`、Rust 侧按 `convertFileSrc` 同构规则拼 URL），少一处就静默 403 / 拒绝访问。**排查同类问题先看报错里的 HRESULT**：`0x80070057` = E_INVALIDARG（参数超限），不是权限问题。
- **内嵌字体按需内联 + `?url` 复用资产**：`buildFontFaceCss(fontFamily, fontMono)` 只拉取并内联实际命中的族（`?url` 复用 `_fonts.scss` 产出的 `.woff2`，运行时本地 `fetch` 转 base64 + 模块级缓存），既减少导出 HTML 体积又避免在 `htmlRenderer` chunk 里重复打包 ~5MB Base64 副本。匹配逻辑放 `fontFaceCss.ts` 内部而非复用 `utils/fontStacks.ts`：后者是 UI 层，`src/lib/export/` 是叶模块，dep-cruiser `leaf-no-upper` 禁止反向依赖。
- **DOCX 选 `htmlToContent` 而非 mdast2docx**：后者架构更纯粹（mdast 直出、不依赖 HTML），但**丢失全部 CSS 样式**（颜色 / 底纹 / 边框 / 语法高亮全无）；`htmlToContent` 复用 Velo 已有的高质量 HTML，实测保真度最高。代价是 DOCX 质量与 `htmlRenderer` 输出强耦合 —— 改导出 HTML 的 DOM / class / CSS 会同时影响 DOCX，两类导出的样式回归要一起看。
- **PDF 列表 marker 必须矢量绘制、尺寸按 em 固定**：`li::marker` 走主色（`_editor-lists.scss`），但**不能画成 `•` 字形** —— PDF 侧 `•` 墨迹只有 0.22em（偏小），且 Chromium 的 marker 尺寸随字体度量漂移（headless 实测 `disc` 0.359em / `circle` 0.39em / `square` 0.359em，换 Arial 后 `disc` 仅 0.297em）。所以 `layoutEngine` 的 `listItem` 分支对无序列表画 `deco`（disc 填充、circle 描边，`radius = d/2`）与 `rect`（square），直径固定 `0.32 * body`、右缘到文字 `0.55 * body`，圆心对齐首行 x-height 中线（`baseline - 0.25em`）。取值依据：主编辑器参考截图实测 11px ÷ em 34.6px ≈ 0.318em、右缘间距 0.577em。**有序列表 marker 仍走 text 算子**（`1.` / `a.` / `i.`）—— 编号要可搜索 / 可复制，宽度随位数变化，不能定宽。改 marker 尺寸时同步这两个常量，不要退回字形方案。
- **PDF 版式令牌与编辑器 SCSS 手工对齐，无自动生成**：`pdfPreview/tokens.ts` 的颜色 / 字号 / 行高是从 `exportStyles.scss` / `_editor-*.scss` 手抄的常量表（注释声明同源），**改编辑器主题 / 排版必须手动同步该表**，否则预览 / 导出与编辑器漂移。调研期 spike 已证明手写样式模板必然漂移（样式对齐后分页仍不一致 —— 分页差是引擎级，样式差是工程级）；从 SCSS 自动生成令牌是消除方向，未实施。
- **DOCX 的 SVG 必须自己光栅化**：`htmlToContent` 对 SVG 的 PNG fallback 是 1×1 透明占位符（docx 无光栅化能力），WPS 打开空白。Velo 主要用户在中文环境、WPS 占比高，所以 DOCX 模式用 canvas 把 mermaid SVG 转真 PNG。光栅化固定走 light 主题（DOCX 通常白底查看，暗色图在 Word 里是黑块），`--pele-*` 变量在 `<img>` 里取不到外部 CSS，需先写进 SVG 根 style。

## 附录

- **walker 节点覆盖 checklist**：新增自定义 mdast type = walker 加 case + 输出 DOM + class 名跟 editor NodeView 一致；新增 block 容器类型（children-recurse，类似 alert / blockquote）也要加专门 case 内部 `node.children.map(mdastNodeToHtml)`，**不要假设 walker 会自动递归未知 children** —— walker 只对已知 case 递归。

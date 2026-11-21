# PDF 分页预览可行性评估（`#pdf-preview`）

> **后续更新**：附录 B（Typst 共享布局 IR spike）**部分修正**了第 0 节「没有任何方案」的判断 —— 增量更新实测可压到 150–270ms，但首次加载仍 ~1.5s、且与现有 Chromium 导出分页不一致，ROADMAP 决策**维持不变**。  
> **后续更新 2**：需求方随后放宽「必须与编辑器 / DOC / HTML 完全一致」的约束，改为「允许细微差异 + 不依赖 WebView2 + 三平台」，评估结论见**附录 C**（推荐纯 TS 共享 Display List 双后端；真实 PDF 导出 demo 已跑通，首次导出 ~20ms）。**第 0 节结论只在旧约束下成立**；ROADMAP 条目是否恢复属产品决策，本文不擅自改写。  
> **后续更新 3**：需求方最终要求按新方案落地。`#pdf-preview` 已恢复为完成项，实现见 `docs/architecture/export.md` 的「PDF 预览 / 导出（Display List 双后端）」。本文第 0 节结论仍是**旧约束下的正确结论**，保留作为决策留痕。  
> **对应 ROADMAP**：`#pdf-preview`（旧评估移除 → 新约束下已实现）  
> **调研日期**：2026-11-19。  
> **触发**：前一次尝试复用现有 PDF 导出管线做预览，首次加载一篇正常文档 ~5s，且改页眉 / 页间距 / 正文触发的自动更新同样慢；验收线为 ~1s。本文评估是否存在能压到 1s 的方案。
> 
>**前置约束**（来自 `docs/architecture/export.md` / `DECISIONS.md` ADR-20260621-004）：
> 
>- Velo 的 PDF 是**平台原生 PrintToPDF**（Windows `ICoreWebView2_7::PrintToPdf`），静默写盘、无对话框；macOS / Linux 当前返回 `PdfError::Unsupported`。
> - 导出 HTML 是一份自包含字符串（KaTeX ~340KB b64 + 按需内联字体 ~0.5MB + shiki/KaTeX/mermaid/DOMPurify 产物），走本地临时文件 + `asset://` 协议导航。
> - 前端零新依赖是刻意取舍，加重量级 PDF 库需重新论证。

---

### 0. 结论

根本矛盾：一份**所见即所得**的 PDF 预览必须用与最终导出**相同的排版引擎**（即 WebView2 的 PrintToPDF / Chromium print 管线）。而这个引擎是**批处理原语**——每次调用都要完整跑一遍「加载 HTML → 全文档分页 → 光栅化 → 落盘」，代价随文档长度线性增长，且被全局 `PRINT_LOCK` 串行化。它不是一个可被做成交互式预览的增量 API。

任何能把延迟压到 1s 内的替代方案，都必然换用**不同的排版机制**，于是预览结果与最终 PDF 不再保证一致——这恰好摧毁了「打印预览」存在的意义。跨平台维度上，PDF 导出本身目前只支持 Windows，预览若落地也是 Windows-only，投入产出进一步下降。

---

### 1. ~5s 花在哪里（现有管线的逐段成本）

复用 `export_pdf` 做一次预览刷新，成本链条如下（每段都随文档规模增长，且全程串行）：

1. **前端 `buildExportHtml`**：unified `parse` + `runSync` → 自写 mdast walker，逐节点跑 shiki (同步 tokenizer 初始化 / tokenize)、KaTeX、mermaid（渲染 SVG）、DOMPurify；再拼 `buildFontFaceCss` 的 ~0.5MB base64。普通文档几百毫秒量级。
2. **写多 MB 临时 HTML 到磁盘**（`prepare_export_html`）。
3. **新建隐藏 WebviewWindow**（`WebviewWindowBuilder::new(...).build()`）——这是 WebView2 最贵的一步。公开 issue 记录冷启动首次 `PrintToPdf` 可达 ~59s，复用同一 webview 后续才降到 ~0.5s（见 WebView2Feedback#1974）。
4. **`Navigate(asset_url)` + 等 NavigationCompleted**：重新解析 / 布局整份含内联字体的 HTML。
5. **`PrintToPdf`**：Chromium 完整重排 + 分页 + 光栅化整份文档。
6. **PDF 落盘 → 再加载进预览容器渲染成页**（若走 `returnAsBase64` 可省一次落盘，但仍需 PDF 解析器 + 页面渲染）。

其中 3–5 是主要耗时，且**无法只更新变化部分**——改一个页眉和重写整篇在 PrintToPDF 看来没有区别。全局 `PRINT_LOCK` 还意味着连续输入触发的多次更新会排队，尾部延迟更差。

---

### 2. 候选方案对比

| 方案                                                              | 机制                                  | 首次加载           | 更新延迟                   | 与最终 PDF 一致性                             | 代价 / 风险                                                                           | 结论                  |
| --------------------------------------------------------------- | ----------------------------------- | -------------- | ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| A. 复用现有 `export_pdf`（前次实现）                                      | 每次重建 HTML + 新建 webview + PrintToPDF | ~5s            | ~5s，且串行排队              | ✅ 完全一致                                  | 已在实践中确认过慢                                                                         | ❌ 不达标               |
| B. 常驻单个隐藏 webview + CDP `Page.printToPDF` `returnAsBase64`      | 只建一次窗口，innerHTML 更新后复用 print        | ~1–2s（省掉窗口冷启动） | 热态 ~0.5s 起 + 前端重建 HTML | ✅ 一致                                    | 仍 ~0.5s 以上的全文档分页；STA 线程 / 回调生命周期 / handler 泄漏（现有代码已留备注）全要自己扛；Windows-only；连打字都要防抖 | ⚠️ 仍不稳进 1s，复杂度和脆弱性高 |
| C. 原生 CSS Paged Media（Chrome 131+ margin box / `counter(page)`） | 用 `@page` 在浏览器里直接排版                 | 快              | 快                      | ⚠️ 仅 print 上下文生效                        | **关键限制**：分页只在打印/PDF 时发生，屏幕 webview 是连续滚动，没有可见页盒；做不出"屏幕上的分页预览"                     | ❌ 不能单独成立            |
| D. Paged.js polyfill                                            | JS 把 DOM 切成页盒，屏幕可见                  | 10 页 ~500ms–2s | 同量级，长文档退化              | ❌ 另一套排版引擎，与 PrintToPDF 结果有偏差            | 公开基准：1638 页仅 render 阶段 ~104s，且随页增长近 O(n²)；需 CJK 字体配置；新增依赖                         | ❌ 慢且不一致             |
| E. 纯 CSS「A4 高度间隔参考线」                                            | 连续滚动 + 按固定高度画分页线                    | <100ms         | <100ms                 | ❌ 参考线忽略 `break-inside` / orphans / 页眉页脚 | 不是真分页，会误导用户                                                                       | ❌ 不是分页预览            |

---

### 3. 为什么没有"两全"方案

- **一致性要求同一引擎**：导出结果由 WebView2 PrintToPDF 决定。预览要 WYSIWYG，就必须跑同一个引擎的同一套 `@page` / `@media print` / 字体 / 分页规则。方案 A / B 满足这点，但引擎是批处理的，代价降不下来。
- **快就必然换引擎**：方案 C / D / E 快，但要么不产生屏幕页盒（C），要么用不同排版引擎（D，结果不一致），要么根本不是真分页（E）。
- **跨平台缺口**：PDF 导出本身 macOS / Linux 是 `Unsupported`。预览即便做成，也只在 Windows 可用，而 ROADMAP 条目是跨平台的通用能力描述。
- **长文档放大问题**：所有全文档重排方案都随页数增长；"正常文档 5s"在长文档上只会更差，与 1s 验收线背道而驰。





### 附录 A. 非 WebView2 的 HTML→PDF 引擎评估（2026-11）

> 来源：各项目 README / 公开基准 + **本机实测**（用 Velo 真实导出的 `reference.html` 喂给各引擎，逐页栅格化比对，原始数据见 `.pdfbench/RESULTS.md`）。结论：**替代引擎大量存在，但没有任何一个能在保真度上替代现有 Chromium 导出**；不应为「脱离 WebView2」或「复活预览」而引入。

#### A.1 候选清单

| 引擎                | 机制                                       | 对 Velo HTML 的保真度                                        | CJK                         | Tauri 桌面集成                            | 成熟度          | 判定                          |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------ | --------------------------- | ----------------------------------------- | --------------- | ----------------------------- |
| WeasyPrint          | Python + Pango/Cairo，自研 CSS paged media | **最高**：CSS 2.1 全、变量、flex、grid 大部分、paged media 完整 | ✅ Pango/HarfBuzz            | ❌ 需打包 Python + Pango + GTK native libs | 成熟活跃（BSD） | 保真度够但桌面端不可行        |
| Fulgur              | Rust：Blitz → Taffy → Parley → Krilla      | 低：WPT css-page 仅 24.1%、multicol 4.7%                     | ✅ 字体子集                  | ✅ 进程内                                  | 0.x，一人项目   | 未实测，按 WPT 数据保真度不足 |
| TypePress           | 基于 Fulgur + katex-rs / mermaid-render    | 中：**需喂 Markdown 原文而非现有 HTML**；grid 降级 table、gradient 降级纯色 | ✅ 自动子集                  | ✅ ~15MB                                   | 0.4 unstable    | 等于重写导出管线              |
| jhtmltopdf          | Rust：html5ever + 自写 cascade + rayon     | **实测❌**：中文全变 `?`（1663 个）、CSS 全丢                 | ❌                           | ✅ 单二进制                                | 0.2.1           | 不可用                        |
| ironpress           | Rust 自研排版，多语言绑定                  | **实测❌**：CJK ✅ 但 KaTeX 上标/积分号丢失、块公式消失、mermaid 变黑块、CSS 退化 | ⚠️ 慢（200 CJK spans≈310ms） | ✅                                         | 1.7.0           | 不可用                        |
| html_pdf / PDFOxide | Rust 极简排版                              | 很低：无 flex / grid / float / position；PDFOxide 排除内联 SVG / MathML | ⚠️ 需自带字体                | ✅ 含 WASM                                 | 早期            | 不适合                        |
| xhtml2pdf           | 纯 Python + ReportLab                      | **实测❌**：中文全变方框、忽略 CSS 变量 + 40 个属性           | ❌                           | ✅ 无原生依赖                              | 成熟            | 不可用                        |
| dompdf.js           | TS + Rust WASM，**复用浏览器已算好的布局** | 中：文本可选可搜索、链接保留；中文明确支持                   | ✅                           | ⚠️ 依赖 DOM / 浏览器布局，非独立引擎       | ~1.7k stars     | 非独立方案                    |
| html2canvas + jsPDF | 截图式位图                                 | 低：文本不可选、体积大                                       | ✅ 截图无字体问题            | ✅                                         | 成熟            | 已在 ADR-20260621-004 否决    |

#### A.2 实测数据（sample.md，584KB 参考 HTML，A4）

| 引擎                                | cold                                                                 | warm      | 页数 | PDF 大小 |
| --------------------------------- | -------------------------------------------------------------------- | --------- | -- | ------ |
| Chrome PrintToPDF（WebView2 同引擎基线） | 1216ms                                                               | 652–835ms | 14 | 2211KB |
| jhtmltopdf 0.2.1                  | 1875ms                                                               | **85ms**  | 9  | 160KB  |
| ironpress 1.7.0                   | 12538ms                                                              | 13990ms   | 10 | 452KB  |
| xhtml2pdf 0.2.28                  | 10437ms                                                              | 5615ms    | 19 | 104KB  |
| WeasyPrint 70                     | 跑不起来：`cannot load library 'libgobject-2.0-0'`（Windows 缺 GTK runtime） | —         | —  | —      |

#### A.3 为什么仍不建议（实测确认）

- **速度不再是唯一问题，保真度才是**：jhtmltopdf warm 85ms 比 Chrome 快 ~8×，但中文全变 `?`、CSS 全丢；ironpress 中文 OK 但慢到 12–14s（CJK shaping 瓶颈，与其 README 基准一致），且 KaTeX 上标/积分号丢失、mermaid 变黑块。**快的不保真，保真的不快。**
- **「同一引擎解矛盾」在实测中不成立**：要保真就得用 Chromium 同引擎（Chrome/WebView2）；绕开它就在 CJK / KaTeX / mermaid / CSS 上退化。Velo 的导出 HTML 是为 Chromium 量身定制的，这是实测得出的硬约束。
- **分页也对不上**：同一份 HTML，Chrome 14 页 / jhtmltopdf 9 页 / ironpress 10 页 / xhtml2pdf 19 页。即便拿非 Chromium 引擎做预览，页数与分页位置也和最终导出不一致。
- **WeasyPrint 理论最优但桌面端不可行**：Windows 上缺 GTK native libs（本机实测 `libgobject-2.0-0` 加载失败），与 Tauri 单二进制分发冲突。
- **从 Markdown 重新渲染的引擎（TypePress 类）是架构级重写**：要放弃现有自包含 HTML 资产，而 HTML / DOCX 导出都复用它，牵一发动全身。

---

### 附录 B. Typst「共享布局 IR」路线 spike 实测（2026-11-19）

> **性质**：附录 A 的结论针对「换一个通用 HTML→PDF 引擎」。本附录验证的是**另一条路**：不再把 `buildExportHtml` 的自包含 HTML 当作输入，而是回到上游 **mdast**，让预览与导出共享同一棵布局 IR，各走各的后端。  
> **重要**：本附录**部分修正**了第 0 节「没有任何方案」的判断 —— 增量更新确实能压到 ~1s 以内，但**首次加载仍未达标**，且与现有 Chromium 导出的分页仍不一致。ROADMAP 决策**暂不改动**，是否重开条目需另行决策。  
> **本次 spike 未改动任何产品代码**，全部脚本与产物在 `.pdfbench/typst/`（已 gitignore）与 `C:/temp/typstspike/`。

#### B.1 架构假设

```
sample.md ── unified + Velo 自写 remark 插件 ──> mdast（布局 IR）
                                                  ├─ htmlRenderer.ts ─> 自包含 HTML ─> WebView2 PrintToPDF（现有导出）
                                                  └─ 02-walker.mjs   ─> Typst 源码 ─> Typst（Rust，预览/可选导出）
```

一致性不再由「同一个慢的 PrintToPDF 批处理」保证，而由**同一棵 mdast 树**保证。图表走独立支路：`pele` 渲染 SVG → 静态展开 CSS 变量 → Typst `#image()`。

#### B.2 输入面是封闭的（实测）

用 Velo **真实** remark 解析链（`preserveEmptyLine` / `encodeLinkUrls` / `gfm` / `strictMath` / `alert` / `highlight` / `emoji` / `frontmatter`，顺序对齐 `htmlRenderer.ts:150`）跑 `src/assets/sample.md`：

| 指标           | 值                               |
| ------------ | ------------------------------- |
| 解析耗时         | **87.15ms**                     |
| 根节点直接子节点     | 123                             |
| 节点总数         | 624                             |
| 不同节点类型       | **26**                          |
| 生成的 Typst 源码 | 23,274 bytes（含 `[TOC]` 展开 37 项） |

26 类是：root / yaml / heading / text / paragraph / html / inlineCode / code / list / listItem / strong / emphasis / delete / highlight / footnoteReference / link / image / blockquote / alert / thematicBreak / table / tableRow / tableCell / inlineMath / math / footnoteDefinition。这不是「复刻 Blink」，而是给一份已知词汇表写排版器。

#### B.3 速度实测（Typst 0.15.1 native CLI，Windows，A4）

**（1）每次新起 CLI 进程（`03-bench.mjs`）** —— 模拟「预览时调一次编译」：

| 场景           | 耗时                   | PDF         |
| ------------ | -------------------- | ----------- |
| cold / base  | 1944ms               | 1,282,338 B |
| warm ×3      | 1912 / 1959 / 1920ms | 同上          |
| 改字号 11→13pt  | 1892ms               | 1,284,351 B |
| 改左边距 16→26mm | 1871ms               | 1,281,926 B |
| 改页眉          | 1894ms               | 1,283,524 B |
| 改正文          | 1897ms               | 1,283,047 B |

改什么都是 ~1.9s ⇒ **固定开销主导**。对照：最小 hello 文档 680ms；`--ignore-system-fonts --font-path` 只省 ~350ms（1515–1563ms）。所以主要开销不是字体扫描，而是进程启动 + 首次布局 + PDF 序列化。

**（2）常驻进程（`04-watch-bench.mjs`，typst watch，comemo 增量缓存）** —— 这才是真实产品形态：

| 场景         | 端到端（含 watcher debounce + PDF 写盘） | 引擎内编译      |
| ---------- | -------------------------------- | ---------- |
| 冷启动首次      | 1791ms                           | **1340ms** |
| 改字号        | 245.1ms                          | 116.1ms    |
| 改回字号（缓存命中） | 153.0ms                          | **26.5ms** |
| 改边距        | 237.2ms                          | 111.8ms    |
| 改回边距       | 151.2ms                          | 28.8ms     |
| 改页眉        | 246.7ms                          | 123.6ms    |
| 改正文        | 251.0ms                          | 131.7ms    |
| 恢复正文       | 152.9ms                          | 30.8ms     |

**增量更新全部落在 150–270ms 端到端 / 27–132ms 引擎内**，远优于用户设定的 ~1s 线，也优于原 WebView2 方案的 ~5s。缓存命中（参数改回旧值）能到 ~30ms。

**（3）预热实验（`07-warmup.mjs`）** —— 试图消灭冷启动，**结果是否定的**：

| 场景            | 端到端          | 引擎内        |
| ------------- | ------------ | ---------- |
| app 启动时编译最小文档 | 486.9ms      | 51.3ms     |
| 预热后首次加载完整文档   | **1552.5ms** | **1430ms** |
| 随后改字号         | 268.3ms      | 132ms      |

即 1.3–1.4s 不是字体/语法集的一次性加载，而是**整份文档首次布局 + 全量 PDF 序列化**本身的成本。预热最小文档无效。

#### B.4 保真度实测

| 项目                | 结果                                                                           |
| ----------------- | ---------------------------------------------------------------------------- |
| CJK               | ✅ 正常（`Microsoft YaHei` + `Cambria`），文本层 1472 个汉字，无 `?` / 方框                  |
| 页数 / 体积           | 纯 Typst **12 页 / 1.28MB**；注入图表 **13 页 / 1.29MB**；Chrome 基线 **14 页 / 2.21MB** |
| KaTeX             | ✅ 行内 `E = mc^2`、积分公式、`\begin{aligned}` 四行对齐全部转换成功，**未识别 LaTeX 命令 0 个**       |
| 表格 / 脚注 / 代码块高亮   | ✅ 3 张表、4 条页底脚注、20 种语言 syntect 高亮                                             |
| raw HTML          | ✅ `<kbd>` 按键框、`H₂O` 下标、`x²` 上标、黄色 `<mark>`；`<br />` 空行占位按 Velo 语义丢弃          |
| alert / 引用框       | ⚠️ 结构与配色在，图标退化为文字标签                                                          |
| `[TOC]`           | ✅ 补齐后展开 37 项，首页结构与 Chrome 基线一致（比基线多列文档主标题一行）                                 |
| `<details>`       | ⚠️ 1 处降级为去标签纯文本                                                              |
| mermaid / pele 图表 | ⚠️→✅：直接注入 SVG **全黑块**；静态展开 CSS 变量后流程图、饼图颜色/箭头/百分比/中文图例全部完整                   |

**图表这个坑的根因不是排版引擎**：Velo 用的 `pele@1.13.0`（"fast, lightweight Mermaid renderer that outputs themeable SVG"）把颜色写成 `fill="var(--_s)"` 等 CSS 自定义属性，定义在根 `<svg style>`；Typst 的 resvg 不解析 CSS 变量，于是 `fill` 退化成黑色（与附录 A 里 ironpress「mermaid 变黑块」同源）。把 `var(--_X, fallback)` 静态展开（3 个 SVG 共 41 / 30 / 24 处 → 0）后即完全保真。

另外实测 `pele.render()` 在**纯 Node、无 DOM** 下 17.2ms 输出 SVG —— 图表链路本身不需要 Chrome。

#### B.5 结论与边界


- ✅ **被证实的**：共享 mdast IR + Typst 后端能让「改边距 / 字号 / 页眉 / 正文」的增量更新稳定进入 150–270ms 端到端；26 类节点可覆盖；LaTeX 转换是可枚举的有限适配层；图表可经 `pele → SVG → 变量展开` 保真回来，且无需浏览器。
- ❌ **未被证实的 / 仍不达标**：
  1. **首次加载仍 ~1.5–1.8s**，预热无效。要压到 1s 需改变输出形态（预览只绘制 display list 的可见页，不生成整份 PDF），这属于「共享 display list 双后端」的下一步，CLI spike **无法验证**。
  2. **预览与现有导出仍不一致**：Typst 13 页 / Chrome 14 页，字号、行距、断行位置、shiki 双主题配色都不同。要恢复 WYSIWYG，必须**把最终 PDF 导出也换成 Typst**，即架构级重写，且 HTML / DOCX 导出仍复用旧 HTML 资产，会形成两套排版。
- **对 ROADMAP 的建议**：不自动恢复 `#pdf-preview`。这条路线把「做不到」变成「做得到但有条件」，代价是重写导出管线 + 放弃与现有 PDF 的一致性；若产品愿意接受「预览与导出都换成 Typst」，可另开条目重新评估。第 0 节「没有任何方案」应理解为其原始语境（保持现有 Chromium 导出不变、预览必须 WYSIWYG），在该语境下结论仍成立。
- **可复现脚本**：`.pdfbench/typst/01-mdast.mjs`（真实 mdast）、`02-walker.mjs`（IR→Typst + 降级报告）、`03-bench.mjs`（CLI 四场景）、`04-watch-bench.mjs`（常驻增量）、`05-svg-inject.mjs`（图表注入）、`06-svg-fix.mjs`（CSS 变量展开）、`07-warmup.mjs`（预热）、`08-style-align.mjs`（样式对齐）。

#### B.6 样式来源：为什么 spike 的 PDF 与编辑器 / 实际导出不一样

**不是 Typst 自带的。** Typst 的默认样式极素（默认字体、11pt、heading 加粗、无页码）。spike PDF 里的目录蓝边、灰底代码块、圆角、表格描边、alert 配色、页脚页码，全部来自 `.pdfbench/typst/02-walker.mjs` 里的 `PREAMBLE` 常量 —— 那是**为了跑通测速手写的一套近似 GitHub 风格占位主题**，色值（`#f6f8fa` / `#d0d7de` / `#6a737d` / `#e1e4e8`）凭印象取的，**没有读取 Velo 的任何样式文件**。

Velo 真正的样式来源：

| 来源 | 内容 |
| --- | --- |
| `src/lib/export/exportStyles.scss` | 导出 HTML 的样式入口，`@forward` 11 个 `_editor-*.scss` partial |
| `src/styles/_editor-typography.scss` 等 | 字号 / 行高 / 标题层级 / kbd / blockquote / alert / 表格 / TOC / 脚注 |
| `src/lib/export/htmlRenderer.ts:218` | 把 store 值注入 `:root`：`--md-font-size: 16px`、`--md-primary-color`、`--md-font-family`、`--font-mono` |
| `src/stores/editor.ts` + `src/utils/fontStacks.ts` | `fontSize` / `primaryColor` / `buildFontStack()`（默认 cambria + yahei + cascadiacode） |
| `shikiHtml.ts` + `fontFaceCss.ts` | vitesse-light / vitesse-dark dual themes、20 个内联 woff2 字体 |

关键差异（spike 手写值 → 基线实际值）：字号 11pt → **12pt**（16px）；行距 `leading: 0.72em` → **1.75**；正文色默认黑 → **#333**；h1 1.85em 左对齐 → **2em 居中**；h2 无下边框 → **1px #eee**；链接默认 → **#576b95**；代码块 `#f6f8fa` + 圆角 + 描边 → **shiki `--shiki-light-bg: #f6f6f6` 无边框**；alert 中文标签 + 浅色填充 → **英文 Note/Tip/… + 4px 左竖条无填充**；TOC `#1F71D9` → **`#0F4C81`**；还多了一个基线没有的页脚页码。

`08-style-align.mjs` 把这些值换成真实值后重编译：首页标题居中、目录左边框、去页码、正文字色与行距都贴近 Chrome 基线，但**页数仍是 12 页（基线 14 页）**。这说明两件事：

- **样式不一致是可修的工程问题** —— 只要把 `exportStyles.scss` 的 CSS 变量 / 设计令牌映射成一份 Typst `#set` 表（单一来源），视觉就能对齐。手写模板必然会漂移，产品化时不能这么做。
- **分页不一致才是引擎级差异** —— 换样式值不改变页数。字体度量、CJK 断行、`break-inside`、`.velo-editor` 的 `max-width: 880px` + `padding: 2em 1.5em 4em` 内容盒、Chromium 与 Typst 的分页算法都不同。这也是 B.5 里「要 WYSIWYG 必须把导出也换成 Typst」的实证。

---

### 附录 C. 新约束下的方案评估与落地（原 `pdf-fast-preview-export.md`，2026-11-19，方案已实现）

> **性质**：决策前可行性评估 → **已按本附录方案落地实现**（`src/lib/export/pdfPreview/`，导出面板第四项「PDF 预览」；实现说明见 `docs/architecture/export.md`「PDF 预览 / 导出（Display List 双后端）」）。旧 `PDF`（PrintToPdf）路径保留，互不替代。以下为原文关键点留痕，速度数字来自 spike。  
> **⚠️ 阅读提示**：C.2–C.6 是**选型期的评估与 spike 留痕**，多处与最终产品实现不同（文本测量方式、字体子集路径、富片段档位、缓存粒度、预览绘制范围等）。**实现现状一律以 C.7 与 `docs/architecture/export.md` 为准**。

#### C.1 约束

| 约束 | 要求                                                 |
| --- | --- |
| 首次渲染 | ~1s 可接受 |
| 平台 | 最好三平台导出，**不依赖 WebView2** |
| 与 DOC / HTML / 主编辑器差异 | **允许细微差异** |
| 体积 | 不能增加过大（基线 Windows 安装包 **15,096,450 B**） |
| 手段 | 允许 Rust / TS / JS 自研算法与组件 |



#### C.2 结论与方案对比

**推荐：前端共享 Display List 双后端（纯 TS/JS 自研轻量布局器），不引入排版引擎。** 布局、预览、PDF 序列化全在前端完成，共用一份 `DisplayList`：预览直接绘制 display list（DOM 绝对定位），**不生成 PDF**；导出才把同一份 display list 序列化成 PDF。预览与导出**天然完全一致**（同一份绘制指令）；只借用浏览器 `Canvas 2D.measureText` 做文本测量，不调任何平台原生 print API，三平台行为一致。体积增量约 **+0.1~0.4MB**（相对 15MB ≈ 1–3%）。

| 方案 | 安装包增量 | 首次 | 后续变更 | 三平台 | 判定 |
| --- | --- | --- | --- | --- | --- |
| A. 保留 WebView2 `PrintToPdf` | 0 | ~5s | ~5s（`PRINT_LOCK` 串行） | ❌ | 不满足速度与平台 |
| B. Typst native 嵌入 Rust | **+10~20MB**（预编译 CLI 52.5MB） | ~1.4s 引擎内 / 1.79s 端到端 | 27–132ms | ✅ | **体积超标**，首次也偏慢（详见附录 D） |
| C. Typst WASM（`typst.ts`） | +3~8MB WASM 本体 | 需加载+编译 WASM | 未验证 | ✅ | 体积偏大、性能不确定 |
| D. **纯 TS Display List（推荐）** | **+0.1~0.4MB** | **实测 ~52ms** | **实测 0.8–47ms** | ✅ | ✅ |
| E. 轻量 Rust 排版器（`pdf-writer` + `ttf-parser`） | +0.3~1MB | 量级同 D | 快 | ✅ | 备选；display list 要跨 IPC，预览端仍要一份绘制器 |

现成 PDF 库均不需要引入：`pdf-lib` tarball 4.23MB、`pdfkit` unpacked 10.5MB、`jspdf` unpacked 30MB、`fontkit` 993KB、`wawoff2` 1.28MB —— 自写 PDF writer 在 spike 里 2.9ms 产出 33KB PDF，核心代码几十行。

#### C.3 架构与实测（`.pdfbench/tslayout/`）

```
mdast（复用现有 unified + remark 链）
  └─ LayoutEngine（TS）：measureText 测量；按块内容 hash 缓存行盒
       输出 Page[] / DisplayList：{ text runs, rects, lines, images, paths }
        ├─ 预览：DOM 绝对定位渲染「可见页」（同一 DisplayList）
        └─ 导出：PdfWriter（TS）序列化同一 DisplayList；字体子集 → 轻量 Rust command
```

骨架 spike（136 块 / 11 页 / 432 指令）：首次全量布局 **47.9ms**；二次布局（全缓存）0.1–0.2ms；改边距 3.2ms；改字号 46.9ms；改正文（135/136 块命中缓存）0.8ms；预览 DOM 绘制可见页 **0.7ms**；PDF 序列化 3.4ms。首次端到端 ≈ **52ms**，比 1s 门槛快约 20 倍。

⚠️ **canvas 首次绘制有约 530ms 一次性开销**（canvas/Skia 首次光栅化初始化，DOM 预热字体无效），因此**预览走 DOM 绝对定位而非 canvas**；若必须用 canvas 则 app 启动时预热一次。

**真实导出 demo（纯 Node，无浏览器）**：文本宽度直接查子集字体字形宽度表（fontmap），三平台结果字节级一致，连 `measureText` 都不需要。PdfWriter 自写 Type0 `/Identity-H` + CIDFontType2 + `/FontFile2` 嵌入 TTF 子集 + `/W` 宽度表 + ToUnicode CMap。四场景全量重排（未用缓存，最慢路径）：首次冷启动预览 **12.76ms** / 导出 **20.14ms**（14 页 / 742 文本行）；改边距 ×1.4 → 15 页（内容宽 504.58 → 468.30pt）；改字号 ×1.3 → 15 页；改正文 → 行数 742 → 741。参数确实生效，相对 1s 门槛有 50–75× 余量（不含生产版 Rust 字体子集 command 首次调用）。

**保真度（对照 Chrome 真实导出，pypdf 文本层 + pdfjs 栅格化）**：页数 14 vs 14 ✅；CJK 覆盖 Chrome 的 **98.5%**；`?` 缺字回退同为 2 个；`⌘` 等特殊字符 ToUnicode 生效；**文本可选中 / 搜索 / 复制**（没有退化成文字转路径）。已保真：CJK/拉丁混排、标题层级、贪心断行、列表、表格、引用块与 5 种 alert 彩色竖条、代码块底色、TOC、水平线、行内强调 / 链接色、脚注序号。⚠️ 分页位置与 Chrome 不同（每页字符分布不同）。字体子集 250,780 B（sans/bold/mono 三套 TTF，全部来自项目已有 26 个 woff2，**零新增字体文件、零新增运行时依赖**）；产物 PDF 388,220 B，比 Chrome 同文档 2,264,674 B 小约 6×。

#### C.4 富片段接入（KaTeX / mermaid 不再是降级项）

**做法**：不自研 TeX / 图表排版，把 Chromium 已排好的结果采样为**原子富片段** —— 无头 Chrome 打开 `buildExportHtml` 真实产物，对 `.katex-html` 与 pele `<svg>` 逐个截图为 2× JPEG，按非白像素包围盒裁白边；DisplayList 新增 `image` op，PdfWriter 新增 `/Image` XObject（`/DCTDecode`，JPEG 字节直接作流）。行内公式作为不可拆分原子 token 参与贪心断行、垂直居中在行盒内。

**三个实现要点**：① **主题对齐** —— headless Chrome 默认 `prefers-color-scheme: dark`，必须 emulate light 才与 PrintToPdf 基线一致；产品化时片段颜色必须与预览主题同步，暗色要另存一套或重渲染。② **裁白边** —— 块级公式容器是 880px block，直接截图带大圈空白。③ 片段尺寸来自浏览器测量，接上富片段后「纯 Node、三平台字节级一致」不再成立（生产版可在前端 webview 直接调 `svgRaster.ts`，不必额外起 Chrome；三平台细微尺寸差按需求允许）。

**结果**：PDF 388,220 → **516,676 B**（6 张 JPEG 共 131,110 B）；首次布局/导出 **14.34 / 23.37ms**；降级项从 6 项减到**仅 `<details>` 1 项**。**代价（位图方案 A 实测确认）**：公式与图内文字不可选中/搜索/复制（文本层少 507 字符，CJK 覆盖 98.5% → **94.9%**，缺的主要是 mermaid 中文标签）；2× 截图约 190 DPI，放大失真；主题绑定。仍未做：shiki 高亮（单色）、图片 `Velo.png`（占位文本，也是与 Chrome 分页差一页的主因）。

**B 档（SVG→PDF 矢量）评估，未实施**：实测 pele SVG 是**固定方言**（仅 `svg/g/path/rect/text/tspan`；path 仅 `M/L/C/A/Z` 全绝对坐标；transform 仅 translate；95 处 `var()` 可静态展开清零），不是通用 SVG 引擎，约 **300–400 行 TS + 逐图回归**。关键纠正：矢量路径若把 `<text>` 转轮廓，文本层照样丢；只有 **PDF 文本算子 + 嵌字体子集 + ToUnicode** 才保住搜索，而这正是最难的 text 模块（中文度量对齐、`text-anchor=middle` 换字体后居中偏移）。收益估算：PDF 降到约 420–430KB，CJK 覆盖回到约 98%。**建议作为独立一步**：先写只转现有 3 个 SVG 的 spike 再产品化；且转换器绑定 pele 内部实现，须长期跟随升级，并保留 `svgRaster.ts` 位图作「解析不了就降级」兜底（两套编码器都留）。A 档已把架构问题验完（op 类型、资源字典、双后端一致性、缓存边界），B 档只换 `image` op 的内容，接口不变，不会推翻结论。

#### C.5 关键技术难点

1. **字体子集化与 PDF 文本层（唯一真正的新增依赖）**：中文必须嵌 CIDFontType2 子集，不能文字转路径。推荐 **Rust command**（`ttf-parser`/`skrifa`，~100–300KB 压缩后增量）；备选前端 `wawoff2` + 自写极简子集器（TTF 表重写易错）或构建期预生成（字符集不灵活）。项目已有 26 个 woff2（3,823,088 B）且 `fontFaceCss.ts` eager glob 已在导出 chunk 里，零新增字体文件。
2. **26 类 mdast 节点适配**：核心节点精确实现；KaTeX / pele / shiki 复用既有纯 JS 产物；任意 raw HTML 走白名单，`<details>` 等降级**必须进 `warnings` 不能静默**（旧 `exportToPdf` 忽略了 `buildExportHtml` 的 warnings，新链路要补上）。
3. **排版规则**：CJK 禁则（避头尾）、英文按词断行、`break-inside: avoid`、orphans/widows —— 规则有限但易错，是「稳定」的主要风险点（demo 是逐字符贪心断行，未做这些）。
4. **样式单一来源**：附录 B.6 已证明手写模板必然漂移；布局参数必须从 `exportStyles.scss` 的 CSS 变量 / 设计令牌生成，不另写常量。

#### C.6 工程改动面与落地路径

- **新增**：`LayoutEngine`、`DisplayList`、`PdfWriter`、DOM 预览组件、字体子集 Rust command、节点覆盖与逐页回归测试（预计 ~1500–2500 行 TS）。
- **删除（仅当未来新引擎切默认）**：`pdf.rs` + `pdf_windows.rs` 共 458 行、`PRINT_LOCK`、隐藏窗口、asset 临时 HTML、30s 超时、oneshot 桥、`webview2-com`。注意 `winreg` / `windows` 其他 features 与 `assetProtocol` scope / CSP 的 `http://asset.localhost`（图片加载）仍要保留。当前实现**保留旧路径**，未删除。
- **测试**：`export.test.ts` 的 `payload.html` 断言仅针对旧路径，HTML / DOCX 路径测试不受影响。
- **落地路径**：P0 布局器 + DOM 预览（8 类核心节点）→ P1 PdfWriter + 字体子集打通导出（须接富片段）→ P2 补齐 26 类节点 + 样式令牌映射 + 长文档语料 → P3 增量缓存细化 / 可见页绘制 / 参数面板 → P4 切默认、删旧路径、三平台实机验证。**止损**：旧 WebView2 路径保留为 Windows「高保真导出」备选，不必一次性删除；先并列双引擎收集真实文档回归再切默认。
- **仍未验证**：macOS / Linux 实机；>100 页长文档压力测试；Acrobat / 打印 RIP 兼容性（demo 只过了 pdfjs + pypdf）。

#### C.7 产品实现与上述评估的差异（review 对照，2026-11-19）

> 以下是落地实现（`src/lib/export/pdfPreview/`，~2300 行 TS + `PdfPreviewPanel.vue`）与 C.2–C.6 评估/spike 的**实际差异**。评估文字保留原样作留痕，读本附录时以本节为准。

| 项 | 评估 / spike 的说法 | 产品实现实际 |
| --- | --- | --- |
| 文本测量 | C.2「借用 `Canvas 2D.measureText`」；C.3 架构图同 | **不用 measureText**。与 §4A demo 相同：查子集字体的字形宽度表（运行时 fontmap，`tokens.ts`），布局是纯计算，三平台一致 |
| 字体子集 | C.5 推荐「Rust command（ttf-parser/skrifa）」 | **未加任何 Rust command，也未走构建期预生成**（曾短暂用 `gen-pdf-fonts.py` 静态子集，后废弃）。最终走**运行时 WASM 子集化**（`fontSubset.ts`）：文档字符集 → wawoff2 解压项目 woff2 → hb-subset(wasm) 子集化 → opentype.js 解析出 fontmap。零 Python / 零提交字体资产，生僻字不再缺字，导出 PDF 内嵌字体只含文档用字。spike 对照 fontTools 产物：3888 字 gid / 字宽 / 垂直度量零偏差，全流程首次 ~250ms / 热态 ~130ms。新增依赖 harfbuzzjs + wawoff2 + opentype.js（合计 ~1.5MB，全在懒加载 chunk）。**wawoff2 / hb-subset 都是单 wasm 实例共享堆**：解压与子集化必须串行、输出立刻拷出堆（并行解压曾致首套 sfnt 被后续调用覆盖，vitest 回归测试抓出后修复）。wawoff2 官方 `decompress.js` 包装在 Vite 预构建下会把初始化回调注册到空 exports 对象上导致永久悬挂（面板卡「重排中…」），改由 `woff2Decode.ts` 以 `?raw` + `new Function` 受控加载 binding |
| 富片段档位 | C.4 demo 全走 A 档位图；「B 档未实施、建议独立一步」；shiki 单色、图片占位是遗留降级项 | **B 档已实施**：mermaid 走 `svgToPdf.ts`（~300 行，恰好落在评估的 300–400 行量级），图内文字是 PDF text 算子可搜索，解析不了降级回 `svgRaster` 位图（两套编码器都留，与评估建议一致）。**shiki 已按 token 双色（light/dark）出 TextOp**，文本层 100% 保留。**图片已实装**（读盘 → data URI → JPEG `/DCTDecode`）。仍走 A 档位图的只剩 KaTeX 与块级 raw HTML（`<details>` 等含在内） |
| A 档采样方式 | C.4 spike 用无头 Chrome 截图 + emulate light | 产品在 webview 内 `foreignObject` + 内联 KaTeX CSS 光栅化，**宽松画布（40px bleed、2×）→ 非背景像素扫描裁剪**；`previewEl` 与导出用同一张 JPEG，杜绝两侧裁切分叉（KaTeX `.pstrut` 撑杆 / 隐藏 MathML 假矩形 / 字体异步加载三类测量陷阱详见 architecture/export.md）。foreignObject 不可用才退回惰性光栅化 + DOM 预览 |
| 缓存粒度 | C.3 spike「按块内容 hash 缓存行盒」，改正文 0.8ms | **按整篇内容 hash 缓存 build 结果（最多 4 份）**，`relayout()` 每次全量重排（同步纯计算，sample 实测 ~4–8ms，够快所以没做块级增量）。正文变化 180ms 防抖后重新 `buildPdf()` |
| 预览绘制范围 | C.3 / C.6 P3「只绘制可见页」 | `renderAllPages` **一次画全部页**（sample ~17ms），未做可见页虚拟化；长文档性能未验证 |
| 排版规则 | C.5 列为必须解决的风险点 | 部分实现：拉丁按词断行 + CJK 逐字断行 + 0.5pt 浮点容差；**禁则（避头尾）、`break-inside: avoid`、orphans/widows 未做**；代码块 / 表格按行 / 按行分页可跨页 |
| 样式单一来源 | C.5「必须从 SCSS 变量生成，不另写常量」 | `tokens.ts` 是**手工对齐** `_editor-*.scss` 取值的常量表（注释声明同源），**没有自动生成机制** —— B.6 警告的漂移风险仍在，改主题需手动同步 |
| 速度 | C.2/C.3 spike 首次 ~52ms / demo 导出 ~20ms | 那些是**不含富片段渲染的布局/序列化数字**。产品首次 `buildPdf()` dev 实测 ~1.65s（shiki/KaTeX 模块懒加载 + 公式位图化），`serializePdf()` ~257ms；参数重排 ~4–8ms。首次打开预览面板体验以 build 为准，不是 52ms |
| 体积增量 | C.2 估 +0.1~0.4MB | 运行时路线：新增 wasm/JS ~1.5MB（懒加载 chunk）+ 完整 woff2 ~2.35MB 进包（与 fontFaceCss 共用同一批文件）；静态 TTF 资产已删。总量与旧静态路线（~2.26MB TTF + 176KB fontmap）大致打平，仍高于评估上限 |
| 测试 | C.6「节点覆盖与逐页回归测试」 | `export.test.ts` 新增 2 条（入口语义 + 四类型断言）；字体改造补 `pdfPreview/__tests__/fontSubset.test.ts` 16 例（vitest 跑真实 wasm：字符集 / 子集自洽 / 生僻字 / 回退链 / 缓存 / writePdf 字节同源 + ToUnicode 可逆）。**布局 / 富片段 / 逐页回归仍无测试**，属未完成项 |
| 暗色主题 | C.4 要点 ①「暗色要另存一套或重渲染」 | build 缓存 key 不含 `dark`，KaTeX/raw HTML 位图按**首次 build 时的主题**烘焙；面板内切换「暗色版式」只翻转文本/线条令牌，**位图片段不会重新渲染**（已知限制） |

---

### 附录 D. 把 PDF 导出整体换成 Typst 的影响评估（原 `pdf-typst-export.md`，2026-11-19，未实施）

> **性质**：决策前影响面评估，**未列入 ROADMAP、未实施**。触发：附录 B「要 WYSIWYG 必须把导出也换成 Typst」需要展开成可决策的成本清单。**结论：不建议整体替换**；新约束（附录 C）下该结论依然成立，但主因从「一致性」变为「**体积 + 首次延迟**」：Typst 会让安装包从 15MB 涨到 25–35MB。Typst 路线保留为技术储备 —— 若将来接受更大体积、需要更高质量的数学 / 表格排版，可再用 `.pdfbench/typst/02-walker.mjs` 那套 IR 映射复活。

#### D.1 核心权衡

现有 PDF 导出的核心价值不是「能生成 PDF」，而是**与编辑器 / HTML / DOCX 共用同一份 HTML 与 SCSS**（ADR-20260621-004）：`buildExportHtml` 的产物同时喂给 HTML 导出、DOCX 导出（`docxRenderer.ts` 复用）与 PrintToPDF，三者共享同一中间态。换 Typst 等于把「所见即所得」契约换成新排版引擎：

| 得到 | 失去 |
| --- | --- |
| macOS / Linux PDF 从 `Unsupported` 变为可用 | PDF 与编辑器 / HTML / DOCX 的视觉一致性（用户已有预期，breaking change） |
| 删 458 行 WebView2 胶水 + `webview2-com`；不再需要隐藏窗口 / `PRINT_LOCK` / asset 临时文件 | 26 类 mdast 节点 + LaTeX 命令的持续适配成本（用户公式是开放集合，宏需长期补） |
| 页边距 / 字号 / 页眉页脚变成几行 `#let`；暗色导出显式可控；可并行编译 | 样式单一来源（SCSS ↔ Typst `#set` 两份，手写必漂移，须自动生成） |
| 省掉 `buildExportHtml` ~2.3s | 首次全量布局 + PDF 序列化本身 ~1.4s（预热无效），总体仅从 3–5s 降到 1.5–2s，**速度收益没有想象中大** |

其他功能差异：代码高亮 shiki → syntect（配色不同、冷门语言可能无高亮）；raw HTML 走白名单降级；CJK 字体在部分 Linux 发行版缺失需打包 Noto Sans SC（~3MB）；`typst@0.15.1` 要求 rustc ≥ 1.92、Apache-2.0，release 编译时间升到数分钟，打包流水线要重测。

#### D.2 集成形态与工程影响

- **推荐形态 A**：walker 留在前端 TS（复用现有 unified + 7 个自写 remark 插件，与编辑器共用同一棵 mdast），Rust 只做 Typst 编译。形态 B（整条管线搬 Rust）需重写全部自定义 remark 语义，破坏「同一棵 mdast」这个唯一一致性锚点，等于重写导出管线。command 契约从 `export_pdf(output_path, html)` 变为 `(output_path, typ_source, assets)`，前端 opts（darkMode / primaryColor / 字体 / 字号 / 主题等）仍需传。
- **不能整块删的**：`winreg` 与 `windows` 其他 features（注册表 / GPU 功能仍用）；`assetProtocol` scope 与 CSP 的 `http://asset.localhost`（图片加载仍需）。
- **必须新增**：Typst World（字体/图片/SVG 资源注入）、前端 walker、SCSS→`#set` 映射表、LaTeX→Typst 转换器、pele SVG 变量展开（否则全黑块，见 B.4）、降级报告（不能静默）。
- **长期维护**：新增自定义 mdast 节点从改两处（walker + SCSS）变成三处；样式双份维护。
- **用户可见 breaking change**：字号 / 行距 / 标题层级 / 高亮配色 / alert 图标 / 分页位置（12–13 页 vs 14 页）全变；`EXPORT_TYPES` 里 PDF 的「版式与分页最稳」文案需改写。正面：macOS / Linux 终于能导 PDF。

#### D.3 建议路径（若将来推进）

**不一次性切默认**，也**不做「macOS/Linux 用 Typst、Windows 留 Chromium」**（三平台输出互不相同，比现状更糟）。三阶段：① 并列双引擎（隐藏开关「Typst 实验」收集真实降级案例）→ ② 建回归基线（长文档 / 复杂 LaTeX / raw HTML / 各语言代码块语料，逐页 diff，LaTeX 覆盖率与 26 类节点覆盖自动化；工作量远大于 spike 本身）→ ③ 确认「分页差异 / 外观差异可接受 + 三平台一致」后才切默认、改 ADR-20260621-004 原条目、写 RELEASE_NOTES、删 458 行平台代码。不做的话：跨平台 PDF 若单独解决，另评估 WKWebView / WebKitGTK 原生 print API（成本不低但视觉一致性可保持）。

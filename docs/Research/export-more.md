# 导出 DOCX / EPUB 方案调研（不依赖外接 pandoc）

> **性质**：pre-implementation 设计研究，候选方案尚未拍板。后续若决定实现，重大取舍进 `DECISIONS.md` ADR，最终架构同步 `docs/architecture/export.md`。
> **对应 ROADMAP**：`#export-more`
> **调研日期**：2026-11-14。
> **当前状态**：基于代码库现状 + 公开包元数据 + 本机 spike 实测（`/tmp/docxprobe` JS 侧 + `/tmp/docxrs` Rust 侧，含真实 docx 解包验证）整理。候选方案的依赖构成、浏览器兼容性、Velo 自定义节点覆盖度均已实测；Rust 系两方案（ferrodoc / knit-md-docx）亦已编译跑通并解包比对（见 2.9）。
>
> **前置约束**：
>
> - ROADMAP `#export-more` 原写「建议走 pandoc 桥接」，本文即对该建议的复核结论：**pandoc 不是唯一解，自包含方案可行且更契合 Velo 定位**。
> - Velo 导出管线是 **mdast 驱动**（`htmlRenderer.ts` 复用 `markdownIO.ts` 的 unified pipeline，刻意不走 PM doc）——这决定了选型必须以「mdast 为输入」的方案为优先。
> - 目标格式澄清：**实际可交付的是 `.docx`（OOXML）**。legacy `.doc`（CFB 二进制）无可用 OSS 写入器，只有 pandoc / LibreOffice 能产出；若用户明确要 `.doc`，仍只能走外部工具。本文聚焦 `.docx`。EPUB 是另一条独立管线，本文不展开。

---

### 0. 结论

**有，不依赖外接 pandoc 的可行途径存在，且不止一条。** 四条路线都已本机实测跑通：

- **`mdast2docx@1.7.1`**（mdast 直出）：架构最纯粹，不依赖 HTML，结构处理最可控；**但丢失全部 CSS 样式**（无颜色 / 底纹 / 边框 / 语法高亮）。
- **`docx.js` + `htmlToContent`**（复用 Velo 现有 HTML）：**保真度实测最高** —— 保留 CSS 样式、shiki 语法高亮、alert 底色+边框、KaTeX 公式、SVG+PNG 图片；**代价**是依赖输入 HTML 质量。
- **`ferrodoc@1.0.1`**（Rust 重实现 pandoc → WASM）：结构最精简、样式表完整、脚注规范；**但公式原样输出（无 OMML）、不支持任何 Velo 自定义语法**（`:::note` / `==高亮==` / `:smile:` 全部原样文本）——对 Velo 是硬伤。
- **`knit-md-docx@0.1.0`**（Rust 原生）：功能最全（OMML 公式 / 真脚注 / 标题书签 / GFM alert / 代码块底色），结构规范；**代价**是必须进 `src-tauri` 编译、依赖 fork 的 `docx-rs`、与现有「前端 Blob 导出」架构割裂，且同样不支持 Velo `:::note`。

推荐路线（按落地顺序）：

1. **首选 `docx.js` + `htmlToContent`** —— 复用 Velo `htmlRenderer` 已有的高质量 HTML 输出，保真度实测最高（见 2.8）。需处理 Velo 特有的图片 `asset://`、mermaid SVG 内联等适配。
2. **次选 `mdast2docx@1.7.1`** —— 不依赖 HTML、架构纯粹，适合 HTML 路线遇适配问题时切换，或作为「无样式快速导出」。
3. **长期「最 Velo 原教旨」是自写 mdast walker → docx.js** —— 复制 `htmlRenderer.ts` 模式，完全控制自定义节点；作为前两者维护风险的对冲。
4. **Rust 系（knit-md-docx）列为长期架构选项** —— 仅当 Velo 决定把 DOCX 导出也下沉为 Tauri command 时才投入（见 2.9）。ferrodoc 因公式 / 自定义语法缺失，**明确不适合 Velo**。

**明确不推荐**：pandoc CLI（分发负担）、prosemirror-docx（架构错位 + 停更）、ferrodoc（公式 / 自定义语法缺失）、Word 兼容 HTML `.doc`（质量差）。

---

### 1. 候选方案对比

> 包大小为 `npm view dist.unpackedSize` / 本机实测，仅用于横向对比；运行时 + tree-shaking 后实际体积会大幅低于归档体积。

| 方案 | 机制 | 依赖代价 | 保真度 | 维护现状 | 结论 |
|---|---|---|---|---|---|
| **A. pandoc CLI** | 外接二进制 | ~150MB × 三平台 | 最高 | — | ❌ 与 Velo 轻量定位冲突 |
| **B. mdast2docx@1.7.1** | MDAST → docx.js | +166KB gzip（不含真 mermaid） | 中（原生表格/脚注/OMML/复选框，**但丢 CSS 样式**） | 单人维护 | ✅ 次选（无样式需求时） |
| **C. prosemirror-docx@0.6.1** | PM doc → docx | 中 | 中 | 停更 1 年+，Snyk 54 | ❌ 架构错位 |
| **D. docx.js + `htmlToContent`** | HTML → OOXML | +docx.js（11.5M/周） | **高**（保留 CSS／高亮／alert） | 成熟活跃 | ✅ **首选** |
| **E. Word HTML `.doc`** | 伪 Word（application/msword） | 零 | 差 | — | ❌ |
| **F. ferrodoc@1.0.1** | Rust 重实现 pandoc → WASM | 0.65MB gzip | 中（**公式 / 自定义语法缺失**） | 极新（1 个月前） | ❌ 不适合 Velo |
| **G. knit-md-docx@0.1.0** | Rust 原生 OOXML writer（fork docx-rs） | 编译期（进 src-tauri） | 高（OMML / 脚注 / 书签 / GFM alert） | knit 极新 / 依赖 fork | ⚠️ 长期架构选项 |
| **H. 自写 mdast walker → docx.js** | 完全控制 | +docx.js | 最高 | 自维护 | ✅ 长期对冲 |

#### 1.1 为什么排除 pandoc CLI

- 需打包 ~150MB 二进制，Windows / macOS ARM64 / Linux 三份，与 Velo「本地轻量编辑器」定位冲突。
- 用户装 Velo 是为了编辑，不是为了背一个 Haskell 工具链。
- ROADMAP 原建议的理由是「一行命令多格式，比自写 walker 高效」——但 EPUB 需求尚未确认，为单一 DOCX 引入 pandoc 不划算。

#### 1.2 为什么排除 prosemirror-docx

- 它从 **ProseMirror doc** 序列化，而 Velo 导出管线**刻意不走 PM doc**（`htmlRenderer.ts` 注释明确「省二次桥接」）。引入它等于在导出路径上重新引入 PM 桥接，与现有架构反向。
- `0.6.1` 自 2025-07 未更新，Snyk 54/100，table 支持仍标 Planned。

#### 1.3 docx.js `htmlToContent` 的真实能力（实测修正）

> **本节结论修正了初版调研的判断。** 初版认为 `htmlToContent`「不识别 CSS class 语义、低保真」——实测证明**恰恰相反**：它读 `<style>` 与内联 `style`，能保留颜色 / 底纹 / 边框 / 字体，语法高亮、alert 样式、KaTeX 公式都能带过去。

`docx.js` 本身极成熟（周下载 11.5M，115 个版本，2026-11 仍在更新，MIT），是**引擎层**的稳妥选择。它的 `docx/html` 子路径（`htmlToContent`）能力上限很高：

- **读 CSS**：`<style>` 块 + 内联 `style` 属性，按 CSS 选择器 + `styleMap` 映射到 Word 样式或直接格式化。
- **保真清单**：标题 / 段落 / 列表（嵌套）/ 表格（合并单元格、表头、边框、底纹）/ 图片（含 SVG + PNG fallback）/ 链接（含内部锚点）/ **checkbox** / **Word 公式（OMML）** / 分页 / **tracked changes**。
- **数学**：从 KaTeX 的 MathML + LaTeX annotation 读，输出原生 OMML。
- **脚注**：识别 `data-footnote-ref` / `rel="footnote"` / `role="doc-footnote"` / `epub:type="footnote"` / Word 的 `mso-element:footnote-list` 等。
- **告警**：CSS `background` → Word 底纹，`border-left` → Word 段落边框，自动转换。
- **语法高亮**：内联 `color` → Word run 颜色，**完整保留**。

**代价**：保真度**取决于输入 HTML 的质量**。喂给它合法、带样式的 HTML（Velo `htmlRenderer` 正是这样的输出）→ 高保真；喂给它碎 HTML（如标准 hast 直接转换的 `<div><li>` / `<div><tr>`）→ 结构丢失。**Velo 的 `htmlRenderer` 输出质量足够，这是本方案可行的前提。**

---

### 2. 本机 spike 实测（关键证据）

> 环境：`/tmp/docxprobe`，Node 22 + Vite 8 同版本 `unified` / `remark-parse` / `remark-gfm`。以下均为真实跑通的结果，非文档推测。

#### 2.1 mdast2docx@1.7.1 可安装、可运行、输出合法

- `npm install mdast2docx@1.7.1` 成功（194 packages）。
- **1.8.0 视 npm 源而定**：默认镜像源（如 npmmirror）可能因同步延迟报 `ETARGET`（缺 `@m2d/core@1.10.0` / `@m2d/code@0.1.0`）；**官方源 `https://registry.npmjs.org/` 可正常安装**（本机实测）。选型时若要用 1.8.0，需确认源同步状态；1.7.1 无此问题。
- 用 `toDocx(tree, {}, { plugins }, 'blob')` 跑含标题 / 加粗 / 斜体 / 行内码 / 链接 / 列表 / 表格 / 脚注 / 公式的 markdown，输出 10140 字节、`PK` 魔数的合法 docx。

#### 2.2 输出保真度（解包 `word/document.xml` 验证）

| 输入 | 输出结构 | 结论 |
|---|---|---|
| Markdown 表格 | `<w:tbl>` | ✅ 原生表格 |
| `[^1]` 脚注 | `<w:footnoteReference w:id="1"/>` + `word/footnotes.xml` | ✅ 原生脚注 |
| `$$E=mc^2$$` | `<m:oMath>`（OMML 命名空间） | ✅ **原生 Word 公式** |
| `- [x]` / `- [ ]` | `<w14:checkbox><w14:checked w14:val="1\|0"/>` | ✅ **原生 Word 复选框** |
| `:smile:`（remark-emoji） | `你好 😄 世界` | ✅ Unicode emoji |
| 完整结构 | `styles.xml` / `numbering.xml` / `fontTable.xml` / `theme/` | ✅ 可直接被 Word 打开 |

#### 2.3 浏览器兼容性（决定能否在 Velo 前端跑）

- `@m2d/core` 的 `.mjs` 构建**无任何 Node 专有 API**（`Buffer` / `process` / `fs` / `path` 均无）。
- `@m2d/image` 是**纯浏览器实现**：`document.createElement` / `canvas` / `fetch` / `createImageBitmap` / `XMLSerializer`，内置 mermaid SVG → 位图光栅化（`@svg-fns/svg2img`）。
- `@m2d/html` / `@m2d/mermaid` 需要 DOM —— **Velo 是浏览器应用，天然满足**；Node 端才需要 `@m2d/html-node` 等 peer。
- **结论：不需要给 Vite 加 node polyfill**，与 `vite.config.ts` 现状兼容。

#### 2.4 体积代价（esbuild `--platform=browser --minify` 实测）

| 打包范围 | raw | gzip |
|---|---|---|
| docx.js + table/list/math/image/frontmatter | 617 KB | **166 KB** |
| 再加 html + emoji（**仍不引 mermaid 插件**） | 691 KB | **193 KB** |
| 再加 `@m2d/mermaid` + 真 mermaid | 5.9 MB | **1.69 MB** |

- **193KB gzip 是 Velo 的目标代价**，对桌面应用完全可接受。
- 1.69MB 的暴涨全部来自 **真 mermaid**（`@m2d/mermaid` 的硬依赖 `mermaid@12.3.0`）。
- **关键结论：npm 装 mermaid ≠ 浏览器打包 mermaid。** `mermaid` 是 `@m2d/mermaid` 的硬依赖、`@m2d/mermaid` 又是 mdast2docx 的硬依赖，所以 `npm install mdast2docx` 必然把 mermaid 装进 `node_modules`（占磁盘）；但**只要 Velo 代码不 `import '@m2d/mermaid'`，Vite/rollup 的 tree-shaking 就不会把它打进 bundle**。实测不引用该插件时 bundle 里 `dagre` / `d3-selection` / `mermaid.core` 等库特征为 **0**（残留的 `mermaid` 字样只是 `mermaidFallback` / `data.mermaid` 字段名和美人鱼 emoji，无害）。
- Velo 已用 **`pele`**（Obsidian 出品，mermaid 语法兼容，bundle 里已有 698KB 的 `pele` chunk）渲染 mermaid。**正确做法**：继续用 `pele` 预渲染成 SVG，交给 `@m2d/image` 光栅化（见 2.6），不要引 `@m2d/mermaid`。

#### 2.5 不引 mermaid 插件时，mermaid 代码块的降级行为

- 实测：不引 `@m2d/mermaid`、只引 `@m2d/code` 时，```` ```mermaid ```` 块被当**普通代码块**处理 —— 输出等宽字体（Consolas）+ 保留源码文本，**零告警、不丢失**。
- 这是可接受的降级（内容还在，只是没渲染成图）。要渲染成图走 2.6 的 pele 预转换。

#### 2.6 pele SVG → docx 图片的完整链路（实测通过）

链路：`renderMermaidSvg()`（Velo 现有，pele）→ mdast 节点替换 → `@m2d/image` 光栅化 → docx `word/media/*.png`。

**踩坑（实测）**：`@m2d/image` 的 svg 处理器是 **inline** 的（`/^(image|svg)/` 分支在 inline processor 里），**块级 `svg` 节点会被 walker 当未知类型丢弃**（`[m2d] May be an unsupported node type: svg`）。必须包成段落：

```js
// ❌ 块级 svg → 被丢弃
{ type: 'svg', value: svgString }

// ✅ paragraph 包裹的 inline svg → 正确转成 docx 图片
{ type: 'paragraph', children: [{ type: 'svg', value: svgString, data: { altText: { name, description, title } } }] }
```

实测输出：`word/media/image1.png` + `<w:drawing><wp:inline><a:blip r:embed="rId7"/>` + rels 指向 `media/image1.png`，链路完整。

- 节点来源：`code(lang=mermaid)` → 用 `unist-util-visit` 在 mdast 层替换。
- 失败降级：`renderMermaidSvg` 失败时保留原 `code` 块（走 `@m2d/code` 等宽源码），与 `htmlRenderer.ts` 的 mermaid 降级语义一致。
- 光栅化：`@m2d/image` 内部用 `@svg-fns/svg2img`（浏览器 canvas），Velo 浏览器端天然可用；Node 端才需要 `@m2d/image-node`。

#### 2.7 Velo 自定义节点覆盖度（实测）

| Velo mdast 节点 | 来源 | mdast2docx 行为 | 需适配 |
|---|---|---|---|
| `paragraph` / `heading` / `blockquote` / `emphasis` / `strong` / `delete` / `inlineCode` / `link` / `image` / `break` / `text` / `thematicBreak` / `list` / `table` | 标准 mdast / GFM | ✅ 核心覆盖 | 否 |
| `math` / `inlineMath` | remark-math | ✅ `@m2d/math` | 否 |
| `footnoteDefinition` / `footnoteReference` | remark-footnotes | ✅ 核心 | 否 |
| `emoji` | remark-emoji | ✅ `@m2d/emoji` | 否 |
| `code` (lang=mermaid) | Velo 惯例 | ⚠️ 不引 mermaid 插件时降级为等宽源码；要渲染图走 2.6 pele 预转换 | **是** |
| `html` | 原生 | ✅ `@m2d/html`（浏览器 OK） | 否 |
| `definition` | 标准 mdast | ✅ 核心 | 否 |
| **`alert`** | remarkAlert（自定义容器） | ⚠️ `[m2d] May be an unsupported node type` → **告警丢弃** | **是** |
| **`highlight`** | remarkHighlight（自定义行内） | ⚠️ 告警丢弃 | **是** |
| `yaml` / `toml` | frontmatter | ⚠️ `@m2d/frontmatter`（Velo 选择剥离） | 需确认 |

> **关键行为**：未知节点不会中断转换，而是 `console.warn` 后跳过，最终仍产出合法 docx。这与 `htmlRenderer.ts` 的「未 case 即静默丢」同源，但 mdast2docx 至少有告警——**适配自定义节点是选型的必要工作量，不是可选项**。

#### 2.8 输出质量实测对比：mdast2docx vs docx.js `htmlToContent`

**测试方法**：同一份含 Velo 特性的内容，走两条路径产出 docx，解包 `word/document.xml` / `footnotes.xml` / `media/` 逐项比对。

- **路径 A**：`mdast → mdast2docx`（插件 table/list/math/code/image）
- **路径 B**：`mdast → HTML → docx.js htmlToContent`
  - **B1**：喂标准 hast 直接转换的 HTML（**劣质**：`<div><li>`、`<div><tr>` 无 table 包裹、行内码丢失）——代表「不处理 HTML 直接用」
  - **B2/B3/B4**：喂高质量 HTML（合法结构 + `<style>` CSS + KaTeX MathML + Velo 风格 alert/脚注/TOC）——代表「Velo `htmlRenderer` 的真实输出」

**结构对比**：

| 维度 | A: mdast2docx | B1: 劣质 HTML | B2: 高质量 HTML |
|---|---|---|---|
| 表格 `<w:tbl>` | ✅ 1 | ❌ 0 | ✅ 1 |
| 标题样式 | ✅ Title/Heading1 | ✅ Heading1/2 | ✅ Heading1/2 |
| 嵌套列表 | ✅ 10 numPr | ⚠️ 5 | ✅ 5 + ilvl 0/1 |
| 复选框 | ✅ 4 | ✅ 4 | ✅ 4 |
| 超链接 | ✅ 1 | ✅ 1 | ✅ 1 |
| 内部锚点 `w:anchor` | ❓ 未测 | ❌ | ✅ 2 |
| OMML 公式 | ✅ 1 | ❌ 0 | ✅ 2（行内+独立） |
| 脚注 | ✅ 1 | ⚠️ 1（内容进正文） | ✅ 1 + `footnotes.xml` 有内容 |
| 代码块等宽 | ✅ Consolas | ❌ 0 | ✅ Courier New |
| **语法高亮颜色** | ❌ 无 | ❌ 无 | ✅ **4 色全保留** |
| **CSS 底纹** | ❌ 0 | ❌ 0 | ✅ **3 处** |
| **CSS 边框** | ⚠️ 1 | ❌ 0 | ✅ **3 处** |
| **alert 样式** | ❌ 丢弃 | ❌ | ✅ **底色+左边框自动转** |
| **高亮** | ❌ 丢弃 | ❌ | ✅ **底纹保留** |
| **mermaid SVG** | ⚠️ 需 pele 预渲染 | ❌ | ✅ **`image1.svg` + `image1.png` fallback** |
| **OOXML 规范性** | ⚠️ 列表项 `<w:pStyle>` / `<w:numPr>` **各重复 2 次**（schema maxOccurs=1） | ✅ 正常 | ✅ 正常 |

**关键发现**：

1. **`htmlToContent` 的保真度上限远高于 mdast2docx**，前提是输入 HTML 质量高。它能保留 CSS 样式、语法高亮、alert 样式——这些是 mdast2docx **完全没有**的能力（它没有 CSS 概念）。
2. **B1 的失败是「输入质量」问题，不是 htmlToContent 的失败**。标准 hast 转换产出 `<div><li>` / `<div><tr>` 这类碎 HTML，任何转换器都救不了。Velo 的 `htmlRenderer` 不会产出这种结构。
3. **Velo 现有 HTML 结构适配良好**（B4 实测）：Velo 风格的 `<sup class="footnote-ref"><a href="#velo-fn-1">` + `<div class="footnote-definition">` 被识别成**真正的 Word 脚注**；`<a href="#title-1">` 转成 Word 内部锚点。
4. **mdast2docx 的 OOXML 规范性有瑕疵**：实测列表项输出**重复的 `<w:pStyle>` 和 `<w:numPr>`**（同一 `<w:pPr>` 内各出现 2 次，numId 还不同）。这违反 OOXML schema（这些元素 `maxOccurs=1`），Word 可能报错或忽略后者，导致列表样式 / 编号异常。htmlToContent 无此问题。
5. **mdast2docx 的优势**：不依赖 HTML 中间态，无 HTML 质量风险。**代价是丢失全部样式**，且有上述规范性瑕疵。

**结论**：**保真度上 `htmlToContent`（配合 Velo 现有 HTML）> mdast2docx**。如果 Velo 的 `htmlRenderer` 输出能直接喂给它，方案 D 应是首选；mdast2docx 的价值在于「不依赖 HTML」的架构纯粹性，以及 HTML 路线遇适配问题时的退路。

#### 2.9 Rust 系方案实测：ferrodoc vs knit-md-docx

**测试方法**：同一份 `test.md`（标题 / 加粗 / 斜体 / 删除 / 行内码 / 链接 / 引用 / 有序列表 / 嵌套列表 / 任务列表 / 表格 / 代码块 / 脚注 / 公式），分别跑两条 Rust 路线并解包比对。

- **F: ferrodoc** —— `convert(md, 'markdown', 'docx')`，Rust 重实现 pandoc AST → WASM，浏览器可直接跑
- **G: knit-md-docx** —— `to_bytes(md)`，Rust 原生（pulldown-cmark + fork 的 docx-rs），需 `src-tauri` 编译

**四方结构对比**：

| 维度 | A: mdast2docx | B2: htmlToContent | F: ferrodoc | G: knit-md-docx |
|---|---|---|---|---|
| 文件大小 | 11132 B | 10875 B | 4009 B | 28723 B |
| 表格 `<w:tbl>` | 1 | 1 | 1 | 2（1 真表格 + 1 代码块表格） |
| 标题样式 | Title / Heading1 | Heading1 / 2 | Heading1 / 2（另含 Title 定义） | Heading1-6 + Quote + SourceCode |
| 列表 numPr | 10（**含重复**） | 5 | 5 | 3 |
| 复选框 | `w14:checkbox` ×4 | `w14:checkbox` ×4 | Unicode ☒☐ | Unicode ☒☐ |
| 超链接 | 1 | 1 | 1 | 1 |
| 内部锚点 | ❓ 未测 | `w:anchor` ×2 | ❓ 未测 | `bookmarkStart` ×2 |
| OMML 公式 | 1 | 2 | **0（原样 `$$E = mc^2$$`）** | 2（`m:oMathPara`/`m:oMath`） |
| 脚注 | 1 | 1 + `footnotes.xml` 有内容 | 1 + `footnotes.xml` 有内容 | 1 + `footnotes.xml` 有内容 |
| 等宽字体 | Consolas ×7 | Courier New | `VerbatimChar` | Consolas + `VerbatimChar` |
| 语法高亮 | ❌ | ✅ 4 色 | ❌ | ❌ |
| CSS 底纹 / 边框 | ❌ | ✅ 3 / 3 处 | ❌ | ✅ 4 处 `shd`（表头 / 代码块 / 行内码） |
| Velo `:::note` | ❌ 丢弃 | ✅ CSS 保留 | ❌ 原样文本 | ❌ 原样文本 |
| GFM `> [!NOTE]` | ❌ | ⚠️ 取决于 CSS | ❌ 原样文本 | ✅ Quote + 蓝色 Note 标题 |
| `==高亮==` | ❌ 丢弃 | ✅ 底纹保留 | ❌ 原样文本 | ❌ 原样文本 |
| OOXML 规范性 | ⚠️ 重复 `pStyle`/`numPr` | ✅ | ✅ | ✅ |
| 集成方式 | 前端 npm | 前端 npm | 前端 WASM | **src-tauri Rust** |

**关键发现**：

1. **ferrodoc 的公式是硬伤**：`$$E = mc^2$$` 原样输出为文本，不生成 OMML。Velo 重度使用公式（remark-math + KaTeX），这直接否决了 ferrodoc 作为主路线。
2. **ferrodoc 不支持任何 Velo 自定义语法**：`:::note` / `==高亮==` / `:smile:` 全部原样保留为文本（实测 `F2_custom.docx`）。它只认标准 pandoc markdown，无扩展点。
3. **ferrodoc 结构最精简**（4009B）、样式表完整（含 `Title` / `Table` / `ImageCaption` 等 pandoc 风格）、脚注规范（`separator` + `continuationSeparator` + 正文）。作为通用 pandoc 替代合格，但**对 Velo 特性覆盖不足**。
4. **knit-md-docx 是四方中功能最全的**：真 OMML 公式（`m:oMathPara`/`m:oMath`）、真脚注、标题书签（`bookmarkStart`，可生成 TOC）、GFM alerts（`> [!NOTE]` → Quote + `w:color 0969DA` 蓝色 Note 标题）、代码块底色（`F6F8FA`）、行内码底色（`EEF1F4`）、表格头底色（`F2F2F2`）。结构规范，**无重复元素**。
5. **knit-md-docx 的代价**：
   - **Rust 原生**，必须进 `src-tauri` 编译，与现有「前端 Blob 导出」架构割裂（PDF 已是 Rust，但 DOCX 走前端）
   - **依赖 fork 的 `docx-rs`**（`knit-md-docx-rs`），上游 docx-rs 成熟但 fork 的长期维护是风险
   - **不支持 Velo `:::note`**（只认 GFM `> [!NOTE]`），`==高亮==` 也原样
   - **代码块渲染成单 cell 表格**（`<w:tbl>`），视觉 OK 但语义上不是标准 `SourceCode` 段落
   - 体积最大（28723B），因带完整 `styles.xml` / `settings.xml` / `comments.xml` / `fontTable.xml`
6. **Rust 系共同短板**：都不支持 Velo 自定义语法（alert / highlight），与 mdast2docx 相同；**只有 htmlToContent 靠 CSS 间接支持**。

**结论**：
- **ferrodoc**：公式缺失 + 自定义语法缺失，**不适合 Velo**，维持观望。
- **knit-md-docx**：保真度在 Rust 系里最强，但**集成代价高**（Rust 编译 + fork 依赖 + 与前端架构割裂）。若 Velo 未来把导出整体下沉到 Rust（类似 PDF），它是强候选；**在「前端 Blob 导出」的当前架构下，不如 htmlToContent 路线轻量**。
- **Rust 系方案的定位应从「候选」改为「长期架构选项」**：只有当 Velo 决定把 DOCX 导出也做成 Tauri command（利用 Rust 的类型安全与性能）时才值得投入。

---

### 3. 与现有架构的结合点

| 位置 | 现状 | 建议 |
|---|---|---|
| `src/lib/export/htmlRenderer.ts` | mdast → HTML 字符串（自写 walker） | **路线 D 直接复用**；路线 B 则新增 `docxRenderer.ts`（mdast → docx.js） |
| `markdownIO.ts` unified pipeline | `processor.runSync(processor.parse(md))` | 两条路线都复用（D 用它的 HTML 输出，B 用它的 mdast） |
| `src/stores/export.ts` | `saveDialog` filters: PDF / HTML；按扩展名 dispatch | 新增 `{name:'Word',extensions:['docx']}` filter + `.docx` 分支 |
| `src-tauri/src/lib.rs` | `export_pdf` 已注册 | **无需改 Rust**（DOCX 走前端 Blob，不像 PDF 需要平台 API） |
| `src-tauri/capabilities/default.json` | `fs:allow-write-file` allow `**` | 已就绪，二进制写盘无障碍 |
| `package.json` | 无 docx 相关依赖 | 路线 D 加 `docx`；路线 B 加 `mdast2docx` + `@m2d/*` 插件 |
| 图片 | `htmlRenderer` 用 `convertFileSrc` 转 `asset://` | 路线 D 需转 data URI（htmlToContent 不下载图片）；路线 B 用 `@m2d/image` |
| mermaid 渲染 | `mermaidHtml.ts` 用 pele → SVG | 路线 D 把 SVG 转 `<img>` data URI（实测输出 SVG+PNG fallback）；路线 B 走 2.6 的 paragraph-svg 节点 |
| DOMPurify / sanitizeHtml | `htmlRenderer` 用 | 路线 D **仍需要**（HTML 由 Velo 自产，风险低但流程保留）；路线 B 不需要 |

**注意**：`docs/architecture/export.md` 的红线「walker 未显式 case 的 mdast node 会静默丢失」在两条路线都成立。路线 B 要为 mdast2docx 适配 `alert` / `highlight`；路线 D 因为 htmlToContent 读 CSS，`alert` / `highlight` 的样式**自动带过去**（实测），自定义节点适配成本反而低。

---

### 4. 风险点

- **mdast2docx 单人维护**：`@m2d/*` 全部出自同一作者（Mayank Kumar Chaudhari）。作者停更会让 Velo 的 DOCX 导出停在 1.7.1。对冲：docx.js 是成熟引擎，自写 walker（方案 H）随时可接管。
- **1.8.0 依赖同步风险**：1.8.0 依赖 `@m2d/core@1.10.0` / `@m2d/code@0.1.0`，部分镜像源可能未同步导致 `ETARGET`（官方源正常）。**升级前必须验证依赖完整性**。
- **Rust 系方案不改变首选结论**：ferrodoc 公式 / 自定义语法缺失（硬伤）；knit-md-docx 保真度高但需进 `src-tauri` 编译、依赖 fork 的 `docx-rs`、与前端 Blob 导出架构割裂。若未来走「导出下沉 Rust」路线再重新评估（见 2.9）。
- **自定义节点适配成本因路线而异**：路线 B（mdast2docx）会**丢弃** `alert` / `highlight`（需预转换或写插件）；路线 D（htmlToContent）因为读 CSS，`alert` 底色/边框、`highlight` 底纹**自动保留**（实测），适配成本低。
- **mermaid 已解决（见 2.4 / 2.6）**：`npm install` 会装 mermaid（硬依赖链），但**不 import `@m2d/mermaid` 就不会进 bundle**（实测 193KB gzip、库特征 0）。渲染走 Velo 现有 pele → paragraph 包裹的 `svg` 节点 → `@m2d/image`。**唯一坑**：svg 必须包成 inline（paragraph 子节点），块级 svg 会被丢弃。
- **公式保真依赖 OMML**：`@m2d/math` 输出原生 OMML，Word 体验好；但若用户用 WPS / LibreOffice，OMML 兼容性略低于 LaTeX 源码（可接受，属行业惯例）。
- **EPUB 未调研**：ROADMAP 写的是「DOCX / EPUB」，本文只覆盖 DOCX。EPUB 需单独评估（候选：`epubjs` / `pandoc` / 自写 OCF zip）。

---

### 5. 推荐路线

#### 5.1 阶段一：htmlToContent 路线（首选，1-2 天出可用版本）

用 `docx.js` + `htmlToContent` 跑通「Markdown → .docx」：

- 复用 `buildExportHtml` 的 **body HTML + 内联 CSS**（htmlToContent 读 `<style>` 与内联 `style`，Velo 导出 HTML 已含）
- `htmlToContent(bodyHtml, { notes: 'footnotes', images: ... })` → docx.js `Document` → `Packer.toBlob`
- `stores/export.ts` 加 `.docx` filter + 写盘分支

**Velo 适配要点**：

- **图片**：Velo 导出用 `convertFileSrc` 转 `asset://`，htmlToContent 不下载图片 → 需在导出时把图片读成 data URI，或用 `images` 选项按地址提供。
- **mermaid**：Velo 输出内联 SVG，htmlToContent **直接识别**（实测内联 `<svg>` 和 `<img src="data:image/svg+xml;...">` 都转成 `image1.svg` + `image1.png` fallback）。**实现修正**：那个 PNG fallback 是 1×1 透明占位符（docx 自身不做光栅化），WPS 等不支持 SVG 的查看器会显示空白 —— 故 DOCX 模式用 `svgRaster.ts` 在浏览器端把 SVG 光栅化成真 PNG，失败降级回内联 SVG（见 `architecture/export.md`）。
- **脚注**：Velo 的 `<sup class="footnote-ref"><a href="#velo-fn-1">` + `<div class="footnote-definition">` 实测能被识别为 Word 脚注（见 2.8 B4）。
- **内部锚点**：`<a href="#slug">` 转成 Word `w:anchor`（实测）。

**产出**：**高保真** DOCX，CSS 样式 / 语法高亮 / alert / 公式 / 脚注都保留。

#### 5.2 阶段二：mdast2docx 路线（次选，无样式需求或 HTML 适配受阻时）

新增 `docxRenderer.ts`，直接消费 `markdownIO` 的 mdast：

- 插件组合：`table` / `list` / `math` / `image` / `emoji` / `frontmatter` / `html`（**不含 `@m2d/mermaid`**）
- **mermaid 走 pele 预渲染**：mdast 层把 `code(lang=mermaid)` 用 `renderMermaidSvg()` 渲染成 SVG → 换成 `{type:'paragraph', children:[{type:'svg', value: svg}]}` → `@m2d/image` 光栅化（**必须 paragraph 包裹，见 2.6**）
- 自定义节点预转换：`alert` → 带底纹/边框段落；`highlight` → `TextRun` 加 `shading`

**产出**：结构完整但**无样式**的 DOCX。**注意**：此路线要复刻 Velo 的样式映射，工作量集中于自定义节点。

#### 5.3 阶段三：风险对冲（按需）

若前两者维护或适配出问题，退到**自写 mdast walker → docx.js**：

- 复制 `htmlRenderer.ts` 的 walker 模式（`switch (node.type)`）
- 直接调 docx.js API 构造 `Paragraph` / `Table` / `ImageRun` / `Footnote`
- 完全控制 `alert` / `highlight` / `fold` / TOC 的 Word 语义映射

#### 5.4 关于 Rust 系方案

ferrodoc / knit-md-docx 实测后（见 2.9），**不改变 5.1 的首选结论**。knit-md-docx 列为长期架构选项：若 Velo 决定把 DOCX 导出做成 Tauri command（与 `export_pdf` 同级），可评估用它替代前端方案；届时需处理 `knit-md-docx-rs` fork 的维护风险与 Velo 自定义语法适配（`:::note` → 需预转 GFM alert 或扩展 crate）。ferrodoc 因公式 / 自定义语法缺失，不进入任何阶段。

---

### 6. 待验证问题（实现阶段执行）

- **1.8.0 升级时机**：镜像源同步后可用；升级前跑 `npm install` 验证 `@m2d/core` / `@m2d/code` 完整性。
- **`@m2d/frontmatter` 与 Velo 的 frontmatter 语义是否一致**：Velo 导出时刻意剥离 `yaml` / `toml`，需确认 mdast2docx 不会把它们写进 docx。
- **mermaid 光栅化质量**：数据流已实测打通（2.6），剩余的是 Velo 浏览器端 pele SVG → PNG 的**视觉质量与性能**（大图 / 多图文档的清晰度、耗时）。
- **`alert` 的 Word 语义映射**：单 cell 表格 + 底色 vs 带底纹段落，哪种在 Word / WPS 里更稳。
- **大文档性能**：mdast2docx 在 5000+ 段落文档上的转换耗时（是否在 UI 线程卡顿，需要 worker）。
- **Rust 下沉可行性**：若考虑把 DOCX 导出做成 Tauri command，需评估 `knit-md-docx` 的 crate 体积、编译时间、`knit-md-docx-rs` fork 的维护状态，以及 Velo 自定义语法（`:::note`）的预转换成本。
- **EPUB 是否真要**：产品决策——若确认要，单独开调研。

---

### 7. 定稿时要去哪

- 重大取舍（选定 mdast2docx / 是否自写 walker / mermaid 渲染路线 / alert 映射方式）→ 进 `DECISIONS.md` ADR。
- 最终架构（`docxRenderer.ts` / store 改造 / mermaid 预渲染链路）→ 进 `docs/architecture/export.md`。
- ROADMAP `#export-more` 条目按实际落地情况更新，本文档随功能实现后删除。

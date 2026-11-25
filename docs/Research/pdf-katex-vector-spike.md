# Spike：KaTeX 公式从位图（A 档）改矢量（B 档）的可行性评估

> **性质**：差异 3 的独立 spike 评估，**结论先行：可做，但不是小修补，是一次独立排期的产品决策**。未实施，未列入 ROADMAP 待办。
> **触发**：TS 版 PDF 导出（`src/lib/export/pdfPreview/`）与旧 WebView2 `PrintToPdf` 版对比，四大差异中差异 1/2/4 已修复，差异 3（公式位图化）单独评估。
> **本文只回答**：能不能抹平、代价是什么、值不值得、怎么做最稳。代码现状一律以 `docs/architecture/export.md`「PDF 预览 / 导出」为准。

---

## 1. 问题定义：差异 3 到底是什么

| 维度 | WebView2 版（基线） | TS 版（现状） |
| --- | --- | --- |
| 公式渲染 | Chromium 用 KaTeX 字体排的 **PDF text 算子** | 2× 画布光栅化 → JPEG（`/DCTDecode`） |
| 文本层 | 可选中 / 搜索 / 复制 | 公式不可选（`pypdf` 提取时公式处为空） |
| 放大 | 矢量，无损 | 约 190 DPI，放大模糊 |
| 主题 | 跟 `@media print`（强制 light） | 按首次 build 主题烘焙，面板切暗色不重渲染 |
| 体积 | 单份 PDF 较大（基线 2.26MB） | 省公式位图字节，但多 5 张 JPEG |

这不是 bug，是**pdfPreview 落地时刻意选的 A 档位图取舍**——把 KaTeX 当"浏览器排好的原子富片段"采样，换取架构问题（op 类型、资源字典、双后端一致、缓存边界）先闭环。要抹平差异，就要在**不依赖浏览器排版的纯 TS 链路里，重新产出公式的矢量内容流**。

**判定标准**（抹平 = 三者齐全）：① 公式走 PDF text 算子 + ② 嵌 KaTeX 字体子集 + ③ ToUnicode 可选中搜索。缺任何一项都只是"另一种降级"。

---

## 2. 关键探针数据（2026-11-20，Node 直调 `katex` 0.18.5）

探针脚本在临时目录跑 `katex.__renderToDomTree()`（KaTeX 暴露的内部 API，纯 JS 虚拟树，无 DOM 依赖）。覆盖 17 个典型公式：`E=mc²`、`\frac{a}{b}`、`\sqrt{x}`、`x^2`、`\sum_{i=1}^n`、`\int_0^1`、`\begin{aligned}`、`\vec v`、`\hat x`、`\text{中文}`、`\color{red}x`、`\xrightarrow{f}g`、`\left(\frac ab\right)`、`\overbrace{a+b}`、`\begin{matrix}`、`\binom nk`、`\cancel x`。

### 2.1 没有"切个参数就拿到 SVG"的捷径

- KaTeX `renderToString` 的 `output` 仅接受 `html | mathml | htmlAndMathml`（`types/katex.d.ts:74-82`）。
- 实测 `output:'svg'` 被静默当作非法值回退到 `htmlAndMathml`，拿不到 SVG。
- 官方**没有 SVG 视觉输出**。这是第一个硬事实：矢量方案必须从别的东西转，不是配置开关。

### 2.2 可用产物：`__renderToDomTree()` 虚拟树

- 返回纯 JS 对象（实测可 `JSON.stringify`，无函数/循环引用），节点类：`Span` / `SymbolNode` / `SvgNode` / `PathNode` / `LineNode` / `Anchor`，另有语义层 `MathNode` / `TextNode`。
- `SymbolNode` 直接携带**精确度量**（em 单位）：`text / width / height / depth / italic / skew / maxFontSize / classes / style`。例：`\frac ab` 的分子 `a` → `width 0.52859`、`height 0.43056`；`f(x)` 的 `f` → `width 0.48959`、`italic 0.10764`。
- `Span` 携带 `height / depth / maxFontSize / style`；`vlist` 的 `style.top`（如 `-2.655em`）、`pstrut.style.height`（`3em`）、子项 `height/depth` 全在树里。
- **结论：定位所需的数值信息是自包含的**，不需要浏览器 `getBoundingClientRect`。这和 A 档要跟 `.pstrut` / 假矩形 / 字体异步加载搏斗的处境完全不同——虚拟树直接给了布局器的中间结果。

### 2.3 但要自己复刻一套 CSS 布局语义

KaTeX 的视觉位置不写在节点坐标里，而由 CSS 决定，转换器必须自己算：

| 机制 | 表现 | 转换器要实现 |
| --- | --- | --- |
| 水平排布 | inline-block 自然流式 + 间距矩阵 | 按 `mord/mbin/mop/mrel...` 的 spacing table 插入 glue；`SymbolNode.italic` 做斜体校正 |
| 垂直排布 | `vlist-t`/`vlist-r`/`vlist` 用 table-cell + `style.top` | 按 `top = -pstrutSize - currPos - depth` 算每行基线 |
| 字号 | `.reset-size6 .size3 .mtight` 相乘 | 维护 size 栈，把 em 折算成 pt |
| 几何字形 | `\sqrt`/大括号/accent/`\rightarrow` 走 `SvgNode+PathNode` | 路径名 → `svgGeometry.ts` 的纯字符串 `d`，或读 `alternate d` |
| 样式 | 颜色写在 `style.color`，`\color{red}` 会继承给整棵子树 | 沿树传递 fill 颜色 |
| 类名规模 | 17 个样例共出现 **54 个 CSS 类**、58 个 `SymbolNode`、**14 个 SVG 几何节点** | 要建一张类→语义映射表，长尾类持续补 |

`14/17` 样例出现 SVG 几何节点，说明"纯文字"是少数；路径这块绕不过去。

### 2.4 路径算子可以复用 `svgToPdf.ts`

KaTeX 的 `PathNode` 给出路径名（对应 `katex/src/svgGeometry.ts` 里的字符串常量表）或 `alternate` 的 `d` 字符串。`svgToPdf.ts:pathOps()` 已实现 `M/L/C/A/Z`（含绝对/相对、弧线转贝塞尔）到 PDF 路径算子的转换，`arcToCubic` 也在。**这部分是现成的，直接复用**。

但要清醒：`svgToPdf` 的输入是"已经带绝对坐标的 SVG"（pele/mermaid 产出），它的难点不在算坐标；KaTeX 的**全部难点恰恰是生产绝对坐标**。复用它只省下路径算子那一段（约 100 行），省不了核心工作。

### 2.5 绕不开的硬成本：字体

当前 PDF 字体系统是**写死三套**：`FontKey = 'sans' | 'bold' | 'mono'`（`types.ts:7`），`fontSubset.ts:WOFF2_URLS` 三条、`tokens.ts:FONT_RES` 三条、`pdfWriter.ts:fontKeys = ['sans','bold','mono']` 三处循环注册。

KaTeX 用 **20 个专用字体族**（`KaTeX_Main/Math/AMS/Size1-4/Caligraphic/Fraktur/SansSerif/Typewriter/Script` + 各自粗斜变体，见 `katex.min.css` 的 20 条 `@font-face`）。要真矢量且外观对齐 webview 基线，必须：

1. `FontKey` 从 3 泛化到 N（建议按需子集：只把文档公式实际用到的字体族/字形纳入，而不是无脑 20 套全量）；
2. 每个字体族走现有链路：`woff2 → wawoff2(wasm) → hb-subset(wasm) → opentype.js → FontFile2 + /W + ToUnicode`；
3. `pdfWriter` 的字体对象注册、资源字典、`FONT_RES`、`toUnicodeCmap` 全部要按 font key 泛化；
4. 字符集收集（`index.ts:collectCharset`）要把公式里的字形也算进去——目前公式是位图，字符根本没进子集。

**能不能偷懒用现有三套字体画公式？** 技术上能（BASE_CHARS 已含 `∫∑√π` 及希腊字母），但花体 `\mathcal`、哥特体 `\mathfrak`、大号可伸缩分隔符都没有对应字形，会走缺字回退成 `?` 或近似字形——那只是"换了种难看"，不算抹平。字体这块的成本是**实打实的大头**，不是顺手能带过的。

---

## 3. 方案对比

| 方案 | 工作量（估算） | 精度风险 | 文本层 | 判定 |
| --- | --- | --- | --- | --- |
| A. 提高位图分辨率（`RASTER_SCALE` 2→3/4） | 几行 | 无 | ❌ | 只缓解模糊，**不解决"不可选/不可搜"**，不算抹平 |
| B. DomSpan → PDF 算子直译 | ~600–900 行 + 字体泛化 | **高**（复刻 CSS vlist/italic/spacing 语义） | ✅ | **推荐路径**，但有条件 |
| C. DomSpan → 受限 SVG → `svgToPdf` | ~400–600 行 + 字体泛化 | 同 B（多一层转义，坐标仍要自己算） | ✅ | spike 阶段可借 `svgToPdf` 快速验坐标算法 |
| D. MathML → PDF | 最大（>1000 行） | **最高** | ✅ | **排除**：MathML 是语义标记，无宽度/基线/间距，等于从零写完整数学排版引擎 |

**关键判断**：
- 这不是引擎硬限制——`pdfWriter` 已经是真 text 算子 + 嵌字体 + ToUnicode，mermaid 图内文字已经可选。差异 3 纯粹是"KaTeX 那一块还没接进 B 档"。
- 但它也不是"补个 op 分支"的小活：**核心工作量在字体系统泛化 + 复刻 KaTeX 的 CSS 布局语义**，两者都是高风险区。
- 与选型期对 mermaid B 档的评估对比：mermaid 当时的判断是"固定方言、300–400 行、逐图回归"就能上；KaTeX 的方言**不固定**（54 类、依赖 CSS 布局语义、字体 20 套），复杂度明显高一个量级。

---

## 4. 推荐路径：分阶段，带止损线

### P0 — 有限范围 spike（建议先做，1–2 人日）
- 只覆盖 `sample.md` 实际出现的命令：`\frac` / `\sqrt` / `\sum` / `\int` / 上下标 / `\begin{aligned}`。
- 写"DomSpan → PDF 算子"最小转换器（**直译，不走 SVG 中间层**），复用 `svgToPdf.ts:pathOps()` 处理根号横线/大括号。
- 字体先只接 1–2 套（KaTeX_Math-Italic + KaTeX_Main-Regular）验证链路。
- 验收方式：导出 PDF 用 `pypdf` 提取文本层确认 `π ∫ a b` 可选中；公式区域与 webview 版像素级 diff。

### P1 — 产品化（确认 P0 精度后）
- `FontKey` / `fontSubset` / `tokens` / `pdfWriter` / `collectCharset` 全链路泛化，按文档实际用到的 KaTeX 字体族按需子集。
- `fragmentBuilder.ts` 的 katex 分支改走 B 档（产出 `RichFragment.pdf`），**保留 A 档位图兜底**：转换失败/出现未覆盖类 → warnings + 回退位图，与 mermaid 的双编码器策略一致。
- 补 `previewRenderer` 对文本算子的渲染（现在公式预览用 `<img>`，矢量后要用 DOM 文本算子；注意公式预览与正文共用同一套子集字体度量）。
- 解决暗色主题：矢量方案天然跟主题色，反而能顺手修掉"位图按首次主题烘焙"的已知限制。

### P2 — 长尾与回归
- 补 54 个类的覆盖、`mhchem` 等宏包、极端字号/`\displaystyle`、暗色回归。
- 性能：字体从 3 套涨到 N 套，首次 `buildPdf()` 现在是 ~1.65s（dev），要压回可接受区间。

### 止损线（触发即停，继续用 A 档位图 + 提高分辨率）
1. P0 公式区域与 webview 版像素 diff 在 12pt 下肉眼可见偏差（>1px）且源于 vlist/italic correction 定位；
2. 字体泛化后首次 `buildPdf()` 从 ~1.65s 涨到 >3s；
3. KaTeX 版本升级导致内部 API（`__renderToDomTree`、`svgGeometry.path`）漂移，维护成本超过收益。

---

## 5. 三个问题的直接回答

**Q1：KaTeX DOM→PDF 转换器的工作量与精度风险？**
A：~600–900 行 TS（不含字体泛化），风险高但可控——风险不是"做不到"，是"复刻 CSS inline-block/vlist/italic spacing 语义"容易差 1px。虚拟树已自包含全部度量，比 A 档跟 DOM 测量搏斗更可控。字体系统是同等量级的另一块成本，必须一起算。

**Q2：能否复用 `svgToPdf.ts` 管线？**
A：**部分能**。路径算子（`M/L/C/A/Z` + 弧线转贝塞尔，~100 行）直接复用，14/17 样例有几何字形。但 `svgToPdf` 的前提是"输入已带绝对坐标"，而 KaTeX 的难点正是生产绝对坐标 + KaTeX 字体——text 定位与字体注册无法复用。想借它快速验证可以走 C 方案（先生成带坐标的 SVG 再喂进去），产品化建议 B 方案直译。

**Q3：MathML 路径的取舍？**
A：**排除**。MathML 只有语义（`<mi><mn><mfrac>`），没有任何视觉度量（宽度、基线、间距、字形），转 PDF 等于从零写数学排版引擎，比 B 方案更大且更易漂移。唯一价值是当可访问性副产物，不作为矢量渲染路径。

---

## 6. 一句话结论

**差异 3 不是硬限制，可以抹平，但它是一次独立排期的产品决策（P0 spike → P1 产品化），不是 1/2/4 那种"补实现"的修复。** 建议先做 P0 有限范围 spike 用最小代价验证定位精度与文本层收益，再决定是否投入字体系统泛化；任一止损线触发就维持 A 档位图并提高分辨率。

---

## 7. P0 实施结果（2026-11-24，代码在 `.pdfbench/katexvec/`）

**结论：P0 通过，三条止損线均未触发，建议进入 P1 评估。**

### 7.1 验收数据

| 公式 | glyph | 像素差(>32) | 占比 | 平均浓度差 |
| --- | --- | --- | --- | --- |
| `E = mc^2`（inline） | 5 | **0** | 0.00% | 0.0/255 |
| `x^2` | 2 | **0** | 0.00% | 0.0 |
| `\sum_{i=1}^n` | 5 | **0** | 0.00% | 0.0 |
| `\frac{a}{b}` | 2 | 8 | 0.00% | 0.0 |
| `\sqrt{x}` | 1 | 3 | 0.00% | 0.0 |
| `\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}` | 12 | 56 | 0.03% | 0.0 |
| `\begin{aligned}…4 行…\end{aligned}` | 60 | 41 | 0.02% | 0.0 |

- **pypdf 独立提取文本层全通过**：`π ∫ ∞ ← ∑ a b x d i j y + − , 0 1 2 n E m c` 全部可选中/搜索（判定标准①②③齐全）。
- 对比台：参考 = KaTeX HTML（foreignObject 光栅化，strut 实测基线对齐），spike = PDF 经 pdf.js；红蓝双通道叠加 + ±16px 平移搜索确认收敛。
- **基线对齐误差已消除**：全部公式最优 dy=0（残留 -1px 属亚像素）。

### 7.2 落地要点（相对调研的修正）

- **P0 实际接 3 套字体**（原估 1–2 套）：display 模式的 `\int`/`\sum` large-op 字形必须 `KaTeX_Size2-Regular`，否则缺字。链路仍为「woff2 → wawoff2(wasm) → hb-subset(wasm) → opentype.js」，零新增 Python / 静态资产。
- **定位恒等式（实测推导，写进 `katexLayout.ts` 头注释）**：vlist 行基线 `y = -(style.top + pstrut.height)`（相对 vlist 基线）；符号宽 = `(width + italic) × maxFontSize × basePt`；sizing 类 `reset-sizeM.sizeN` 按 `sizeMultipliers` 折算；`paddingLeft` 走节点自身盒；spacing 已由 buildHTML 物化为 `.mspace[marginRight]`，转换器不需要复刻 spacing 表。
- **路径算子**：`svgToPdf.pathOps` 的 M/L/C/A/Z/H/V 可直接复用（拷贝），补 `S/Q/T` 后覆盖 sqrtMain 等 alternate 路径；弧线转贝塞尔现成。
- **踩坑记录**：① `mspace` 的 marginRight 若同时算作容器宽度和父流 margin 会双重计入（每处多 4px）；② SVG-as-image 的 foreignObject 不继承文档 CSS/@font-face，参考台必须内联注入；③ 参考侧基线要用 strut 底边实测，且 `vertical-align` 的 em 基准是 `.katex` 自身的 1.21em 字号；④ SVG 路径已在 layout 内翻成 y 向上，PDF 侧 `cm` 不能再做 y 翻转（二次翻转会把根号上下颠倒）；⑤ hide-tail 的裁切矩形要落在同一 y 向上坐标系，且路径必须真正被 `re W n` 包住，否则 400em 的 overbar 会横穿页面；⑥ 100% 宽的 `frac-line` 在量宽阶段记 0 宽，vlist 居中计算必须把它排除（否则分数线从 cellW/2 起画、右侧溢出）。

### 7.3 遗留（P1/P2 边界）

- `sample-int` 宽度 +15px（supsub cellW / nulldelimiter 边界），0.02% 级。
- 未适配非 alternate 的 svgGeometry 路径（`\left(\right)` 伸缩分隔符、accent）、`\cancel` 等 17 样例以外的命令 —— 转换失败应告警回退位图（P1 的双编码器策略）。
- 中文公式（`\text{中文}`）、极端 displaystyle 尺寸未验证；字体按需子集（P1 的 `collectCharset` 扩展）未做。
- P1 的核心成本仍是字体系统泛化（`FontKey` 3→N）与 `previewRenderer` 文本算子渲染，本次未动。

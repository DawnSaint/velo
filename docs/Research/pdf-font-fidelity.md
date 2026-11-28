# PDF 预览 / 导出字形保真调研

> 目标：让 `pdf-preview` 链路（纯 TS Display List）的字体、缺字回退、emoji 与编辑器保持一致，不再降级（`?` / 同形替换），从而具备替代 WebView PrintToPdf 导出入口的条件。
>
> 结论先说：
> - **缺字 / emoji / 字体不跟随设置的根因只有一个：TS 链路拿不到系统字体**（只能读打包的 Noto Sans SC + JetBrains Mono），也没有 shaping 与彩色字形。三者都不是 PDF 格式或 TS 能力的限制。
> - **推荐 A 路线（现有 TS 引擎 + 字体保真增强）**：Rust 提供系统字体字节与平台原生 fallback 查询，TS 按 CSS 规则逐字解析字体；彩色 emoji 走 Type3 + ToUnicode（可选中 / 可搜索）；后续接 HarfBuzz shaping。所需 wasm 能力**已在现有依赖里**（`harfbuzzjs@1.6.4` 自带完整 `harfbuzz.wasm`，含 `shape` 与 `paintGlyph`）。
> - **B 路线（离屏 WebView 按编辑器 CSS 排版 + DOM 实测 + TS 分页写 PDF）** 排版一致性最高、能消掉手抄令牌表，但实测**调参重排慢 1~2 个数量级**（1MB 文档行级 ~0.5s、逐字级 ~2s）、仍然离不开 A 的字体能力，而且要自己重做 CSS 盒子的跨页绘制，工程量 XL。适合作为 A 完成后的远期选项，不适合作为下一步。
> - **C 路线（三平台补齐原生打印 + pdf.js 预览）** 保真度天然最好，但没有即时预览，WebKit 不支持 `@page` 页边距盒，页眉页脚只能在生成后再盖到 PDF 上，三平台输出彼此不同。

---

## 1. 现象与根因

| 现象 | 根因 |
|---|---|
| `① ②` 进「字库缺字」 | 正文只嵌 `NotoSansSC-Regular/Bold.woff2`（~1.1MB，精简版）+ `JetBrainsMono-Regular.woff2`；`fontSubset.ts` 的 `BASE_CHARS` 虽列了 `①…⑩`，但子集化只能从源字体里取已有的字形 |
| `✅` 缺字 | 彩色 emoji 只存在于 Segoe UI Emoji / Apple Color Emoji / Noto Color Emoji；TS 链路既读不到系统字体，`pdfWriter` 也只会写 `CIDFontType2`（单色轮廓） |
| 用户选了微软雅黑 / 苹方 / Cambria / Google Sans 等，PDF 仍是思源黑体 | `tokens.ts` 写死 `FontKey = sans / bold / mono` 三套；系统字体字节读不到；连打包字体（Google Sans、8 套等宽字体）也没有按用户设置映射 |
| WebView 导出有 emoji 且能选中 | Chromium 走系统 font fallback 找到 emoji 字体；Skia 的 PDF 后端把彩色 / 位图字形写成 **Type3 字体**（字形过程里放彩色路径或图像）并附 **ToUnicode CMap** |

**WebView 能做的三件事里，只有「系统字体访问 + 平台 fallback」是浏览器沙箱外的能力**，另外两件（Type3 彩色字形、ToUnicode）都是公开 PDF 规范，TS 可以做。

## 2. 依赖能力核实（本仓库 `node_modules` 实查）

| 能力 | 现状 | 结论 |
|---|---|---|
| Shaping（ZWJ emoji 序列 / 旗帜 / 肤色 / 连字 / kerning / 组合附加符号） | `harfbuzzjs@1.6.4` 的 `dist/` 同时带 `harfbuzz-subset.wasm`（683KB，当前在用）和 **`harfbuzz.wasm`（444KB，含 `Buffer` / `shape`）** | 无需新依赖，按需懒加载第二个 wasm |
| 彩色字形解析 | `harfbuzz.wasm` 暴露 `Font.paintGlyph` + `PaintFuncs`：COLR v0/v1 的 layer / clip / transform / 渐变（`ColorLine` / `ColorStop`），CBDT / sbix / SVG 字形经 `setImageFunc` 回调拿到 PNG / SVG 字节；`Face` 有「是否含 PNG 字形」检测 | 一套 API 覆盖 Segoe UI Emoji（COLR）、Apple Color Emoji（sbix）、Noto Color Emoji（CBDT / COLRv1） |
| 可变字体固定字重 | `harfbuzz-subset.wasm` 导出 `hb_subset_input_pin_axis_location` / `pin_all_axes_to_default` | Segoe UI Variable、新版苹方等可变字体能先固定轴再子集化 |
| opentype.js 彩色表 | `opentype.js@2.0.0` 能解析 COLR / CPAL v0，但 `toSVG` / `toDOMElement` 明确「不支持 colr layers」，CPAL 仅 v0 | 只用它做度量 / cmap，彩色字形交给 HarfBuzz paint |
| TTC 集合（msyh.ttc / PingFang.ttc / Songti.ttc） | `hb_face_create(blob, index)` 已在 `fontSubset.ts` 使用，index 目前固定 0 | 需要 Rust 侧返回正确的 face index |
| 系统字体字节 + 平台 fallback | 前端无 API（`queryLocalFonts()` 只有 Chromium 有，WKWebView / WebKitGTK 没有，且需要权限弹窗） | **必须走 Rust**，候选见 §5.2 |

## 3. 候选方案

### A. 现有 TS 引擎 + 字体保真增强（推荐）

保留「mdast → 自研布局 → Display List → 预览 / pdfWriter」，只把字体层换成「跟随用户设置 + 系统字体 + 平台 fallback」：

1. **字体注册表动态化**：`FontKey` 从固定三套改为「按用户字体栈解析出的 N 个 face（含粗体 / 斜体）」；打包字体直接用对应 woff2。
2. **Rust 字体服务**：按 family 名解析出系统字体文件（含 TTC index、可变轴），返回字节；对字体栈都没有的字符做平台原生 fallback 查询。
3. **逐字解析规则对齐 CSS**：latin 栈 → cjk 栈 → 平台 fallback（与 `fontStacks.ts` 的 `buildFontStack` 拼接顺序一致），`encodeMixed` 的「按实际字体切段」机制原样沿用。
4. **彩色 emoji**：`pdfWriter` 新增 Type3 字体资源，字形过程里放 COLR 矢量（paint 回调转 PDF 路径 / 填色 / 渐变 shading）或 sbix / CBDT 的 PNG 图像，附 ToUnicode；预览侧直接用同一系统字体的 `@font-face`（或 paint 结果）绘制。
5. **Shaping**：接 `harfbuzz.wasm`，用 glyph run 替代逐字 `glyph()`；ToUnicode 按 cluster 映射。

### B. 离屏 WebView 按编辑器 CSS 排版 + DOM 实测 + TS 分页写 PDF

把 `buildExportHtml` 的结果挂进离屏容器（宽度 = 版心宽），让 WebView 按编辑器 CSS 排版，用 `Range.getClientRects()` 拿行盒 / 字形位置，`getComputedStyle` 拿颜色 / 字号 / 背景 / 边框，TS 负责分页并写 PDF。公式导出（`katexVector.ts`）现在就是这么做的，相当于把它推广到全文。

### C. 三平台补齐原生打印 + pdf.js 预览

把 ADR-20260621-004 的 PrintToPdf 路径补到 macOS（`WKWebView.printOperation(with:)` + `NSPrintSaveJob`，macOS 11+；`createPDF` 不分页，不能用）和 Linux（WebKitGTK `webkit_print_operation_print` + GtkPrintSettings 输出到 PDF 文件），预览改为用 pdf.js 渲染生成的 PDF。

### D. 维持现状 + 同形替换 / 降级

已被需求方否决（不接受降级），只作为对照基线。

## 4. 方案对比

| 维度 | A. TS 引擎 + 字体保真 | B. DOM 实测排版 | C. 原生打印 + pdf.js | D. 现状 |
|---|---|---|---|---|
| 字体与编辑器一致 | ✅（同一字体文件、同一 fallback 规则） | ✅ | ✅（就是浏览器本身） | ❌ |
| 版式（行宽 / 断行 / 间距）一致 | ⚠️ 接近，仍靠手抄 `tokens.ts`，断行算法与浏览器不同 | ✅ 断行、间距直接取浏览器结果 | ✅ | ⚠️ |
| emoji 彩色 + 可选中 | ✅（Type3 + ToUnicode） | ✅（同 A 的写出能力） | ✅ | ❌ |
| 调参重排（边距 / 字号） | ✅ 纯计算，ms 级 | ❌ 每次重排都要 DOM 布局 + 测量，见 §5 | ❌ 每次都要重新打印 + pdf.js 渲染（秒级） | ✅ |
| 三平台输出互相一致 | ⚠️ 字体不同时不一致（这正是「跟编辑器一致」的代价） | ⚠️ 同左，且各平台排版引擎有细微差异 | ❌ 三套引擎、三套打印管线 | ✅ |
| 页眉 / 页脚 / 页码 | ✅ 现有 | ✅ 自己画 | ⚠️ Chromium 131+ 支持 `@page` 页边距盒，WebKit 不支持，需要生成后再盖到 PDF 上 | ✅ |
| 包体增量 | `harfbuzz.wasm` 444KB（懒加载）+ Rust 字体模块 | 同 A | pdf.js（~1MB+ 含 worker）+ 两个平台的原生代码 | 0 |
| 工程量 | L（分阶段，每阶段可独立交付） | XL | L | 0 |

## 5. 方案 B 性能实测与对比

### 5.1 实测

- 环境：本机 Playwright Chromium headless（与 WebView2 同引擎），版心 595px，`16px/1.75 "Microsoft YaHei"`，代码 `Consolas`。
- 语料：`src/bench/corpus/{small,medium,large}.md`，用简易 md→HTML 转换（只有标题 / 段落 / 列表 / 代码块，**没有行内格式和表格**，真实文档文本节点更多，数值偏乐观）。
- 脚本：`dom_measure_bench.py`（对话 scratch 目录，未入库）。

| 语料 | 字符数 | 文本节点 | 解析 + 布局（冷 / 热） | 块级 rect | 行级 rect（每节点一次 `getClientRects`） | 行内断点定位（二分探测） | 逐字 rect |
|---|---|---|---|---|---|---|---|
| small 100KB | 58K | 2.8K | 80ms / 21ms | 1.5ms | 3.6ms | 21ms | **176ms**（3.0µs/字） |
| medium 500KB | 293K | 13.8K | 108ms / 97ms | 8.4ms | 18ms | 115ms | **885ms** |
| large 1MB | 601K | 28K | 198ms / 225ms | 32ms | 37ms | 221ms | **~1.8s**（外推） |

一次「重排」的成本 = 布局 + 测量：

| 语料 | 行级方案（行内字距由自己的 HarfBuzz 度量补） | 逐字方案（位置全部来自 DOM） |
|---|---|---|
| 100KB | ~45ms | ~200ms |
| 500KB | ~230ms | ~1.0s |
| 1MB | ~480ms | ~2.1s |

### 5.2 与现状对比

- **调参重排**：现状 `relayout()` 是同步纯计算，sample.md 实测 4–8ms。B 每次重排都要重新跑 DOM 布局 + 测量，**慢 1~2 个数量级**，而且是主线程同步阻塞（放 iframe 也一样占主线程）。大文档拖滑块会明显卡顿，只能改成「停止拖动后再排」。
- **首次构建**：现状 `buildPdf()` 热态 0.4–0.5s，大头是 shiki / KaTeX / mermaid / 子集化，B 同样要做这些。B 省掉自研断行，但多了 DOM 布局 + 测量，**首次构建大致持平或略慢**。
- **内存**：B 要在主 WebView 里额外挂一整份导出 DOM（1MB 文档约 1.4 万个块），关闭预览前常驻。
- **结论：B 性能比现状差**。它的收益在一致性和可维护性（不用再手抄令牌表），不在性能。

### 5.3 B 在其他平台

| 平台 | 引擎 | DOM 测量 API | 风险 |
|---|---|---|---|
| Windows | WebView2（Chromium） | ✅ 已实测 | — |
| macOS | WKWebView（WebKit） | ✅ `Range.getClientRects` / `getComputedStyle` / `document.fonts` 均为标准 API | 未实测性能；WebKit 子像素取整与 Chromium 不同，行盒坐标需要容差 |
| Linux | WebKitGTK | ✅ 同 WebKit | 发行版 WebKitGTK 版本跨度大（UOS V20 只有 4.0 / 2.38，见 [uos-v20-linux-packaging](./uos-v20-linux-packaging.md)），性能通常比 Chromium 慢；软件渲染环境下布局更慢 |

共同问题：**DOM 不告诉页面某个字最终用了哪个字体**（`getComputedStyle` 只给字体栈），所以写 PDF 时的字体选择仍要自己复现浏览器的 fallback（即 A 的第 2、3 步）。复现不准时，字形宽度和 DOM 量到的位置对不上，会出现重叠或缝隙。逐字定位可以把位置钉死，但字形本身还是可能选错。

## 6. 各方案的代价

**A. TS 引擎 + 字体保真**
- Rust 侧新增三平台字体模块（定位字体文件 + 原生 fallback 查询），要新增 crate 和平台 FFI。
- `pdfWriter` 新增 Type3 资源：COLR v1 渐变要转 PDF shading，PNG 字形要转图像 XObject，工作量集中在这里。
- `FontKey` 从三套固定值改成动态注册表，`tokens.ts` / `layoutEngine` / `previewRenderer` / `fontSubset` 的签名都要跟着改，回归测试面大。
- 跟随用户字体后，**同一份文档在不同机器上导出的 PDF 不再相同**（与编辑器同理）。
- 版式仍靠手抄 `tokens.ts`，与编辑器 CSS 的漂移风险不变（export.md 已记录）。
- 嵌入系统字体要遵守 OS/2 `fsType`：禁止嵌入的字体只能转成轮廓（不可选中），或者回退到下一个字体。

**B. DOM 实测排版**
- 包含 A 的全部字体代价（§5.3）。
- 要从 computed style 重建 CSS 盒子的绘制：背景、边框、圆角、引用条、表格网格、代码块底色。块跨页时要拆开重画，等于自研一个「CSS 盒子 → PDF」的绘制器。
- 分页规则（孤行寡行、表格按行拆、代码块中间断页、标题不落页底）全部要基于 DOM 行盒重写，现有 `layoutEngine` 的分页逻辑基本不能复用。
- 调参交互变慢（§5.2），需要改交互（防抖 / 渐进分页）。
- 三平台 WebKit / Chromium 的坐标差异要做容差和回归。
- 收益：断行和间距与编辑器同源，可以删掉 `tokens.ts` 的手抄表。

**C. 原生打印 + pdf.js 预览**
- macOS（Objective-C / objc2 + NSPrintOperation，必须在主线程跑）和 Linux（WebKitGTK 打印 API）两套原生代码，加上已有的 Windows 共三套，各自踩坑。
- 预览要引入 pdf.js（~1MB+ 含 worker），每次调参都要重新打印 + 重新渲染，秒级。
- WebKit 不支持 `@page` 页边距盒：页眉 / 页脚 / 页码要在生成后再盖到 PDF 上（需要再引入 PDF 修改库）。
- 三平台输出互不相同，测试只能按平台分别回归。
- 与已选型的 Display List 架构（ADR-20261119-001）方向相反，现有预览面板的大部分代码作废。

## 7. 与现有架构的结合点（A 路线）

- `fontSubset.ts`：源字体从固定的 `WOFF2_URLS` 改为「打包 woff2 | Rust 返回的系统字体字节」两种来源，子集化 / 解析 / 缓存链路不变；`hb_face_create` 的 index 改为传入值；可变字体走 `pin_axis`。
- `tokens.ts`：`glyph()` 的回退链从 `preferred → sans → mono → SUBSTITUTES → ?` 改为「字体栈 → 平台 fallback」；`SUBSTITUTES` 与 `?` 退化为 Rust 不可用时（dev web 端）的兜底。
- `pdfWriter.ts`：资源字典从固定的 `/F1–F3`（加公式 `/F4+`）改为动态编号；新增 Type3 字体对象。
- `previewRenderer.ts`：预览 `@font-face` 继续指向「与 PDF 同一份子集字节」的 blob URL；彩色字形同样用同源数据，保证预览和导出一致。
- `src/tauri/`：新增字体服务的薄封装；按 ADR-20260616-004 的约定用 `isTauri()` 守门，web dev 端降级到打包字体。
- Rust 候选：`fontdb`（纯 Rust，三平台枚举字体，resvg / typst 在用，没有 fallback 能力）+ 平台 API 做 fallback（Windows `IDWriteFontFallback::MapCharacters`、macOS `CTFontCreateForString`、Linux fontconfig `FcFontSort`）；或 `font-kit`（servo，原生加载器更重）。需要 spike 定选型。

## 8. 风险与待验证

- **Rust 字体方案实测（2026-11-28，Windows 本机 spike：`fontdb 0.24` + `ttf-parser 0.25` + `subsetter 0.2.6`，release）**：
  - `fontdb.load_system_fonts()`：全机 400 个 face 扫描 **271ms**（进程内 `OnceLock` 只跑一次），后续 10 次 family+weight 查询共 **0.07ms**，`Microsoft YaHei` / `Cambria` / `Consolas` / `SimSun` / `Georgia` / `Segoe UI*` 全部精准命中。
  - **TTC 拆单 face 结论**：`msyh.ttc`（18.79MB）的两个 face 共享同一张 17.75MB 的 `glyf` 表，拆单 face 仍有 **18.68MB**（`msyhbd.ttc` 16.10MB → 15.98MB，`simsun.ttc` 17.47MB → 17.47MB），**只拆 face 几乎省不了体积**。
  - **Rust 侧直接子集化结论（推荐）**：`msyh.ttc` 18.79MB → **137.7KB** 仅 **1.3ms**；`msyhbd.ttc` 16.10MB → **122.8KB** 仅 **1.0–1.9ms**；`cambria.ttc` → **34.7KB** 仅 **0.5ms**；`consola.ttf` → **30.2KB** 仅 **0.3ms**。跨 IPC 体积降 ~150×、速度比 WASM 快 ~100×，且 `FontMeta` 可在 Rust 侧一并算出，前端无需再跑 `opentype.js`。
  - **`subsetter` 约束**：产物刻意去掉了 `cmap` 表，仅供 PDF `CIDFontType2` 嵌入，不能喂浏览器 `@font-face`。对于**系统字体**这不是问题——WebView 本身装有该字体，DOM 预览直接用系统 `font-family`（与编辑器 100% 同源），PDF 导出用 Rust 产出的子集 TTF；打包字体继续用现有 woff2 链路。
  - **缺字验证**：Windows 真实系统字体 `Microsoft YaHei`、`SimSun`、`Cambria` 本身就覆盖 `① ②`（U+2460/2461），换用用户系统字体后这两个字不再触发 fallback；`fontdb` 全库扫描 6 个缺字共 61ms（按需加常见符号/CJK 字体优先级即可避免落到冷门字体）。
- [ ] `harfbuzz.wasm` 与 `harfbuzz-subset.wasm` 能否共存在同一个懒加载 chunk（两套 emscripten 运行时，堆隔离），冷启动增加多少。
- [ ] COLR v1 paint → PDF 的转换覆盖面（sweep gradient 在 PDF 里没有原生对应，可能要细分扇形或局部光栅化）。
- [ ] 平台 fallback 结果与浏览器实际选择是否一致（WebView2 用 DirectWrite fallback，WebKit 用 CoreText / fontconfig，理论同源，需要抽样比对）。
- [ ] 系统字体体积：msyh.ttc ~20MB、PingFang.ttc ~70MB+。Rust 只返回子集化需要的那个 face，或者在 Rust 侧直接子集化（那就要评估 Rust 版 subsetter，例如 typst 的 `subsetter`），避免大块数据跨 IPC。
- [ ] `fsType` 受限字体的处理策略（转轮廓 vs 回退）。
- [ ] macOS WKWebView 与 WebKitGTK 上 B 方案的实测性能（本次只测了 Chromium）。

## 9. 推荐路线

1. **A 路线分阶段推进**：字体注册表动态化 + 打包字体跟随设置 → Rust 系统字体与 fallback → Type3 彩色 emoji → HarfBuzz shaping。每阶段都能单独交付；前两阶段做完就能解决「字体不一致」和「①② 缺字」。
2. A 完成后，再评估是否要用 B 的思路替换断行和版式令牌（以「删掉 `tokens.ts` 手抄表」为目标，可以只对段落行宽做 DOM 校准，不必全量迁移）。
3. 不走 C：与 Display List 架构方向相反，而且失去即时预览。
4. 达到「无降级 + 字体跟随设置」后，再讨论下线 WebView PrintToPdf 导出入口。

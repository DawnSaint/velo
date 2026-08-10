---
name: vmark-comparison-insights
description: 与 vmark 的深度对比 — 可被 Velo 借鉴的功能、范式、架构、工程门禁清单
metadata: 
  node_type: memory
  type: project
  originSessionId: 05e4e618-944a-44c2-972f-ec20b8dae506
---

# VMark 对比洞察（对 Velo 有启发 / 可借鉴项）

> 对比对象：`C:/桌面/vmark`（xiaolai/vmark，v0.9.23，ISC，"Tauri 2 + React 19 + Tiptap/ProseMirror + CodeMirror 6 + Zustand v5"）。
> 探查日期：2026-08-09。两份探查 agent 输出 + 人工核验关键文件（`extensionOrdering.ts` / `resolve.ts` / `linter.ts` / `server.ts` / `.dependency-cruiser.cjs` / `package.json` / `AGENTS.md` / `CODING_GUIDE.md`）。
> 本文件只记"可借鉴什么、为什么值得、怎么落地"，不重复 vmark 源码细节。

## 0. 先对齐：Velo vs vmark 的同与不同

**同**：都是本地优先 Markdown 编辑器；都用 Tauri 2 + ProseMirror（vmark 走 Tiptap 封装）+ CodeMirror 6 做双引擎（WYSIWYG + Source）；都重视 round-trip、CJK、大文件；都开源。

**异**（决定哪些能直接抄、哪些只是启发）：

| 维度 | Velo | vmark |
|---|---|---|
| 前端 | Vue 3 + Pinia | React 19 + Zustand v5 |
| 编辑器封装 | 原生 ProseMirror `allPlugins` 数组 | Tiptap 3 + 自研"插件描述符 + 拓扑排序解析器" |
| Markdown IR | 自研 `markdownIO.ts`（mdast ↔ PM） | 自研 `markdownPipeline/{parser,serializer,mdastToProseMirror,proseMirrorToMdast}.ts` |
| 文档 | 中文架构文档 + ADR + ROADMAP（极详） | 英文 AGENTS.md + VitePress 多语文档站 |
| 质量门禁 | type-check + vitest + 手工 review（**无 lint / 无死码检测 / 无变异测试 / 无 git hook**） | `check:all` ≈ 20 道 lint + 覆盖率地板 + 变异测试 + 依赖图 + 包体预算 + git hook（极严）|
| AI | ❌ 未做（ROADMAP P3） | ✅ MCP server sidecar（Claude/Codex/Gemini）|
| 多格式 | 仅 Markdown | Markdown + JSON/YAML/TOML/Mermaid/SVG/HTML + schema-aware 预览 |
| i18n | 未做 | 10 语言，flat-key + 翻译存在性门 |
| 导出 | HTML + Windows-only PDF | HTML + PDF（pandoc 桥，跨平台）+ 导出扩展 |
| 文档站 | ❌ | ✅ VitePress 多语站 |

**结论**：栈不同（Vue vs React）决定"插件解析器、Zustand 模式"这类 UI 层范式只能启发、不能照抄；但**工程门禁、MDAST-IR 验证范式、MCP-AI 集成面、lint 规则即 CI 公民、i18n 门、文档站**这些"框架无关"的范式，对 Velo 价值最大。

---

## 1. 最值得借鉴：工程门禁体系（Velo 最大短板）

Velo 当前门禁 = `vue-tsc` + `vitest` + 人工 review。vmark 的 `pnpm check:all` 是约 **20 道顺序门禁**（见 `package.json` `check:all` 脚本）：eslint → console → selection-styles → design-tokens → emdash → deps → extension-budget → store-coupling → deleted-names → tauri-versions → i18n → themes → keybinding-manifest → file-size → barrels → shell-slots → bespoke-buttons → knip → test:coverage → sidecar → content-server → build → eager-chunks → size。

**可借鉴的范式（按 Velo 落地难度排序）**：

### 1.1 依赖图强制分层 — `.dependency-cruiser.cjs`
- **做法**：vmark 用 dependency-cruiser 硬约束分层：`stores` 不能 import `components`；`utils/types/lib` 是叶模块，不能 import `plugins/components/stores`（有白名单 + 每条豁免必须写明原因）；`utils` 不能碰 Tauri/services/hooks/React/i18n（ADR-013）。
- **为什么值得**：Velo 的 `App.vue` 已 72KB、stores 已分化出 10 个（document/editor/export/folding/git/notify/outline/persistence/recentFiles/workspace）——没有分层约束，迟早出现 stores↔components 循环。Velo 已有 `src/tauri/` 薄封装层（`tauriOnly()`/`isTauri()`）的良好实践，dependency-cruiser 能把这类"约定"升级为"机器守门"。
- **Velo 落地启发**：不要一上来照搬 vmark 的"utils/services/hooks"三分（那是 React 栈）。按 Velo 现状定义分层：`src/tauri/`（平台层）← `src/stores/`（状态层）← `src/components/`（UI 层），加上 `src/lib/` 作为纯叶模块。先开 `no-circular` + "叶模块不 import 上层"两条规则，白名单里的豁免项必须像 vmark 一样带注释原因。

### 1.2 死码 / 重复码 / 包体预算 — knip + jscpd + size-limit
- **做法**：vmark 同时跑 `knip`（未使用导出/依赖/文件）、`jscpd`（重复代码）、`size-limit`（per-chunk 包体预算，每个上限带注释记录"何时因什么特性膨胀"）。
- **为什么值得**：Velo 已 82 个测试文件 + 10 个 store + 大编辑器插件面，死码/重复码几乎必然存在，全靠人肉。size-limit 的"带注释漂移历史"尤其值得学：包体膨胀不再是"某天突然发现大了"，而是每次 bump 都要写明原因。
- **Velo 落地启发**：先加 `knip`（误报可控）+ `size-limit`（设初始基线）；`jscpd` 阈值严一点（比如 5%），避免噪点劝退。

### 1.3 变异测试 — Stryker
- **做法**：`stryker.config.json` + `@stryker-mutator/vitest-runner`，变异子集跑 vitest。
- **为什么值得**：Velo 测试"意图扎实"但只跑 v8 覆盖率，容易高估有效性。变异测试能抓到"测试过了但其实没断言"的假绿。
- **Velo 落地启发**：重但价值高。建议作为"发版前跑"而非每次 commit 跑，避免拖慢循环。先对核心模块（`markdownIO` / `documentStore` / schema）开。

### 1.4 git hook 门禁 — `.githooks/pre-push`
- **做法**：vmark 的 `prepare` 脚本自动设 `core.hooksPath`；`pre-push` 在 push 到 `main`/`v*` 时跑 cross-target compile（`cargo check --target` 抓 macOS 上看不到的 `cfg(target_os)` 破断）+ `cargo fmt --check` + `cargo clippy -- -D warnings` + `check:all`，任一红就拒 push。特性分支不卡（CI 卡）。`--no-verify` 绕过需要明确授权。
- **为什么值得**：Velo 当前 **零 git hook**，破断只能靠 CI 事后发现。vmark 的"按目标分支分级卡"很聪明——特性分支不被本地 hook 拖慢，但主干/release 是硬墙。
- **Velo 落地启发**：照搬"分级卡"思路。Velo CI 已是 type-check → test → build，可以把这套搬进 `pre-push`（仅 main/tag）。cross-target 那步 Velo 暂时可省（Windows 单平台为主），但 `cargo clippy -- -D warnings` 值得加。

### 1.5 自定义 lint 规则即 CI 公民
- **做法**：vmark 写了一堆"脚本 lint"，每项都是一个小而专的断言：`lint:design-tokens`（禁硬编码颜色）、`lint:emdash`（中英文之间 em-dash 间距）、`lint:selection-styles`、`lint:file-size`（单文件上限）、`lint:barrels`（index 桶纯度）、`lint:shell-slots`、`lint:bespoke-buttons`、`lint:keybinding-manifest`（三文件同步）……
- **为什么值得**：这类 lint 把"代码风格 / 设计系统一致性"从 review 嘴斗变成机器判定。Velo 当前没有 formatter（无 Prettier）、没有 stylelint——CSS 变量、design token 全靠人记。
- **Velo 落地启发**：不必照搬清单，学"把约定写成脚本"的范式。Velo 当前最该先写的几条：
  - `lint:design-tokens`（Velo 已有 CSS 变量 + 暗色模式，硬编码颜色是真实痛点）；
  - `lint:file-size`（防 App.vue 这类文件继续膨胀，参考 vmark "~300 行就拆"规约）；
  - `lint:console`（提交不能留 `console.log`，Velo 已经踩过类似坑）。

---

## 2. 架构范式：插件组合的"显式顺序 + 机器校验"

### 2.1 vmark 的做法
- 每个扩展是一个**描述符对象**，带 `id` / `requires` / `ordering.bucket` / `ordering.{before,after}` / `optional` 等字段（`lib/extensions/types.ts`）。
- `resolve.ts` 是**唯一组合入口**：flatten 嵌套 group → 按 id 去重（工厂每次产生新对象，所以按身份去重会漏）→ 校验依赖/顺序引用 → **稳定拓扑排序** → 报错即空（部分排序 = 静默漏扩展，是它要防的反模式）。
- `extensionOrdering.ts`：每个组合根维护**一份规范顺序列表**（ONE auditable place），运行时 derive 出 `after` 约束；`assertCanonicalCoverage` 做"present 集合 vs 规范列表"的集合相等校验——扩展加进数组但忘了写规范列表（或反过来）会立刻报错。
- 数组物理顺序不再是加载顺序（按字母排），顺序完全由约束决定。

### 2.2 为什么对 Velo 有启发
- Velo 的 `allPlugins` 数组顺序是**隐式加载顺序**（见 `docs/ARCHITECTURE.md` 路由表上的"先记住/禁令速查"——FoldDecoration 的 module-level set 替换、插件间隐式合约等坑都源于"顺序是口约定"）。
- 随着 Velo 插件面继续扩大（ROADMAP 还有 table-enhance-2 / backlinks / ai-assist / md-lint 等），"数组位置即契约"会越来越脆。

### 2.3 Velo 落地启发（注意：不能照搬 Tiptap 封装）
- Velo 用原生 ProseMirror，不会引入 Tiptap。但**核心范式可移植**：
  1. 给每个插件加稳定 `id`（Velo 已有，见 `syntaxAutoFormat.ts` 的注册表思路）。
  2. 维护一份 **`plugins/order.ts` 规范列表**，作为"加载顺序的唯一真相源"。
  3. 写一个轻量 `resolvePlugins`：校验"注册插件集合 vs 规范列表"集合相等（防漂移）、校验依赖存在、拓扑排序。
  4. 数组物理顺序改成按字母/按类别，顺序完全由解析器决定。
- **收益**：把 `ARCHITECTURE.md` 里"禁令速查"中"改 allPlugins 顺序留意隐式合约"那类坑，从"人记住"升级为"机器报错"。
- **代价**：需要 ADR（这是"对未来版本有持续影响"的架构决策，符合 DECISIONS.md 写入标准）。

---

## 3. MDAST 作为 IR + round-trip 验证范式

### 3.1 vmark 的做法
- `src/utils/markdownPipeline/{parser,serializer,mdastToProseMirror,proseMirrorToMdast}.ts`：mdast 作为 markdown ↔ ProseMirror 的中间表示。
- **round-trip 是头等公民**：有"re-parse-identical"的 cosmetic pass（序列化后再解析，要求结构一致）。
- **NodeSafe 边界**：同一份 parser 能被 server/content 工具复用（`server/content` 内容服务），用 dependency-cruiser 强制"引擎无关的 markdown 层"不被 UI 污染。

### 3.2 Velo 现状对比
- Velo 已有 `editor/markdownIO.ts`（mdast ↔ PM）+ 扎实的 round-trip 测试（`docs/architecture/testing.md`）+ Web Worker 解析（v0.7.8，217KB 文档 6× 提速）。**这一层 Velo 并不落后，甚至 Worker 解析是领先点**。
- 差距在"NodeSafe 边界"：Velo 的 markdown 层和 UI 层是否被机器强制分开？目前靠约定。

### 3.3 Velo 落地启发
- 给 `markdownIO.ts` 再加一道 **cosmetic round-trip 断言**：序列化 → 再解析 → 比 mdast 结构（不只是"能解析"）。这是 vmark 最强调的，Velo 当前 round-trip 测试可能已覆盖，若未覆盖就补。
- 若 Velo 未来做"导出 / 内容服务 / AI 工具复用同一 parser"，用 dependency-cruiser 把 `markdownIO` 及其依赖包成叶模块，禁被 components/stores import。

---

## 4. AI 集成面：MCP 作为"AI ↔ 编辑器"的唯一边界

### 4.1 vmark 的做法
- **MCP 是 AI 集成的唯一面**（README："Settings → Integrations → Install — one click per assistant"，支持 Claude Desktop / Claude Code / Codex CLI / Gemini CLI）。
- 一个 **Node sidecar**（`server/mcp/`）：独立 pnpm 包，自己的 `package.json` / `vitest.config.ts` / `tsconfig` / 测试。通过 **bridge**（`server/mcp/src/bridge/`）用 Tauri IPC 连主 app。
- 工具集（`tools/`）：`document` / `selection` / `workspace` / `session` / `coherence` / `workflow` / `browser` —— AI 只能通过这些工具碰编辑器，**不暴露 Tauri 命令给 AI**。
- **乐观并发 STALE token**：AI 持有文档状态 token，过期则拒绝写入（防 AI 基于过期视图覆盖人类编辑）。
- E2E 测试 AI 特性**必须走 VMark MCP**（`mcp__vmark__*`），不走 Tauri harness；非 AI UI 走 Tauri MCP（`mcp__tauri__*`，调试专用，release 不带）。两个面严格分开。
- CJK formatter 暴露为 MCP `transform` 工具（AI 客户端可调用这个确定性、AI 自己写不好的改写器）。

### 4.2 为什么对 Velo 是"启发"而非"照抄"
- Velo 当前 **零 AI**（ROADMAP `#ai-assist` 是 P3）。vmark 整套 MCP sidecar 是 React + Tiptap 栈，不能直接搬。
- 但**范式高度可移植**：
  1. "AI 只能通过 MCP 碰编辑器"——这条边界设计，Velo 做 AI 时应该原样照抄（比"到处塞 AI 按钮"干净得多）。
  2. "sidecar 是独立包，自己的测试/构建"——Velo 若做 MCP，也该是独立 `server/mcp/` 包，不要混进 `src/`。
  3. "STALE token 乐观并发"——人类和 AI 共编同一文档的核心难题，Velo 未来做协作/AI 时提前想清楚。
  4. "E2E 必须走 MCP 面"——Velo 当前 E2E 只有 1 个 spec（multi-window），做 AI 特性后这条"测试面 = 用户面"原则直接可用。

### 4.3 Velo 落地启发
- **短期**（AI 还没排期）：把"MCP 是唯一 AI 边界"写进 ROADMAP `#ai-assist` 的设计约束，免得以后走弯路。
- **中期**（做 AI 时）：参考 vmark 工具集（`document/selection/workspace/session`）作为 Velo MCP 的最小工具面。
- **CJK formatter 暴露为 AI 工具**这条对 Velo 特别有吸引力：Velo 的 `lib/cjkFormatter` 已 5 组规则 + 完整性回滚，正是那种"AI 自己写不好但调用就很好用"的确定性能力——值得作为 MCP 的第一个 `transform` 工具候选。

---

## 5. 多格式 + schema-aware 预览

### 5.1 vmark 的做法
- 不止 Markdown：JSON/JSONL/YAML/TOML/Mermaid/SVG/HTML（沙箱）/纯文本/代码文件（语法高亮查看器，可切到 `$EDITOR`）。
- **Schema-aware**：`.github/workflows/*.yml` 用 `@actions/workflow-parser` + `@actions/languageservice` 渲染**工作流图**（`@xyflow/react` + `dagre`），带 goto-definition、光标同步、表达式自动完成、诊断。`Cargo.toml` / `package.json` / `pyproject.toml` 渲染**依赖树**。通用 JSON/YAML/TOML 给可导航树（`react-arborist` + `react-json-view-lite`）。
- 一个**格式注册表**（`lib/formats/registry` + `dispatchEditor`）+ 一个**适配器契约**：每种格式一个 adapter，统一渲染接口。

### 5.2 为什么对 Velo 是"启发"
- Velo 定位是"Markdown 编辑器"，**不需要**把 JSON/YAML/TOML 都吃下（否则产品定位失焦）。
- 但**两条范式可借鉴**：
  1. "已知 artifact 渲染对的视图，不是通用树"——Velo 现在 Mermaid 走 `code_block {language:'mermaid'}` + widget，这是"对的视图"思路，**已经对齐**。
  2. "格式注册表 + 适配器契约"——Velo 未来若要加新"对视图"（比如 PlantUML、CSV 表格、或 DOCX 预览），这个扩展模式比"在 FileTree 里加 if"干净。

### 5.3 Velo 落地启发
- **不建议**把 vmark 的多格式全家桶搬来（会稀释"Markdown 编辑器"定位）。
- **建议**：把 Velo 当前的"特殊格式处理"（Mermaid / HTML block / 图片 / 表格 Excel 粘贴）**抽象成格式注册表 + 适配器契约**的早期雏形。这是"加 DOCX/EPUB 预览"（ROADMAP `#export-more`）的干净起点。
- GitHub Actions 工作流图这套具体能力，Velo **不需要**（受众不对）。

---

## 6. i18n 门禁：flat-key + 翻译存在性

### 6.1 vmark 的做法
- 10 语言（en / zh-CN / zh-TW / ja / ko / de / es / fr / it / pt-BR），VitePress 站完整 locale 目录。
- **locale bundle 强制 flat key**（`"terminal.maxSessions": "…"`，禁止嵌套对象）——因为 i18next 解析嵌套优先于 flat，一个 key 两种写法会静默错误。`localeShape.test.ts` 见嵌套 / 重复 / 英文未用路径就报错。
- **翻译存在性门**：`pnpm lint:i18n` 双语——① 每个 key 每个 locale 都有值；② 值真的被翻译了（不能把英文原样 copy 过去）。第二条是因为 ~1160 个 key 曾"英文 copy 当翻译"积累而不被发现。现在 baseline（`i18n-untranslated-baseline.json`）为空，**保持为空就是门禁**（新增英文样值就失败；已翻译的 baseline 项要删，记一次 win）。≥3 词 + ≥15 字符才计，`JSON/CLI/Markdown/VMark` 不标。永不可译项进 `i18nIdenticalAllowlist.ts` 且必须写原因，双向 stale 检查。

### 6.2 Velo 现状
- Velo **零 i18n**，UI 文案硬编码中文。
- ROADMAP 未把 i18n 列为近期项。

### 6.3 Velo 落地启发
- **短期不急着做 i18i**（Velo 当前用户群、中文优先）。
- **但 flat-key + "翻译不能是英文 copy" 这两条范式，一旦做 i18n 就该直接写进规约**，别重踩 vmark 的坑。
- 特别值得记：**"baseline 保持为空"的棘轮思想**——和 Velo 测试文档里"反过度测试"同理：门禁只收不放，新债务不能加进 baseline 抵赖。

---

## 7. 内置 Markdown lint 引擎

### 7.1 vmark 的做法
- 自研 `src/lib/lintEngine/`：`linter.ts` 用 remark 解析 → `runSync`（跑 transform 让引用解析生效）→ 一次性建行索引 → 跑所有规则 → 按位置排序诊断。
- 规则集（`rules/`）：`headingIncrement` / `noDuplicateDefs` / `noEmptyLinkHref` / `noEmptyLinkText` / `noReversedLink` / `noUndefinedRefs` / `noUnusedDefs` / `noMissingSpaceAtx` / `noSpaceInEmphasis` / `requireAltText` / `tableColumnCount` / `unclosedFencedCode` / `linkFragments` / `codeBlockTracker` / `labelUtils` ……约 17 条。
- 规则输入统一 `(source, mdast, lineIndex)`，输出 `LintDiagnostic[]`。

### 7.2 为什么对 Velo 是"启发"
- Velo ROADMAP 有 `#md-lint`（P2），但**未排期**。
- vmark 的"lint 作为一等公民、规则即数组项"范式干净，但 Velo 做 lint 时不该自己造轮子——社区有 `markdownlint`（已成熟）。

### 7.3 Velo 落地启发
- **不建议**自研 lint 引擎（vmark 自研是因为要深度接自己的 MDAST 管线 + 规则定制）。Velo 做 `#md-lint` 时优先评估 **`markdownlint` 集成**（配置 `.markdownlint.json` + 自定义规则），成本低得多。
- 若未来要定制规则（比如"CJK 与数字间要空格"这类中文特有规则），vmark 的"规则签名 `(source, mdast, lineIndex) → Diagnostic`"是干净接口，可借鉴。

---

## 8. 文档站：VitePress 多语站

### 8.1 vmark 的做法
- `website/` 是完整 VitePress v1 站，`guide/` + `blog/` + `download.md` + 完整 i18n locale 目录。
- 用 `vitepress-plugin-mermaid` + `vitepress-markmap-preview` + `cytoscape`。
- `markdownlint-cli2` 给文档本身 lint。
- `public/screenshots/` + `CNAME`（`vmark.app`）。

### 8.2 Velo 现状
- Velo **零公开文档站**——只有仓库内中文架构文档（`docs/`）。
- 但 Velo 的 `docs/ARCHITECTURE.md` + 10 个模块文档 + ADR + RELEASE_NOTES，**深度远超 vmark 任何公开资料**（vmark 没有架构文档，只有 AGENTS.md 工作约定）。这是 Velo 的真正优势。

### 8.3 Velo 落地启发
- Velo 缺的不是文档深度，而是**面向用户的公开文档站**。vmark 的 VitePress 站是"用户第一印象"，Velo 当前只有 `readme.md` + CHANGELOG。
- **建议**（ROADMAP 外，但产品层面重要）：用 VitePress 起一个 `website/`，把 `docs/RELEASE_NOTES.md` 和架构文档里"用户可见"的部分（功能介绍、快捷键、安装）转成指南。**不必做多语**（vmark 做 10 语言是因为海外用户；Velo 中文优先）。
- `markdownlint-cli2` 给文档 lint 这条，Velo 现在就可以加到 `docs/`。

---

## 9. 导出：pandoc 桥 + 跨平台 PDF

### 9.1 vmark 的做法
- `src/export/` 是一整套导出面：`htmlExport` / `pandocExport` / `PdfExportDialog` / `PdfSettingsSidebar` / `pdfPresets` / `htmlSanitizer` / `fontEmbedder` / `katexFontEmbedder` / `resourceResolver` / `themeSnapshot` / `editorCSSBundle` / `createExportExtensions` / `exportOverrides` / `exportResourceWarnings` / `waitForAssets` / `reader/` ……
- **PDF 跨平台走 pandoc 桥**（而非平台原生打印），所以 macOS/Linux/Windows 都能出 PDF。
- HTML 导出复用同一 unified 管线（和 Velo 的 `htmlRenderer.ts` 思路一致），DOMPurify，KaTeX 字体 base64 内嵌，shiki/mermaid 渲染。
- 导出扩展（`createExportExtensions`）：导出时可以按需裁剪/追加 ProseMirror 扩展。
- 资源解析器（`resourceResolver`）：本地/远程资源收集 + 警告。

### 9.2 Velo 现状对比
- Velo 已有 HTML 导出（`lib/export/htmlRenderer.ts`，同思路）+ **Windows-only PDF**（Tauri `with_webview` 原生 `PrintToPDF`，macOS/Linux 返回 `PdfError::Unsupported`，见 `docs/architecture/export.md` ADR-20260621-004）。
- Velo 的 PDF 方案优点是"原生、零依赖"，代价是"锁死 Windows"。

### 9.3 Velo 落地启发
- **pandoc 桥是 Velo `#export-more`（ROADMAP P3，DOCX/EPUB）和跨平台 PDF 的干净起点**。Velo 已经在用 unified 管线，接 pandoc 比从零造 DOCX 容易得多。
- 不建议把 Velo 现有 Windows PDF 方案废弃（原生打印质量高、零依赖），但 **macOS/Linux PDF 可以用 pandoc 桥补全**。
- vmark 的"导出扩展 + 资源解析器 + 字体内嵌"三件套，Velo 做 DOCX/EPUB 时直接参考。

---

## 10. 大文件性能：自适应防抖 + content-visibility + 延迟解析

### 10.1 vmark 的做法
- 自适应防抖（`services/assembly/` + 大文件会话 `markdownLargeFile`）、`content-visibility: auto` 做渲染裁剪、大文件延迟解析。
- 有 bench 套件（`src/bench/editor.bench.ts` / `markdown.bench.ts`）+ 大文件语料生成器（`scripts/gen-large-file-corpus.mjs`）+ 打开延迟测量（`scripts/measure-open-latency.mjs`）。

### 10.2 Velo 现状对比
- Velo 在大文件上**并不落后**：pendingPmDoc 去重（C0）、>2000 行 canonical 跳过（C0b）、增量 + viewport-aware decoration（`docScanCache.ts` + `incrementalDeco.ts` + `viewportPlugin`）、Web Worker 解析（217KB 6× 提速）。见 `docs/architecture/` ADR-20260729-001 / ADR-20260806-001 / ADR-20260806-002。
- 差距：Velo **没有 bench 套件和大文件语料**，性能优化靠"个案驱动"而非"基线守护"。

### 10.3 Velo 落地启发
- **加 bench 套件**是 Velo 性能方向最该补的一环：`src/bench/markdown.bench.ts` + 大文件语料生成器。否则下次"优化"可能只是"感觉快了"。
- `content-visibility: auto` 是 CSS 层面零成本优化，Velo 的 FileTree 虚拟滚动已经做了类似的事，编辑器视口可评估是否加。

---

## 11. 历史 / 撤销：跨模式统一历史 + 双向光标同步

### 11.1 vmark 的做法
- WYSIWYG ↔ Source 切换时**统一历史栈**（不各自一套 undo）。
- 双向光标同步：给节点挂 `sourceLine` 属性，切换时按源码行定位。

### 11.2 Velo 现状对比
- Velo 已有跨模式光标同步：`crossModeSync.ts` 用 **LCS（最长公共子序列）** 把光标 token 对齐到对端，best-effort、降级线性。见 ADR-20260621-002。
- Velo 当前 undo 是**各模式独立**（PM 一家、CM6 一家）。

### 11.3 Velo 落地启发
- 光标同步 Velo 的 LCS 方案**不比 vmark 的 sourceLine 差**（甚至更鲁棒，因为不依赖节点属性）。保持现状。
- **跨模式统一历史**是真实痛点（用户在 WYSIWYG 撤销期望回到 Source 之前的状态，实际做不到）。但实现代价高（两套 undo 栈合并语义复杂）。建议列入 ROADMAP 调研，**不急于做**。

---

## 12. 不该借鉴 / 不适合 Velo 的部分

明确列出"看完了决定不抄"的，避免以后重复讨论：

| vmark 特性 | 不借鉴原因 |
|---|---|
| React 19 + Zustand + Tiptap 全套 | Velo 是 Vue 3 + Pinia + 原生 PM，栈不同，UI 层范式只启发不照搬 |
| 多格式全家桶（JSON/YAML/TOML/SVG/HTML 查看器） | 稀释"Markdown 编辑器"定位 |
| 10 语言 i18n | Velo 中文优先，短期不需要；flat-key 范式记下备用 |
| 自研 Markdown lint 引擎 | 社区 `markdownlint` 更成熟，Velo 做 `#md-lint` 优先集成 |
| GitHub Actions 工作流图 | 受众不对 |
| 嵌入式终端（`@xterm/xterm`） | 超出编辑器范畴 |
| Slidev 内容服务（`server/content`） | 超出范畴 |
| 全特性 MCP（browser / workflow） | Velo 做 AI 时只取最小工具面 |

---

## 13. 按优先级排列的"Velo 落地路线图"

把上面所有启发收敛成一个**分批落地**的清单。每项标注"代价 / 收益 / 依赖"。

### P0 — 马上能做、收益最大（工程门禁基础）
1. **加 ESLint + Prettier**（Velo 当前 0 formatter/linter）—— 代价低，先把代码风格机器化。
2. **加 knip**（死码检测）—— 误报可控，代价低。
3. **加 size-limit 基线**（per-chunk 包体预算 + 注释漂移历史）—— 建立"包体不能无声膨胀"的文化。
4. **加 `lint:design-tokens` + `lint:console` 两个自定义脚本** —— Velo 已有 CSS 变量 + 暗色模式，硬编码颜色是真实痛点。
5. **加 bench 套件**（`src/bench/markdown.bench.ts` + 大文件语料生成器）—— 守护已有的大文件优化。

### P1 — 一个迭代内值得做（架构健康）
6. **加 dependency-cruiser**：先开 `no-circular` + "叶模块（`src/lib/`）不 import 上层（`src/stores|components`）"两条规则，白名单带注释原因。
7. **加 git hook 门禁**（分级卡：特性分支不卡，main/tag 卡 type-check + test + `cargo clippy -- -D warnings`）。
8. **插件组合引入"规范列表 + 轻量解析器"**：给 `allPlugins` 加稳定 id、维护 `plugins/order.ts` 规范列表、校验集合相等防漂移（需要 ADR）。
9. **markdownIO 加 cosmetic round-trip 断言**（若尚未覆盖）：序列化 → 再解析 → mdast 结构一致。
10. **加 markdownlint-cli2 给 `docs/` lint**。

### P2 — 中期（产品能力）
11. **VitePress 文档站**（中文单语即可，把 RELEASE_NOTES + 功能介绍转成用户指南）。
12. **pandoc 桥接 DOCX/EPUB 导出**（ROADMAP `#export-more`）+ macOS/Linux PDF 补全。
13. **markdownlint 集成**（ROADMAP `#md-lint`），优先社区方案，中文特有规则自写。
14. **Stryker 变异测试**（先对 `markdownIO` / `documentStore` / schema 核心模块开，发版前跑）。

### P3 — 长期 / 等 AI 排期
15. **MCP 作为 AI 唯一边界**（设计约束先写进 ROADMAP `#ai-assist`）。
16. **CJK formatter 暴露为 MCP `transform` 工具**（第一个候选）。
17. **STALE token 乐观并发**（人类 + AI 共编）。

---

## 14. 关键源文件索引（vmark，供后续深读）

| 关注点 | vmark 路径 |
|---|---|
| 插件描述符类型 | `src/lib/extensions/types.ts` |
| 插件拓扑排序解析器 | `src/lib/extensions/resolve.ts` |
| 规范顺序 + 集合相等校验 | `src/services/assembly/extensionOrdering.ts` |
| 双根组合入口 | `src/services/assembly/{tiptapExtensions,sourceEditorExtensions}.ts` |
| Markdown IR 管线 | `src/utils/markdownPipeline/{parser,serializer,mdastToProseMirror,proseMirrorToMdast}.ts` |
| Markdown lint 引擎 | `src/lib/lintEngine/linter.ts` + `rules/` |
| MCP server | `server/mcp/src/server.ts` + `tools/` |
| MCP bridge | `server/mcp/src/bridge/` |
| 依赖图约束 | `.dependency-cruiser.cjs` + `.dependency-cruiser-known-violations.json` |
| 包体预算 | `.size-limit.cjs` |
| 变异测试 | `stryker.config.json` |
| 死码/重复 | `knip.json` / `.jscpd.json` |
| 导出套件 | `src/export/{htmlExport,pandocExport,PdfExportDialog,htmlSanitizer,fontEmbedder,katexFontEmbedder,resourceResolver,createExportExtensions}.ts` |
| 格式注册表 | `src/lib/formats/registry` + `src/services/formats/formatSettingsBridge.ts` |
| CJK formatter | `src/lib/cjkFormatter/{formatter,rules}/` |
| i18n 门 | `scripts/check-i18n-keys.ts` + `scripts/i18n-untranslated-baseline.json` + `scripts/i18nIdenticalAllowlist.ts` |
| 文档站 | `website/`（VitePress v1）|
| 工作约定 | `AGENTS.md` / `CODING_GUIDE.md` |

---

## 15. 一句话总结

vmark 比 Velo 领先的**不是功能面**（Velo 的表格深度、CJK 一级特性、Worker 解析、Installer/Shell 集成、架构文档深度都反超），而是**"把约定变成机器守门"的工程化密度**（依赖图强制分层、死码/重复/包体预算、变异测试、git hook、自定义 lint 规则）。Velo 最该从 vmark 学的，是**把"人记住的规矩"升级为"CI 拒绝的门禁"**——功能可以慢慢加，但工程门禁的债越晚还利息越高。
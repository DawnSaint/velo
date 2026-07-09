# CLAUDE.md

## 加载指引

在开始任何任务之前：

1. **读文档**。文档分两档：
   - **必读**：用 Read 工具读取完整内容
     - [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 架构入口；读完后按改动范围继续读本文件或对应 `docs/architecture/*.md` 模块
   - **按需读取**
     - [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 当前 / 下一版本的迭代方向
     - [`docs/DECISIONS.md`](./docs/DECISIONS.md) — 重大架构决策与重大重构的 ADR
     - [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — 版本变更日志
     - [`docs/architecture/testing.md`](./docs/architecture/testing.md) — 测试目标、规约、边界与 E2E；动测试文件 / 测试基建（`vitest.config.ts`、`src/test/setup.ts`）或改 schema / markdownIO 后跑 round-trip 时读
     - [`docs/architecture/styles.md`](./docs/architecture/styles.md) — SCSS / Tailwind / scoped style / TS 行内样式分工、暗色模式、CSS 变量、class 命名约定；动任何样式来源或加 / 删 class 时读
     - `docs/research/*.md` — 复杂功能的 pre-implementation 调研文档，从 ROADMAP 对应条目链接进入；开发该功能前读
2. 当涉及 ProseMirror 插件链、数据流、NodeView/Decoration、Tauri、FileTree、导出、样式等模块时，先在 ARCHITECTURE.md 路由表中找到对应模块，再查模块顶部的“先记住 / 禁令速查”，避免踩已经记录过的坑。如果模块文档找不到时再选择查找 DECISIONS.md。

## 仓库速览

- **项目**：Velo — 基于 Vue 3 + Tauri 2 + ProseMirror 的本地 markdown 编辑器
- **主分支**：`master`
- **目录入口**：`src/App.vue`、`src/components/ProseMirrorEditor/`、`src-tauri/`


## 文档同步规则

**任务完成后，必须同步以下文档，否则视为任务未完成：**

### 1. 架构文档 — 架构层变动必须同步

满足以下任一情况就要更新 `docs/ARCHITECTURE.md` 或对应 `docs/architecture/*.md` 模块；只有新增 / 删除 / 重命名模块或路由变化时才更新模块路由：

- 新增 / 删除 / 重命名 ProseMirror 插件或 NodeView，调整 `allPlugins` 数组顺序 → `docs/architecture/editor.md`
- 修改 markdown 解析 / 序列化管线（`editor/markdownIO.ts`、unified pipeline、新增 remark 插件）→ `docs/architecture/editor.md`；影响导出时同步 `docs/architecture/export.md`
- 改动 schema（新节点类型 / mark / attrs 语义）→ `docs/architecture/editor.md`
- 修改数据流（`documentStore`、`lastSavedContent` / `echosToAccept` / `lastSelfEmitted` 等同步语义）→ `docs/ARCHITECTURE.md`
- 修改 FileTree / workspace / 搜索 / 导出 / Tauri 端能力时，更新对应 `file-tree.md` / `workspace-search.md` / `export.md` / `tauri.md`
- 修复一个"非显然"的 bug，并且对应解决方案值得作为踩坑记录沉淀 → 写进对应模块的"设计要点"或"维护者注意点"

更新时使用渐进式披露：文件顶部保留“本文件负责 / 何时阅读 / 先记住 / 相关文件”的概括；详细取舍放到下方对应小节。除全局概览 / 数据流基础外，不要把其他模块长篇细节塞回 `docs/ARCHITECTURE.md`。

**写作要求（精炼，不是工作日志）**：

- 描述**当前架构的最终状态**，不记改动历史；后续修改覆盖前面的内容时只保留最新描述，不堆叠"原 X 现改 Y"的演进叙事
- 不重述代码里已有注释的实现步骤（函数名 / 行号 / handler 注册顺序 / 内部判断分支等），只写设计的取舍与"踩过的坑"
- 每条要点一节聚焦一个关键点：取舍理由 + 触发坑，砍掉步骤化叙述；已有条目覆盖新情况时合并而非新开
- 版本号标注（`v0.4.x` 等）不进正文，演进记录归 CHANGELOG / DECISIONS

### 2. ROADMAP.md — 版本任务推进必须同步

- 完成 ROADMAP 中已列出的某条 `- [ ]` → 改为 `- [x]`，不要删除条目
- 某版本全部 feat/fix/refactor 收口发布后：从 ROADMAP 删掉该版本整章；该版本涉及的"重大决策 / 重大重构"用写入 DECISIONS；普通 feat/fix 进 CHANGELOG
- 实现过程中发现 ROADMAP 原计划无法落地或方案改了 → 用删除线 + `→` 注明实际走法
- 临时新增的、原计划没列的功能 / 重要 fix → 追加到 CHANGELOG 当前版本对应分组下（不再回 ROADMAP）


### 2.1 调研文档（docs/research/）— 复杂功能的 pre-implementation 研究

- **何时写**：开发复杂功能前（涉及多模块 / 候选方案对比 / 外部依赖选型），先在 `docs/research/` 下写调研文档，作为设计参考
- **如何引用**：在 ROADMAP.md 对应功能条目末尾加 `—— [调研](./research/xxx.md)` 链接，ROADMAP 是调研文档的唯一入口
- **文件命名**：`docs/research/<feature-name>.md`，一个功能一篇，不设总索引文件
- **何时删**：功能实现后随版本发布一并删除调研文档（与 ROADMAP 整章删除同步）；调研中的重大取舍沉淀到 DECISIONS ADR，最终架构同步到 `docs/architecture/*.md`
- **调研文档写什么**：候选方案对比、第三方依赖评估、与现有架构的结合点、风险点、推荐路线；不写实现步骤（实现后进 architecture docs）


### 3. CHANGELOG.md — 用户可见的版本变更日志（Keep a Changelog）

- 按 [Keep a Changelog](https://keepachangelog.com/) 格式 + [SemVer](https://semver.org/) 记录版本变更，分组：Added / Changed / Deprecated / Removed / Fixed / Security / Dependencies，按需选择
- 写入时机：版本发布时整批入（与 ROADMAP 整章删除同步），不要零散追加
- 内容粒度：能让用户"看懂这个版本加了/改了什么"即可；纯内部重构如无用户可见影响可不写
- **只写用户可见的事项本身，不写背后的实现细节**：不出现函数名 / 行号 / 内部机制 / 代码级步骤（如 `tr.delete 误用 absolutePos`、源码行号引用等）；实现取舍进 DECISIONS，踩坑进 ARCHITECTURE
- 普通的"为什么这样设计"取舍不进 CHANGELOG（进 DECISIONS）

### 4. DECISIONS.md — 重大决策的 ADR 留痕

#### 写入标准（四项缺一不可）

只记"重大架构决策 + 重大重构"，走 Context / Decision / Consequences 三段（精简版 MADR）：

- 候选方案 ≥ 2 个
- 选择对未来 1+ 个版本有持续影响
- 踩坑点非显然（普通 bug fix 不进）
- 实现细节已在 `docs/architecture/*.md` 中，ADR 只保留**为什么选这条路**

编号 `ADR-YYYYMMDD-NNN`，按写入顺序递增。写入时机：**版本发布时整批入**（与 ROADMAP 整章删除、CHANGELOG 同步），不要零散追加。改 ADR（修正事实 / 补充后果）直接在原条目改，不要新开条目覆盖。

#### 不应写入 DECISIONS.md 的清单

满足以下任一条就**不进** DECISIONS：

- **纯配置变更**：Cargo.toml 一行 feature flag、package.json 版本号等
- **纯 bug fix**：虽然修复过程可能有一番推理，但最终是"改一行/加一个判断"的级别
- **实现细节**：RO 监听器用什么 event、toolbar 挂哪个 side、RAF 节流几毫秒——这些进 `docs/architecture/*.md` 的"设计要点/维护者注意点"
- **已被后续 ADR 覆盖的旧方案**：如 mermaid 节点→widget 被 mermaid→code_block 覆盖，旧 ADR 直接删
- **单方案决策**：没有候选方案对比的决定（例如"我们决定加一个 X 功能"）——这是 ROADMAP/CHANGELOG 的事
- **已稳定功能的首版实现描述**：如 shiki 预扫+懒加载、代码块工具条几何同步——这些的"当前实现"在 architecture docs 里，"为什么选这条路"如无候选方案对比也不需要 ADR

#### 防臃肿规则

- **每个 ADR 控制在 5-12 行**。如果 Consequences 里写了超过 3 条实现细节，就把它们移到对应 `architecture/*.md`，只保留架构级后果（如"跨平台一致性受影响""后续可替换为 X 不改变 UI 契约"）
- **发版时做一次回顾审计**：逐个检查已有 ADR，是否有"已被后续推翻的"→ 直接删；是否有"Consequences 里全是实现细节的"→ 裁到决策理由
- **如果 ADR 里出现函数名、DOM 事件名、CSS class 名、配置字段名**，几乎一定写得太细了——这些归 architecture docs
- **如果一条 ADR 的 Context + Decision 加起来不超过两句话就能说清**，说明它不需要 ADR——可能是 CHANGELOG 条目或 architecture doc 的一句注意事项

### 5. 测试文档 — 测试规约与现状同步

- `docs/architecture/testing.md` 是测试文档唯一 canonical source（测试目标 / 选型 / 现状快照 / Tauri 隔离层 / 目录命名 / 维护约定 / 反过度测试 / E2E）
- 同步触发：新增 / 删除测试文件、动测试基建（`vitest.config.ts` / `src/test/setup.ts`）、测试规约本身变化时更新 `docs/architecture/testing.md`；纯加用例不触发同步，发版时更新该文件的现状快照数字
- 反过度测试原则（测行为不测实现、最便宜层优先、不测薄封装、敢删死重用例）见 `docs/architecture/testing.md`，新增测试前对照



## 代码修改约定

- **改动尽量小而精确**：不顺手重构无关代码；ROADMAP 没列的"清理"先询问
- **修 bug 先看对应架构模块的"先记住 / 禁令速查"**：很多看起来是 bug 的行为是有意为之（例如 mermaid 走 widget 不走 NodeView、echo 哨兵机制、写盘前推进 `lastSavedContent` 等）
- **加注释克制**：只在"非显然的设计取舍"处写注释，不要解释代码本身在做什么
- **测试**：`__tests__/` 里有现成的 round-trip / 回归合约测试，改 schema / markdownIO 后跑 `vitest run` 确认全部通过
- **类型严格**：TypeScript strict 模式，`vue-tsc --noEmit` 必须 0 错

### 新增语法支持 checklist

> 一条新语法落地，需要 check 一遍涉及哪些层避免遗漏
> checklist 不是规约，多数简单语法只碰其中 2-3 个文件


| # | 涉及层 | 文件 | 何时需要动 |
|---|--------|------|-----------|
| 1 | **schema** | `editor/schema.ts` | 新增节点类型 / mark / attrs |
| 2 | **NodeView / widget** | `nodes/*.ts` 或 `editor/imageNodeView.ts` 等 | 需要特殊视觉(数学渲染 / mermaid SVG / 任务 checkbox / 链接源编辑) |
| 3 | **remark 插件**(外部解析) | `plugins/remark*.ts` + `editor/markdownIO.ts` 里 `.use()` | mdast 树需要重写(如 alert / preserveEmptyLine)或补缺 |
| 4 | **markdownIO 双向** | `editor/markdownIO.ts` | 新节点要进 fromMarkdown / toMarkdown；新 mark 要在 pmInlineToMdast 加分支 |
| 5 | **syntax registry**(实时键入) | `syntax/{block，inline}/*.ts` + `syntax/index.ts` | 用户键入也要转(块级 / 行内带匹配) |
| 6 | **ProseMirror 插件** | `EditorInner.vue` 的 `allPlugins` 数组 | 需要新装饰 / 行为插件(查找高亮 / 自动补全 / 原子保护) |
| 7 | **keymap** | `EditorInner.vue` | 新快捷键(如 `$$` + Enter) |
| 8 | **测试** | `__tests__/*.ts` | 每条语法至少 1 happy + 1 反例；`markdownIO` 改动必加 round-trip |
| 9 | **CHANGELOG** | `docs/CHANGELOG.md` 当前版本对应分组（发布后写） | 发版时该语法的 feat/fix 走 `git log` 即可；属用户可见变更按分组写入 CHANGELOG |
| 10 | **ARCHITECTURE** | `docs/architecture/editor.md`（必要时联动 `docs/ARCHITECTURE.md` 路由） | 跨节点依赖 / 触发时机反直觉 / 新黑名单维度 / 非显然设计取舍；**纯模板化不需要改** |
| 11 | **DECISIONS** | `docs/DECISIONS.md` | 候选方案 ≥ 2 的"为什么走 X 不走 Y"取舍（非显然决策），走 ADR 格式；普通语法不进 |

**容易遗漏的项**:
- 第 5 列注册——`syntax/index.ts` 没 `registerXxx` = 不生效，且无警告，纯静默
- 第 4 列双向——`fromMarkdown` 加了，`toMarkdown` 忘了，文件保存再加载会丢数据
- 第 9 列留痕——发版时该语法的 feat/fix 走 `git log` 即可；属用户可见变更按分组写入 CHANGELOG，属"重大决策"取舍另写入 DECISIONS ADR 块（"为什么走 X 不走 Y"不写在 commit message 里）
- 第 10 列过度——简单语法也写一段架构说明反而稀释文档信号

**已落地的语法参照**:
- `mermaid` 涉及 schema(`code_block { language: 'mermaid' }`，无独立节点) + remark(走 mdast code) + markdownIO 双向 + mermaidDecoration plugin(扫 code_block 渲染 SVG widget，不走 syntax)。codeHighlight 工具条 + mermaid SVG widget 双 widget 共存(不同 side)
- `alert` 涉及 schema + remark(remarkAlert) + markdownIO 双向 + syntax/block/alert + 注册
- `footnote` 涉及 schema + NodeView + FootnoteNumberPlugin + syntax/inline/footnoteRef + 注册
- `_italic` / `~~strike~~` 涉及 schema + syntax/inline + 注册(无 NodeView / 无 remark)
- `` `code` `` 涉及 schema(已有 `code` mark,`excludes:'_'` 独占) + syntax/inline/code + 注册 + markSourceEdit session(进 enter 守卫 `isBlacklisted` 需放行 `code` mark,只挡 `code_block`/`math_block` 容器)。无 NodeView / 无 remark(remark-parse 原生 inlineCode);markdownIO 双向已由 `inlineNodeToPM`/`wrapWithMarks` 处理,改 syntax 不碰 markdownIO 但 round-trip 用例已覆盖
- `[TOC]` 涉及 schema + Decoration.widget(TocDecoration) + markdownIO 双向 + syntax/block/toc + 注册(无 NodeView / 无 remark)



## Commit Message 格式规约

```
<type>(<scope>): <summary>

- English bullet 1
- English bullet 2
...

- 中文 bullet 1
- 中文 bullet 2
...

<footer>
```

- **type**：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `build` / `ci` / `release` 等
- **scope**：模块名，如 `editor` / `sidebar` / `tauri` / `markdownIO` / `testing` 等
- **summary**：1 句小写英文祈使句，描述"这次 commit 干了什么"
- **footer**（可选）：
  - `BREAKING CHANGE: <说明>` — 触发 major
  - `Closes #x` / `Refs #x` — 关联 issue
  - 依赖变更（包括 `Cargo.toml` / `package.json`）写一行 `Deps: xxx@yyy`



## 版本发布

### 前提

- 所有 feat / fix / test / refactor 已单独提交
- `master` 上的 commit 已通过测试和类型检查
- **发版收口的 docs 改动暂存即可、不 commit**：CHANGELOG 把 `[Unreleased]` 改成 `[<new-version>] — YYYY-MM-DD`、ROADMAP 删整章、DECISIONS 追加 ADR —— 这几处改完 `git add` 但**不要** `git commit`，让 `npm version` 把它们和 version bump、Tauri 版本同步一起合并到唯一的 `release(v%s):` commit 里
- 不允许残留任何**非发版收口**的未提交改动；如果有，先按它本来该走的 Conventional Commits 类型单独提了再发版

### 流程

```bash
# 1. 改 docs 收口（CHANGELOG / ROADMAP / DECISIONS）
git add docs/

# 2. 发版（preversion 跑测试 / 类型检查 / 构建；通过后 bump + commit + tag + push）
npm version <level> -f -m "release(v%s): <summary>"
```

- `npm version` 串行触发：
  1. **preversion**：`type-check` + `test` + `build`，任一失败中止，不会改任何文件
  2. bumped `package.json` version
  3. **version** lifecycle：`scripts/sync-tauri-version.mjs` 同步 Tauri 版本 + `git add` 同步过的文件
  4. `git commit`（捕获**当前整个暂存区**：version bump + 同步的 Tauri 文件 + 第 1 步预先暂存的 docs 收口改动）+ `git tag`
  5. **postversion**：`git push --follow-tags` 自动推 commit 和 tag
- 单 commit 同时包含：版本号 bump（4 处：`package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json`）+ docs 收口（CHANGELOG / ROADMAP / DECISIONS）

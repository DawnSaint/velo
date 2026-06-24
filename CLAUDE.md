# CLAUDE.md

## 加载指引

在开始任何任务之前：

1. **读文档**。文档分两档：
   - **必读**：用 Read 工具读取完整内容
     - [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 技术栈、目录结构、ProseMirror 插件链、数据流与设计要点等
   - **按需读取**
     - [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 当前 / 下一版本的迭代方向
     - [`docs/DECISIONS.md`](./docs/DECISIONS.md) — 重大架构决策与重大重构的 ADR
     - [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — 版本变更日志
     - [`docs/TESTING.md`](./docs/TESTING.md) — 测试规约与维护约定；动测试文件 / 测试基建（`vitest.config.ts`、`src/test/setup.ts`）或改 schema / markdownIO 后跑 round-trip 时读
2. 当涉及 ProseMirror 插件链、数据流、NodeView/Decoration 取舍等时，先在 ARCHITECTURE.md 的"设计要点"和"维护者注意点"里查一遍，避免踩已经记录过的坑。如果 ARCHITECTURE 找不到时再选择查找 DECISIONS.md。

## 仓库速览

- **项目**：Velo — 基于 Vue 3 + Tauri 2 + ProseMirror 的本地 markdown 编辑器
- **主分支**：`master`
- **目录入口**：`src/App.vue`、`src/components/ProseMirrorEditor/`、`src-tauri/`


## 文档同步规则

**任务完成后，必须同步以下文档，否则视为任务未完成：**

### 1. ARCHITECTURE.md — 架构层变动必须同步

满足以下任一情况就要更新 `docs/ARCHITECTURE.md`：

- 新增 / 删除 / 重命名 ProseMirror 插件或 NodeView，调整 `allPlugins` 数组顺序
- 修改 markdown 解析 / 序列化管线（`editor/markdownIO.ts`、unified pipeline、新增 remark 插件）
- 改动 schema（新节点类型 / mark / attrs 语义）
- 修改数据流（`documentStore`、`lastSavedContent` / `echosToAccept` / `lastSelfEmitted` 等同步语义）
- 修改 Tauri 端能力（`capabilities/*.json`、新 command、`tauri.conf.json` 协议）
- 修复一个"非显然"的 bug，并且对应解决方案值得作为踩坑记录沉淀（写进"设计要点"或"维护者注意点"）

更新时对齐已有结构：技术栈表格、目录结构、ProseMirror 插件链表、数据流、设计要点、维护者注意点。不要新开顶级章节，能塞进现有段落就塞进去。

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


### 3. CHANGELOG.md — 用户可见的版本变更日志（Keep a Changelog）

- 按 [Keep a Changelog](https://keepachangelog.com/) 格式 + [SemVer](https://semver.org/) 记录版本变更，分组：Added / Changed / Deprecated / Removed / Fixed / Security / Dependencies，按需选择
- 写入时机：版本发布时整批入（与 ROADMAP 整章删除同步），不要零散追加
- 内容粒度：能让用户"看懂这个版本加了/改了什么"即可；纯内部重构如无用户可见影响可不写
- **只写用户可见的事项本身，不写背后的实现细节**：不出现函数名 / 行号 / 内部机制 / 代码级步骤（如 `tr.delete 误用 absolutePos`、源码行号引用等）；实现取舍进 DECISIONS，踩坑进 ARCHITECTURE
- 普通的"为什么这样设计"取舍不进 CHANGELOG（进 DECISIONS）

### 4. DECISIONS.md — 重大决策的 ADR 留痕

- 只记"重大架构决策 + 重大重构"，走 MADR 格式（Status / Context / Decision / Consequences 四段）
- 判定标准：候选方案 ≥ 2 个、选择对未来 1+ 个版本有持续影响、踩坑点非显然（普通 bug fix 不进）
- 编号 `ADR-YYYYMMDD-NNN`，按写入顺序递增
- 写入时机：**版本发布时整批入**（与 ROADMAP 整章删除、CHANGELOG 同步），不要零散追加
- 改 ADR（修正事实 / 补充后果）直接在原条目改，不要新开条目覆盖；如有"已被新决策取代"用 `Superseded by ADR-XXX` 在 Status 里标注

### 5. TESTING.md — 测试规约与现状同步

- TESTING.md 记**稳定的测试规约**（选型、Tauri 隔离层、目录命名、维护约定、反过度测试原则）+ 一句话现状快照（文件数 / 用例数 / 耗时）；**不记阶段勾选式进度表**，向前的测试规划走 ROADMAP
- 同步触发：新增 / 删除测试文件、动测试基建（`vitest.config.ts` / `src/test/setup.ts`）、测试规约本身变化时更新；纯加用例不触发同步，发版时更新现状快照数字
- 反过度测试原则（测行为不测实现、最便宜层优先、不测薄封装、敢删死重用例）见 TESTING.md，新增测试前对照



## 代码修改约定

- **改动尽量小而精确**：不顺手重构无关代码；ROADMAP 没列的"清理"先询问
- **修 bug 先看 ARCHITECTURE 的"设计要点"**：很多看起来是 bug 的行为是有意为之（例如 mermaid 走 widget 不走 NodeView、echo 哨兵机制、写盘前推进 `lastSavedContent` 等）
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
| 10 | **ARCHITECTURE** | `docs/ARCHITECTURE.md` | 跨节点依赖 / 触发时机反直觉 / 新黑名单维度 / 非显然设计取舍；**纯模板化不需要改** |
| 11 | **DECISIONS** | `docs/DECISIONS.md` | 候选方案 ≥ 2 的"为什么走 X 不走 Y"取舍（非显然决策），走 ADR 格式；普通语法不进 |

**容易遗漏的项**:
- 第 5 列注册——`syntax/index.ts` 没 `registerXxx` = 不生效，且无警告，纯静默
- 第 4 列双向——`fromMarkdown` 加了，`toMarkdown` 忘了，文件保存再加载会丢数据
- 第 9 列留痕——发版时该语法的 feat/fix 走 `git log` 即可；属用户可见变更按分组写入 CHANGELOG，属"重大决策"取舍另写入 DECISIONS ADR 块（"为什么走 X 不走 Y"不写在 commit message 里）
- 第 10 列过度——简单语法也写一段"设计要点"反而稀释文档信号

**已落地的语法参照**:
- `mermaid` 涉及 schema(`code_block { language: 'mermaid' }`，无独立节点) + remark(走 mdast code) + markdownIO 双向 + mermaidDecoration plugin(扫 code_block 渲染 SVG widget，不走 syntax)。codeHighlight 工具条 + mermaid SVG widget 双 widget 共存(不同 side)
- `alert` 涉及 schema + remark(remarkAlert) + markdownIO 双向 + syntax/block/alert + 注册
- `footnote` 涉及 schema + NodeView + FootnoteNumberPlugin + syntax/inline/footnoteRef + 注册
- `_italic` / `~~strike~~` 涉及 schema + syntax/inline + 注册(无 NodeView / 无 remark)
- `[TOC]` 涉及 schema + Decoration.widget(TocDecoration) + markdownIO 双向 + syntax/block/toc + 注册(无 NodeView / 无 remark)



## Commit Message 格式规约

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <summary>

<body>

<footer>
```

- **type**：`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `build` / `ci` / `release`
- **scope**（可选）：模块名，如 `editor` / `sidebar` / `tauri` / `markdownIO`；不写 version
- **summary**：1 句小写英文祈使句，描述"这次 commit 干了什么"，不带句号
- **body**（可选）：背景 / 取舍说明 / 非显然之处；段落式英文
- **footer**（可选）：
  - `BREAKING CHANGE: <说明>` — 触发 major
  - `Closes #x` / `Refs #x` — 关联 issue
  - 依赖变更（包括 `Cargo.toml` / `package.json`）写一行 `Deps: xxx@yyy`



## 版本发布

### 前提

- 所有 feat / fix / test / refactor 已按 Conventional Commits 单独提交（这些 commit 已 push 也行，未 push 也行；不强求 push）
- `master` 上的 commit 已通过测试和类型检查
- **发版收口的 docs 改动暂存即可、不 commit**：CHANGELOG 把 `[Unreleased]` 改成 `[<new-version>] — YYYY-MM-DD`、ROADMAP 删整章、DECISIONS 追加 ADR —— 这几处改完 `git add` 但**不要** `git commit`，让 `npm version` 把它们和 version bump、Tauri 版本同步一起合并到唯一的 `release(v%s):` commit 里
  - 不允许残留任何**非发版收口**的未提交改动；如果有，先按它本来该走的 Conventional Commits 类型单独提了再发版

### 流程

```bash
# 1. 改 docs 收口（CHANGELOG / ROADMAP / DECISIONS）
git add docs/

# 2. 发版（preversion 跑测试 / 类型检查 / 构建；通过后 bump + commit + tag + push）
npm version <level> -m "release(v%s): <summary>"
```

- `<level>` 为 `patch` / `minor` / `major`，按 SemVer 判断（feat → minor / fix → patch / BREAKING CHANGE → major）
- `npm version` 串行触发：
  1. **preversion**：`type-check` + `test` + `build`，任一失败中止，不会改任何文件
  2. bumped `package.json` version
  3. **version** lifecycle：`scripts/sync-tauri-version.mjs` 同步 Tauri 版本 + `git add` 同步过的文件
  4. `git commit`（捕获**当前整个暂存区**：version bump + 同步的 Tauri 文件 + 第 1 步预先暂存的 docs 收口改动）+ `git tag`
  5. **postversion**：`git push --follow-tags` 自动推 commit 和 tag
- 单 commit 同时包含：版本号 bump（4 处：`package.json` / `package-lock.json` / `Cargo.toml` / `Cargo.lock` / `tauri.conf.json`）+ docs 收口（CHANGELOG / ROADMAP / DECISIONS）
- 发版 commit message 模板示例：

```
release(v0.5.2): search enhancements + tree DnD

Highlights:
- in-editor find/replace ranking by relevance
- file tree drag-to-move with conflict prompt

Deps: prosemirror-view@1.42.0
```

详细 user-facing 变更写进 `docs/CHANGELOG.md`，commit message 只放高亮。




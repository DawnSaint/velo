# CLAUDE.md

## 加载指引

在开始任何任务之前：

1. **读文档**。文档分两档：
   - **必读**：用 Read 工具读取完整内容
     - [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 架构入口；读完后按改动范围继续读本文件或对应 `docs/architecture/*.md` 模块
   - **按需读取**
     - [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 当前 / 下一版本的迭代方向
     - [`docs/DECISIONS.md`](./docs/DECISIONS.md) — 重大架构决策与重大重构的 ADR
     - [`docs/RELEASE_NOTES.md`](./docs/RELEASE_NOTES.md) — 面向用户的中文版本日志
     - [`docs/architecture/testing.md`](./docs/architecture/testing.md) — 测试目标、规约、边界与 E2E；动测试文件 / 测试基建（`vitest.config.ts`、`src/test/setup.ts`）或改 schema / markdownIO 时读
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

**更新条件** — 满足以下任一情况就要更新 `docs/ARCHITECTURE.md` 或对应 `docs/architecture/*.md` 模块；只有新增 / 删除 / 重命名模块或路由变化时才更新模块路由：

- 新增 / 删除 / 重命名 ProseMirror 插件或 NodeView，调整 `allPlugins` 数组顺序 → `docs/architecture/editor.md`
- 修改 markdown 解析 / 序列化管线（`editor/markdownIO.ts`、unified pipeline、新增 remark 插件）→ `docs/architecture/editor.md`；影响导出时同步 `docs/architecture/export.md`
- 改动 schema（新节点类型 / mark / attrs 语义）→ `docs/architecture/editor.md`
- 修改数据流（`documentStore`、`lastSavedContent` / `echosToAccept` / `lastSelfEmitted` 等同步语义）→ `docs/ARCHITECTURE.md`
- 修改 FileTree / workspace / 搜索 / 导出 / Tauri 端能力时，更新对应 `file-tree.md` / `workspace-search.md` / `export.md` / `tauri.md`
- 修复一个"非显然"的 bug，并且对应解决方案值得作为踩坑记录沉淀 → 写进对应模块的"设计要点"或"维护者注意点"

维护规范见 `docs/ARCHITECTURE.md` 顶部「全局约定」。

### 2. ROADMAP.md — 版本任务推进必须同步

**更新条件**：
- 某版本全部 feat/fix/refactor 收口发布后：从 ROADMAP 删掉该版本整章；该版本涉及的"重大决策 / 重大重构"写入 DECISIONS；根据修改内容更新 RELEASE_NOTES
- 纳入某版本时在 `docs/RELEASE_NOTES.md` 顶部新增 `## v<version>` 章节把条目移入（如果版本存在则直接写入对应章节），发版时删除本文档中已实现功能
- 临时新增的、原计划没列的功能 / 重要 fix → 通过 Conventional Commits 的 commit message 体现，发版时人工归入 RELEASE_NOTES（不再回 ROADMAP）
- 复杂功能开发前先在 `docs/research/` 写调研文档；功能实现后随版本发布一并删除（与 ROADMAP 整章删除同步）

维护规范与调研文档写法见 `docs/ROADMAP.md` 顶部。


### 3. 版本日志 — 双轨制

项目维护两份版本日志，各司其职：

| 文件 | 维护方式 | 语言 | 内容 | 用途 |
|------|---------|------|------|------|
| `CHANGELOG.md`（repo 根） | release-please 自动生成 | 英文（取自 commit summary） | 每条 commit 一行 + hash 链接 | GitHub Release 页面 / 机器可读 |
| `docs/RELEASE_NOTES.md` | 人工手写 | 中文 | 用户可见变更的详细描述 | 面向用户的版本日志 |

**更新条件**（`docs/RELEASE_NOTES.md`）：
- 发版前从 `git log` / commit message 提取用户可见变更，手写中文条目
- 纯内部重构如无用户可见影响可不写
- 普通的"为什么这样设计"取舍不进 RELEASE_NOTES（进 DECISIONS）

维护规范见 `docs/RELEASE_NOTES.md` 顶部。

### 4. DECISIONS.md — 重大决策的 ADR 留痕

**更新条件** — 只记"重大架构决策 + 重大重构"，四项缺一不可：

- 候选方案 ≥ 2 个
- 选择对未来 1+ 个版本有持续影响
- 踩坑点非显然（普通 bug fix 不进）
- 实现细节已在 `docs/architecture/*.md` 中，ADR 只保留**为什么选这条路**

不应写入 DECISIONS 的清单：

- **纯配置变更**：Cargo.toml 一行 feature flag、package.json 版本号等
- **纯 bug fix**：虽然修复过程可能有一番推理，但最终是"改一行/加一个判断"的级别
- **实现细节**：RO 监听器用什么 event、toolbar 挂哪个 side、RAF 节流几毫秒——这些进 `docs/architecture/*.md` 的"设计要点/维护者注意点"
- **已被后续 ADR 覆盖的旧方案**：如 mermaid 节点→widget 被 mermaid→code_block 覆盖，旧 ADR 直接删
- **单方案决策**：没有候选方案对比的决定（例如"我们决定加一个 X 功能"）——这是 ROADMAP/RELEASE_NOTES 的事
- **已稳定功能的首版实现描述**：如 shiki 预扫+懒加载、代码块工具条几何同步——这些的"当前实现"在 architecture docs 里，"为什么选这条路"如无候选方案对比也不需要 ADR

其他更新条件：
- 写入时机：**版本发布时整批入**（与 ROADMAP 整章删除、RELEASE_NOTES 同步），不要零散追加
- 发版时做一次回顾审计：逐个检查已有 ADR，已被后续推翻的→直接删；Consequences 全是实现细节的→裁到决策理由
- 如果一条 ADR 的 Context + Decision 加起来不超过两句话就能说清，说明它不需要 ADR

维护规范见 `docs/DECISIONS.md` 顶部。

### 5. 测试文档 — 测试规约与现状同步

**更新条件**：
- `docs/architecture/testing.md` 是测试文档唯一 canonical source（测试目标 / 选型 / 现状快照 / Tauri 隔离层 / 目录命名 / 维护约定 / 反过度测试 / E2E）
- 新增 / 删除测试文件、动测试基建（`vitest.config.ts` / `src/test/setup.ts`）、测试规约本身变化时更新 `docs/architecture/testing.md`；纯加用例不触发同步，发版时更新该文件的现状快照章节

维护规范（含反过度测试原则）见 `docs/architecture/testing.md`，新增测试前对照。



## 代码修改约定

- **改动尽量小而精确**：不顺手重构无关代码；ROADMAP 没列的"清理"先询问
- **修 bug 先看对应架构模块的"先记住 / 禁令速查"**：很多看起来是 bug 的行为是有意为之（例如 mermaid 走 widget 不走 NodeView、echo 哨兵机制、写盘前推进 `lastSavedContent` 等）
- **加注释克制**：只在"非显然的设计取舍"处写注释，不要解释代码本身在做什么
- **测试**：开发中只跑改动相关的测试文件（如 `vitest run markdownIO`），尽量不主动跑全量测试；`vitest run` 全量 + `vue-tsc --noEmit` 仅在明确需要 commit 时执行
- **类型严格**：TypeScript strict 模式；`vue-tsc --noEmit` 0 错是 commit 前门，开发中不主动跑

### 新增语法支持 checklist

新增 markdown 语法时涉及的层（schema / NodeView / remark / markdownIO / syntax registry / 插件 / keymap / 测试等）、容易遗漏的项与已落地语法参照，见 `docs/architecture/editor.md`「新增语法支持 checklist」。



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

- **type**：`feat` / `fix` / `perf` / `revert` / `docs` / `style` / `refactor` / `chore` / `test` / `build` / `ci`（与 release-please 默认 changelog sections 对齐）
- **scope**：模块名，如 `editor` / `sidebar` / `tauri` / `markdownIO` / `testing` 等
- **summary**：1 句小写英文祈使句，描述"这次 commit 干了什么"
- **footer**（可选）：
  - `BREAKING CHANGE: <说明>` — 触发 major
  - `Closes #x` / `Refs #x` — 关联 issue
  - 依赖变更（包括 `Cargo.toml` / `package.json`）写一行 `Deps: xxx@yyy`



## 版本发布

### 发版流程（release-please 自动化）

1. 所有 commit 走 Conventional Commits（见上方格式规约），release-please 自动解析推 semver（feat → minor / fix → patch / `BREAKING CHANGE` → major）
2. push 到 `master` 后，release-please bot 自动维护一个长期存在的 release PR：
   - 自动 bump 版本号（`package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`）
   - 自动生成根目录 `CHANGELOG.md`（英文，从 commit summary 提取；`docs/RELEASE_NOTES.md` 不受影响，始终人工维护）
3. 人工 review release PR → merge → release-please 自动创建 tag + GitHub Release
4. tag push 触发 CI 跨平台构建流水线（见 ROADMAP「CI 跨平台发布流水线」节）

### 文档收口

**release-please 自动处理**（merge release PR 时）：
- 版本号 bump：`package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`
- 根目录 `CHANGELOG.md`：自动生成英文条目（从 commit summary 提取）

**发版前手动处理**（merge release PR 前，改完推到 `master`，release-please 会自动纳入 release PR）：
- `docs/RELEASE_NOTES.md`：将 `[Unreleased]` 改为 `[X.Y.Z] — YYYY-MM-DD` 并补充中文条目
- `docs/ROADMAP.md`：删掉该版本整章
- `docs/DECISIONS.md`：追加该版本的 ADR（如有重大决策）

### 强制版本号

在 commit message footer 加 `Release-As: x.y.z` 可强制指定版本号（逃生口）。

### 手动发版（应急）

正常使用 release-please 自动发版。如需手动发版（如 release-please 故障）：
1. `npm run type-check && npm run test && npm run build`
2. 手动改 `package.json` 版本号
3. `node scripts/sync-tauri-version.mjs`（同步 Tauri 三文件，含 Cargo.lock）
4. 手动改 `docs/RELEASE_NOTES.md` / `docs/ROADMAP.md` / `docs/DECISIONS.md`
5. `git commit -m "chore(release): bump version to vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags`

### 配置文件

- `.github/workflows/release-please.yml` — push 到 master 触发
- `release-please-config.json` — release-type / extra-files
- `.release-please-manifest.json` — 版本起点

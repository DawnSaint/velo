# Git 集成调研

> **性质**：pre-implementation 设计研究，候选方案尚未拍板。后续若决定实现，重大取舍进 `DECISIONS.md` ADR，最终架构同步 `ARCHITECTURE.md`。
> **对应 ROADMAP**：Git 集成（侧栏显示 git status / commit / diff）
> **调研日期**：—
> **当前状态**：初版。

---

## 一、功能定义

ROADMAP.md 描述："Git 集成（侧栏显示 git status / commit / diff）"。结合项目现状：

- **git status**：侧栏展示工作区中各文件的变更状态（modified / staged / untracked / deleted）
- **git commit**：侧栏或面板中提供提交操作（编写 commit message、暂存文件、执行 commit）
- **git diff**：可视化查看文件变更内容（行级对比、增删高亮）

---

## 二、第三方开源方案

### 方案 A：Rust 后端 — `git2-rs`（libgit2 bindings）

| 项目 | 说明 |
|------|------|
| **仓库** | [rust-lang/git2-rs](https://github.com/rust-lang/git2-rs) — Rust 对 libgit2 C 库的绑定，star 1.3k+ |
| **优势** | 与 Tauri Rust 后端天然契合；所有 git 操作在 Rust 层完成，无需系统 git；支持 status / diff / log / commit / merge 全套 API；性能好 |
| **劣势** | libgit2 是 C 库，交叉编译增大二进制体积（约 +2-5MB）；部分高级功能（shallow clone / partial clone）不支持；需写 Rust command 层桥接到前端 |
| **已有实践** | 有开发者用 Tauri + git2 实现了 git clone 进度展示（[掘金文章](https://juejin.cn/post/7354929098099032076)），证明可行性 |

### 方案 B：JS 前端 — `isomorphic-git`

| 项目 | 说明 |
|------|------|
| **仓库** | [isomorphic-git.org](https://isomorphic-git.org/) — 纯 JS 实现 git，可在 Node 和浏览器运行 |
| **优势** | 无需 Rust 层，直接在前端调用；支持 clone / init / commit / statusMatrix / log / push / merge 等核心操作；与现有 `.git` 目录完全兼容 |
| **劣势** | 大仓库性能较差（解析 packfile 在内存中完成）；不支持 SSH 认证 / rebase / submodule；Tauri 环境中需 polyfill Node.js fs 模块 |
| **已有实践** | Obsidian Git 插件在移动端使用 isomorphic-git（桌面端用系统 git），证明可行但需注意性能边界 |

### 方案 C：调用系统 git CLI

| 项目 | 说明 |
|------|------|
| **方式** | 通过 Tauri `plugin-shell` 执行 `git status` / `git diff` / `git commit` 等命令，解析 stdout |
| **优势** | 最简单、功能最完整（与用户 git 版本一致）；零额外依赖 |
| **劣势** | 依赖用户系统安装 git；需处理不同平台输出格式差异；shell 调用有进程开销；安全风险需审慎配置 |
| **已有实践** | VS Code 桌面版、Obsidian Git 桌面端均采用此方式 |

### Diff 展示组件

| 库 | 说明 |
|----|------|
| **react-diff-view** | 支持 unified / split 视图，渲染 git diff 格式 |
| **react-diff-viewer-continued** | 基于 emotion 样式的 diff 查看器，支持 split / inline、语法高亮 |
| **diff2html** | 将 `git diff` 输出转成 HTML，不依赖 React / Vue，纯渲染层 |
| **CodeMirror 6 Diff** | Velo 已用 CM6（源码模式），可直接用其 diff 适配器展示文本变更 |
| **Monaco DiffEditor** | 功能强大但包体积大（~2MB），对 Markdown 编辑器偏重 |

**推荐**：CodeMirror 6 diff 适配器（项目已有 CM6 依赖，零额外体积）或 diff2html（纯渲染、轻量）。

---

## 三、其他编辑工具的实现程度

| 编辑器 | Git 集成程度 | 实现方式 |
|--------|------------|---------|
| **VS Code** | 最完整：source control 面板、gutter 变更指示、行级 diff、commit UI、3-way merge、分支管理、remote sync | 系统 git CLI + SCM Extension API |
| **Obsidian** | 社区插件 `obsidian-git`：source control 视图、history 视图、diff 视图、gutter signs、自动 commit / sync | 桌面：系统 git；移动：isomorphic-git |
| **Zettlr** | 无内置 git 集成，需用户自行配合 git CLI 或 GitHub Desktop | 无 |
| **Typora** | 无内置 git 集成 | 无 |
| **Markor (Android)** | 无 git 集成 | 无 |

**结论**：Markdown 编辑器中，只有 Obsidian 通过社区插件实现了完整的 git 集成；Typora / Zettlr 等主流编辑器都没有内置此功能。VS Code 作为代码编辑器是标杆，但对 Markdown 写作工具而言过于重型。

---

## 四、Velo 项目中的适配分析

### 当前架构

- 侧栏目前有 **2 个 tab**：`文件` / `大纲`，通过 `SidebarTab = 'outline' | 'files'` 控制
- 侧栏组件在 `Sidebar.vue`，互斥渲染（`v-if`）
- workspace store 管理 per-workspace 状态，包括 `sidebarTab`

### 添加 Git tab 的改动点

1. **类型扩展**：`SidebarTab` 增加 `'git'`，`persistence.ts` 需更新
2. **Sidebar.vue**：tab 条从 2 项扩展到 3 项，indicator 动画需适配 3-way sliding
3. **新组件**：`GitPanel.vue` — git status 列表、commit 输入、diff 入口
4. **后端层**：新增 Tauri command（如用 git2-rs）或 JS 层 isomorphic-git 调用
5. **新 store**：`gitStore` — 管理 status 数据、commit message、分支信息等
6. **文件树联动**：FileTree 中已有文件列表，git status 可叠加装饰（颜色标记 modified / untracked）

---

## 五、完成该功能的意义

| 维度 | 分析 |
|------|------|
| **用户需求** | Markdown 写作者普遍有版本管理需求（防止误删、追踪思路演进、多人协作）。目前用户需手动开终端 / git 工具，体验割裂 |
| **差异化** | Typora / Zettlr 无此功能，内置 git 集成是 Velo 的差异化卖点，尤其对"知识库"定位（v0.5.6 双链方向）的用户 |
| **工作区闭环** | v0.5.x 系列目标是"从单文件编辑器跃迁到目录级工作区"，git 是工作区管理的重要闭环 — 文件树 + 大纲 + 资产面板 + git 构成完整的 workspace 体验 |
| **安全兜底** | 配合现有的 DraftRecovery，git 提供更可靠的长期安全网 |

---

## 六、实现代价评估

| 维度 | 代价 |
|------|------|
| **开发量** | 中等偏高。MVP（status + commit + 行级 diff）估计：Rust command 层 ~500 行、Vue 组件 ~800 行、store ~200 行、类型 / 持久化适配 ~100 行。总计 ~1600 行新代码 |
| **二进制体积** | git2-rs 方案增加 ~2-5MB（libgit2 静态链接）；isomorphic-git 方案增加 ~200KB JS；CLI 方案零增量 |
| **维护复杂度** | git2-rs 需跟随 libgit2 更新 / 处理交叉编译；isomorphic-git 有已知功能缺口（SSH / rebase）；CLI 方案需处理多平台兼容 |
| **UI 复杂度** | diff 视图是 UI 重头 — 行级对比、语法高亮、split / inline 切换；commit UI 相对简单（文本输入 + 文件列表） |
| **性能风险** | 大仓库（>1000 文件）的 status 扫描需异步 + 增量策略，否则 UI 卡顿；diff 渲染大文件也需虚拟滚动 |
| **scope 风险** | git 功能容易无限扩展（branch 管理 / merge / remote push 等），需严格界定 MVP 边界 |

---

## 七、推荐方案

### MVP 策略：采用系统 git CLI 方案起步

理由：

- Velo 是桌面应用（无移动端），系统 git 可用率高
- 开发成本最低，不增加二进制体积
- 功能覆盖最完整，天然支持用户已有的 git 配置（SSH key / credential helper 等）
- 可通过 Tauri `plugin-shell` 调用，项目已有此依赖

### 技术路径

1. Rust 层新增 command：`git_status` / `git_diff` / `git_commit` / `git_log`，各命令调用系统 git 并解析输出
2. 新建 `gitStore` 管理 git 状态数据
3. 侧栏新增 `Git` tab，渲染 `GitPanel.vue`（status 列 + commit 输入 + diff 入口）
4. Diff 展示优先复用 CodeMirror 6 diff 适配器（已有依赖），或用 diff2html 渲染 git diff 输出
5. 文件树叠加 git status 装饰（颜色标记 modified / staged / untracked）

### MVP 功能边界

- git status（文件变更列表）
- git commit（暂存 + 提交消息输入）
- git diff（当前文件 diff 查看）
- git log（最近 N 条提交记录）

### 不包含（留给后续迭代）

- branch 管理
- remote push / pull
- merge / stash
- gutter 行级变更指示

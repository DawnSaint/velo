# Velo Roadmap

> Velo 的迭代规划：功能 backlog、工程化、已知问题统一在此追踪。
>
> **维护规范**:
> - 每条 `- [ ]` 完成后改 `- [x]`，不要删除条目
> - 实现过程中发现原计划无法落地或方案改了 → 用删除线 + `→` 注明实际走法
>
> **调研文档**（`docs/research/`）:
> - **如何引用**: 在对应功能条目末尾加 `—— [RESEARCH](./research/xxx.md)` 链接，ROADMAP 是调研文档的唯一入口
> - **文件命名**: `docs/research/<feature-name>.md`，一个功能一篇，不设总索引文件
> - **写什么**: 候选方案对比、第三方依赖评估、与现有架构的结合点、风险点、推荐路线；不写实现步骤（实现后进 architecture docs）



## 图例

> 每条功能标注优先级、复杂度、依赖关系，便于排期决策。实际以调研结论为准。

| 标记 | 含义 |
|------|------|
| `P0` | 阻塞分发或核心地基 — 必须最先做 |
| `P1` | 核心差异化方向 — 高优先 |
| `P2` | 体验增强 — 中优先，按需排期 |
| `P3` | 远期方向 / 低频需求 |
| `S` | 轻量 — 单文件 / 单模块，路径明确 |
| `M` | 中等 — 跨 2-3 模块，路径清晰但需分步实现 + 验证 |
| `L` | 重型 — 跨子系统或需 PoC 验证，需多轮迭代实现 |
| `XL` | 超大 — 大功能集，需调研 + 实现 + 回归 |
| `?` | 方案未定 — 需先调研 / PoC 验证才能确定实现路径；与复杂度标记正交 |
| `← #id` | 依赖前置条目完成 |
| `→ #id` | 阻塞后续条目 |
| `↔ #id` | 共享数据层 / 协同实现 |



## 依赖链速览

> 关键路径：从分发地基到远期方向的解锁顺序。横向 `→` 表示阻塞，纵向表示优先级递减。

```
P0  #ci-pipeline ──────────────────────────────────────────> 阻塞所有对外分发
                                                                │
P1  #settings-panel ──→ #dark-mode-follow · #font-ui · #theme-presets · #theme-market
    #workspace-index ──→ #backlinks · #wikilink · #workspace-symbol · #broken-link · #asset-orphan
                                                                │
P2  #system-tray ──→ #daily-note
    #git-integration ──↔── #local-timeline ──→ #recent-locations
    #wikilink ──→ #go-to-def · #find-refs
    #block-drag · #table-enhance · #md-lint · #changelog-popup（独立）
    #dark-mode-follow · #font-ui（← #settings-panel）
                                                                │
P3  #ai-assist · #export-more · #pdf-preview · #bookmark（独立）
    #theme-market · #theme-presets（← #settings-panel）
```



## 已知问题

> 已发布功能中待修复的缺陷 / 限制 / 平台缺口。

- [ ] **Mac / Linux 文件夹右键菜单「在 Velo 中打开」未实现**（Windows 已支持） `P2` `S` `← #ci-pipeline`



## P0 — 分发地基

### CI 跨平台发布流水线 `#ci-pipeline` `P0` `L`

> 首次对外分发前必须做。Tauri 桌面应用的核心交付物是平台二进制，靠本地一次构建发布是反模式（缺平台、缺签名、易污染、无审计）。

**目标**：tag push 触发 GitHub Actions 跨平台构建 + 自动创建 GitHub Release + attach 安装包。

**落地步骤**：

1. `.github/workflows/release.yml`：
   - 触发：`push: tags: ['v*']`（与 release-please 衔接，merge release PR → 自动打 tag → 触发该 workflow）
   - matrix：`windows-latest` / `macos-latest` / `macos-14`(arm64) / `ubuntu-22.04`
   - 用 `tauri-apps/tauri-action@v0`，配置 `tagName: v__VERSION__` / `releaseName: 'Velo v__VERSION__'`
   - 产物：Windows `.msi` + `.exe`、macOS `.dmg` (x64 + arm64)、Linux `.AppImage` + `.deb`
2. 签名（可选但推荐）：
   - Windows: code signing certificate（avoid SmartScreen 警告），证书走 GitHub Secrets
   - macOS: Apple Developer ID + notarization（避免 Gatekeeper 拦截），需要 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets
   - Linux 通常不需要
3. 更新通道（可选）：
   - Tauri Updater plugin + `latest.json` 上传到 GitHub Release / S3 / 自有服务器
   - 配 `tauri.conf.json` 的 `updater.endpoints` + 公钥
4. CHANGELOG 自动注入 Release body：release-please 已生成的 CHANGELOG 片段直接传给 `tauri-action` 的 `releaseBody`
5. **`#e2e-ship-gate` E2E 验收（Windows，消费刚构建的产物）** — vitest 在 `ci.yml` 当每个 PR 的廉价门；E2E 是二进制冷启动 /  WebView2 /  fs round-trip /  single-instance 路由的集成链，跑不快且只需验一次 → 挂到 `release.yml` 的 `windows-latest` 作业上，等 macOS / Linux / Windows 构建全部完成后，下载 Windows 产物起 WebDriver 跑 `e2e/specs/multi-window.spec.ts`。
  - **Phase 1：`continue-on-error`（report 结果，不阻塞 release attach；WebView2 + msedgedriver 链路历史上偶发 flaky —— contextmenu 不触发 / interactability 偶报 / driver 版本强匹配 —— 先观测通过率再做 gate）；
  - Phase 2：稳定后移除 `continue-on-error`，纯实拍门**。前置外部二进制：`cargo install tauri-driver`（tauri-driver.exe，WebDriver Classic 代理）+ **与 runner WebView2 Runtime 匹配的 msedgedriver.exe**（放进 runner PATH）。appData 隔离走 `e2e/helpers/appdata.ts` 的 snapshot/restore，同一次 runner 不串扰
6. 首次跑通后在 README 加 download badge / install 说明

**风险点 / 注意**：

- macOS arm64 build runner 时长收费较高，按需开
- Tauri build 在 CI 第一次跑会装 rust toolchain + 依赖，注意 cache `~/.cargo` 和 `src-tauri/target`，否则单次 build 20+ min
- 签名密钥泄漏风险高，secrets 必须 environment-scoped + required reviewers
- Apple notarization 异步，CI job 要等回执，超时设到 30+ min



## P1 — 核心差异化

### 设置面板重做 `#settings-panel` `P1` `M`

> `→ #dark-mode-follow` `→ #font-ui` `→ #theme-presets` `→ #theme-market`
>
> 当前设置面板已有基本形态（v0.5.11 做过一轮重做），但结构不足以承载后续个性化方向。目标：做成可扩展的分组结构（分组 + 插件式注册），后续所有个性化功能都能挂进去。

- [ ] 设置面板架构重做：分组容器 + 可扩展注册机制，新设置项只需注册一行
- [ ] 工具栏重做（与设置面板一同规划视觉一致性）

### 知识库 — 工作区索引 `#workspace-index` `P1` `L`

> `→ #backlinks` `→ #wikilink` `→ #workspace-symbol` `→ #broken-link` `→ #asset-orphan`
>
> 把工作区里的 .md 文件相互关联起来的地基。Velo 从"批量编辑 .md"上升到"知识库"的第一步。[RESEARCH](./research/knowledge-graph.md)
>
> `workspaceStore` 维护 `Map<filePath, { headings, outgoingLinks }>`，文件变动时增量更新（依赖 v0.5.0 的工作区根 watch）。索引层独立于 editor state，不只看当前文档。

- [ ] 工作区索引核心：扫描 `.md` 文件，提取 Markdown links + headings，生成 forwardLinks 索引
- [ ] 增量更新：文件保存 / fs.watch 触发时刷新对应文件，非全量重扫
- [ ] 路径解析规则：标准 link 按当前文件目录相对解析；`[[wikilink]]` 按 basename 匹配（含 `/` 时按 workspace-relative）
- [ ] test：工作区索引增量更新逻辑单元测试（不走 PM，纯函数测试）

### 知识库 — 反向链接面板 `#backlinks` `P1` `M`

> `← #workspace-index`
>
> 当前文档被工作区内哪些 .md 引用，侧栏分组展示 + 上下文片段。这是知识库日常使用中 80% 的价值来源，优先于图谱可视化。

- [ ] 反向链接面板 UI：Sidebar 新增 tab，展示当前文档的被引用列表
- [ ] 上下文片段：每条反链展示引用处前后 N 行文本
- [ ] 点击条目跳转到引用位置（打开目标文件 + 定位光标）



## P2 — 体验增强

### 编辑器增强

- [ ] **表格增强** `#table-enhance` `P2` `L` `?`
  - 行列增删的浮层操作（hover 行/列头出现 + / 删除按钮）
  - 单元格对齐（left / center / right 切换）
  - 整表格拖拽（移动表格在文档中的位置）

- [ ] **段落拖拽重排（hover gutter 拽手）** `#block-drag` `P2` `L` `?` —— [RESEARCH](./research/block-drag-reorder.md)
  - 调研结论：中偏高复杂度，建议先做 PoC（仅 paragraph 之间），验证几何同步 + drop preview 再扩到列表语义
  - 复用 fold / lineNumber / toc 的 Decoration.widget 范式，不造 NodeView
  - 注意与 fold chevron 共享 gutter 空间

- [ ] **Markdown Lint / 写作质量检查** `#md-lint` `P2` `M`
  - 基于 markdownlint 规则集，编辑器内以 Decoration 标记问题（波浪线 / 边距提示）
  - 可配置规则开关（放在设置面板中）
  - 可选：readability 评分、字数目标进度条
  - 复用现有 Decoration.inline + syntax registry 框架


### 窗口与工作流

- [ ] **系统托盘** `#system-tray` `P2` `S` `→ #daily-note`
  - 系统托盘图标 + 右键菜单（新建 / 打开最近文件 / 退出）
  - 最小化到托盘 / 关闭按钮行为可选

- [ ] **Daily Note / 快速捕获** `#daily-note` `P2` `M` `← #system-tray`
  - 快捷键 / 系统托盘一键打开今日笔记（`YYYY-MM-DD.md`），不存在则自动创建
  - 全局快捷键（系统级，Velo 在后台时）弹出小输入框，快速记一句话追加到今日笔记
  - 与系统托盘配合做，是知识库工作流的核心习惯入口

- [ ] **功能更新弹窗** `#changelog-popup` `P2` `S`
  - 版本升级后首启展示 CHANGELOG 摘要
  - 读取 `docs/RELEASE_NOTES.md` 当前版本段落，渲染为 markdown

### 知识库 — 双链扩展

- [ ] **`[[wikilink]]` 语法** `#wikilink` `P2` `XL` `← #workspace-index` `→ #go-to-def` `→ #find-refs`
  - schema + remark 插件 + syntax/inline 注册 + NodeView（hover 显示目标文件预览，点击跳转）
  - 尽量复用 linkClickPlugin 的源码编辑态语义，避免又做一套交互
  - 按新增语法 checklist 走全流程（schema / markdownIO / syntax / test）
  - test：`[[link]]` 语法 round-trip 测试（含 alias / heading / missing / 路径变体）

- [ ] **Go to Definition** `#go-to-def` `P2` `S` `← #wikilink`
  - 在 `[[wikilink]]` / markdown 链接上 Ctrl+Click / F12 跳目标文件

- [ ] **Find References** `#find-refs` `P2` `S` `← #backlinks`
  - Shift+F12 列出当前文件被工作区内哪些 .md 引用（反向链接的单点入口）

- [ ] **工作区符号搜索（`#` 模式）** `#workspace-symbol` `P2` `S` `← #workspace-index`
  - 命令面板 `#` 前缀：跨文件搜索所有标题，选中后打开目标文件并跳转
  - 与 `@`（当前文档标题）、`:`（行号）、`>`（命令）并列，共用前缀分发机制
  - 数据来源复用 `#workspace-index` 的 headings 索引，零额外数据层

- [ ] **损坏链接检测** `#broken-link` `P2` `M` `← #workspace-index`
  - 索引时标记指向不存在文件的 `[[link]]`，编辑器内 Decoration 标红 + tooltip 提示

- [ ] **链接资产面板** `#link-assets` `P2` `M`
  - 扫描当前文档所有 `link` 节点，列出本地路径 + 外链分组
  - 点击条目把光标定位到引用位置（PM `view.dispatch + scrollIntoView`）
  - 引用计数为 0 的本地资产标灰（孤儿候选）

### 版本管理与导航

- [ ] **Git 集成** `#git-integration` `P2` `L` `↔ #local-timeline` `→ #recent-locations` —— [RESEARCH](./research/git-integration.md)
  - MVP 走系统 git CLI（`plugin-shell` 调用），零额外依赖，功能最完整
  - 侧栏新增 Git tab：git status（文件变更列表）、git commit（暂存 + 提交消息）、git diff（当前文件 diff 查看）
  - Diff 展示优先复用 CodeMirror 6 diff 适配器（已有依赖）
  - 文件树叠加 git status 装饰（颜色标记 modified / staged / untracked）
  - 不包含（留后续迭代）：branch 管理 / remote push/pull / merge / stash / gutter 行级变更指示

- [ ] **本地版本时间线** `#local-timeline` `P2` `M` `↔ #git-integration`
  - 升级现有崩溃恢复草稿（每 30s 落盘）为完整本地版本历史
  - 每次保存（手动 / 自动）创建快照，保留最近 N 个
  - 侧栏或命令面板浏览历史版本，diff 对比，一键恢复
  - 与 Git 互补：Git 是用户主动的、有提交信息的；Timeline 是自动的、细粒度的
  - Diff UI 复用 `#git-integration` 的 CM6 diff 适配器

- [ ] **最近编辑位置时间线** `#recent-locations` `P2` `M` `← #git-integration`
  - JetBrains Ctrl+Shift+E 风格：跨文件记光标位置而非文件
  - 与 Git 集成一同实现（共享文件历史数据层）

### 个性化

- [ ] **跟随系统深浅色** `#dark-mode-follow` `P2` `S` `← #settings-panel`
  - 监听 `prefers-color-scheme` 媒体查询，自动切换暗色模式
  - 设置面板新增三态开关：跟随系统 / 始终浅色 / 始终暗色

- [ ] **字体配置 UI** `#font-ui` `P2` `S` `← #settings-panel`
  - `editorStore.fontFamily` 已有 store 字段，仅设置面板未暴露
  - 补一个字体族选择器（系统字体 + 常用编程字体下拉）

### 资产面板工程级未引用 `#asset-orphan` `P2` `M` `← #workspace-index`

> 把 v0.6.4 资产面板的孤儿判定从「本 markdown 没引用过」升级为「整个工作区没被任何 markdown 引用过」，避免用户误以为其他文档仍引用的图片是孤儿而误删。

- [x] [RESEARCH](./research/asset-panel-global-orphan.md)：对比 rust / JS 增量索引层方案，与知识图谱调研合并索引层讨论
- [ ] 模块级索引缓存：维护 `Map<assetAbsPath, Set<absPathMd>>`，每次 markdown 文件保存 / fs.watch 触发时增量刷新该文件的引用集合
- [ ] 资产面板 UI 分三维度展示：本 markdown 引用 / 其他 markdown 引用（带「N 个其他文件引用」标签）/ 真正未引用（孤儿候选）
- [ ] test：工程维度缓存命中与增量更新正确性测试（3 文件 2 资产的简单工作区 fixture）
- [ ] test：面板展示分组与徽标正确性测试（mount Sidebar + 注入缓存）



## P3 — 远期方向

- [ ] **AI 辅助写作（本地 LLM 优先）** `#ai-assist` `P3` `L` `?`
  - 集成 Ollama：通过 Tauri shell 调 `ollama run`，不依赖云端，隐私零泄露
  - 场景化命令挂在命令面板 `>` 模式下：「润色这段」「展开大纲」「总结全文」「改写更简洁」，选区作为输入
  - 可选：行内补全（类似 Copilot，走本地小模型，只对 markdown 文本补全）
  - 与 Velo 本地优先定位高度契合，Typora / Zettlr 均无此能力

- [ ] **主题市场** `#theme-market` `P3` `XL` `?` `← #settings-panel`
  - 自定义颜色方案 / 字号规范 / 段落间距整套打包
  - 导入 / 导出主题 JSON
  - 社区分享（远期）

- [ ] **多种自带主题预设** `#theme-presets` `P3` `M` `← #settings-panel`
  - 除当前两套外增加更多内置主题
  - 与主题市场共享主题数据格式

- [ ] **导出更多格式** `#export-more` `P3` `M` `?`
  - DOCX / EPUB
  - 建议走 pandoc 桥接（一行命令多格式），比自写 walker 高效

- [ ] **导出 PDF 分页预览** `#pdf-preview` `P3` `M` `?`
  - 导出 PDF 前提供分页预览，可调整页边距 / 字号 / 页眉页脚

- [ ] **书签** `#bookmark` `P3` `S`
  - 在文档内标记位置，侧栏 / 命令面板快速跳回
  - per-file 书签列表，不跨文件（跨文件走大纲 / 标题跳转）


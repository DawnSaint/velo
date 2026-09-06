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

> 关键路径：核心功能到远期方向的解锁顺序。横向 `→` 表示阻塞，纵向表示优先级递减。

```
P1  #workspace-index ──→ #backlinks · #wikilink · #workspace-symbol · #broken-link · #asset-orphan
                                                                │
P1  #diff-cm6 ──→ #diff-edit · #diff-hunk-revert · #diff-autoscroll · #diff-virtual · #diff-split
    #diff-algo · #diff-merge（独立）
                                                                │
P2  #system-tray ──→ #daily-note
    #wikilink ──→ #go-to-def · #find-refs
    #block-drag · #table-enhance · #md-lint · #changelog-popup
                                                                │
P3  #code-signing · #e2e-ship-gate（独立，CI 核心已通）
    #ai-assist · #export-more · #pdf-preview · #bookmark（独立）
    #theme-market · #theme-presets（独立）
```

## 已知问题

> 已发布功能中待修复的缺陷 / 限制 / 平台缺口。



## v0.7.14 — Diff 功能升级 `#diff-upgrade` `P1` `L`

> 把版本历史 diff 从纯行级只读列表升级为基于 CodeMirror 6 的可编辑 diff 视图，对齐 VSCode Local History 的 diff 交互体验。
>
> 当前痛点：DiffView 是纯 `<div>` 渲染的只读行级列表，不可编辑、不可单块回退、无 hunk 级粒度操作；diff 算法为朴素 LCS（O(m×n) DP 表），大文档内存占用高且无字符级细化；选中条目后视口不自动跳转到第一个有差异的位置，用户需手动滚动查找。

- [ ] **CM6 重写 diff 视图** `#diff-cm6` `P1` `M`
  - 用 CodeMirror 6 作为 diff 渲染后端，替换当前纯 `<div>` 列表
  - 复用项目已有 CM6 基建（shiki 高亮 / 暗色模式 / 滚动），与 `SourceModeEditor` 共享扩展机制
  - diff 行以 CM6 Decoration（行背景色 + gutter 标记）呈现，保持 `+` / `-` 语义着色
  - 保留异步加载 Git content 的 loading 态与竞态守卫逻辑

- [ ] **支持在 diff 中直接编辑** `#diff-edit` `P1` `M` `← #diff-cm6`
  - 在 diff 视图中允许用户直接编辑「新版本」侧文本
  - 编辑后实时重算 diff（增量更新，不全量重算）
  - 编辑结果可写回编辑器内容（emit 到 `documentStore`），形成"边看 diff 边修改"的工作流
  - 只读条目（Git commit）禁用编辑，仅展示

- [ ] **单块（hunk）回退** `#diff-hunk-revert` `P1` `M` `← #diff-cm6`
  - 每个 diff hunk（连续的 added/removed 块）提供独立的「回退此块」操作
  - 回退单块 = 把该 hunk 对应的新版本内容替换为旧版本内容，其余 hunk 不受影响
  - 回退后实时重算 diff，已回退的 hunk 变为 unchanged
  - 单块回退与整体恢复/回退共存：工具栏保留全局操作，hunk 级提供精细控制

- [ ] **diff 算法升级** `#diff-algo` `P1` `M`
  - 从朴素 LCS（O(m×n) DP 表）升级为 Myers diff 算法（线性空间 + 更优 hunk 边界）
  - 支持 hunk 级语义：连续的 added/removed 行合并为一个 hunk 单元，便于单块回退
  - 增加字符级（inline）diff 可选层：同一行内只标红/标绿变更的字符，而非整行着色
  - 大文档（> 5000 行）diff 性能基线：计算 < 100ms，渲染虚拟滚动

- [ ] **短时间 diff 条目合并展示** `#diff-merge` `P2` `S`
  - 版本历史侧栏中，短时间内（如 2 分钟内）连续产生的快照条目合并为一个折叠组
  - 合并组展示累计 +/- 行数；展开后显示子条目
  - 与现有自动保存 5 分钟快照合并窗口区分：此处是 UI 层展示合并，不改变磁盘快照存储
  - 手动保存 / 失焦保存的快照不参与合并，始终独立展示

- [ ] **diff 视角自动跳转第一个 diff** `#diff-autoscroll` `P2` `S` `← #diff-cm6`
  - 选中版本条目进入 diff 视图时，自动滚动到第一个有差异的 hunk 位置
  - 后续可增加「上一个/下一个 diff」导航按钮（`Alt+↑` / `Alt+↓`），在 hunk 间跳转
  - 无差异时停在文档顶部

- [ ] **diff 虚拟滚动** `#diff-virtual` `P2` `S` `← #diff-cm6`
  - 大文档 diff 时启用虚拟滚动，只渲染视口内的行
  - CM6 自身支持虚拟滚动，此项随 #diff-cm6 自然落地，列出以确认验收

- [ ] **diff 双栏模式（可选）** `#diff-split` `P3` `M` `← #diff-cm6`
  - 提供「并排双栏」diff 视图（左旧右新），与当前「单栏混合」模式可切换
  - 双栏模式下两侧同步滚动，行对齐
  - 远期可选项，优先实现单栏体验完整后再评估

- [ ] test：Myers diff 算法正确性单元测试（含移动 / 空行 / 纯新增 / 纯删除 / 大段重排）
- [ ] test：单块回退后 diff 重算正确性测试（多 hunk 场景，回退中间块不影响两侧）
- [ ] test：短时间条目合并展示逻辑测试（边界：恰好 2 分钟 / 手动保存不合并 / 跨文件不合并）



## P1 — 核心功能

### 知识库 — 工作区索引 `#workspace-index` `P1` `L`

> `→ #backlinks` `→ #wikilink` `→ #workspace-symbol` `→ #broken-link` `→ #asset-orphan`
>
> 把工作区里的 .md 文件相互关联起来的地基。Velo 从"批量编辑 .md"上升到"知识库"的第一步。[RESEARCH](./research/knowledge-graph.md)
>
> `workspaceStore` 维护 `Map<filePath, { headings, outgoingLinks }>`，文件变动时增量更新。索引层独立于 editor state，不只看当前文档。

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


### 通知与反馈

### 资产面板工程级未引用 `#asset-orphan` `P2` `M` `← #workspace-index`

> 把 v0.6.4 资产面板的孤儿判定从「本 markdown 没引用过」升级为「整个工作区没被任何 markdown 引用过」，避免用户误以为其他文档仍引用的图片是孤儿而误删。

- [x] [RESEARCH](./research/asset-panel-global-orphan.md)：对比 rust / JS 增量索引层方案，与知识图谱调研合并索引层讨论
- [ ] 模块级索引缓存：维护 `Map<assetAbsPath, Set<absPathMd>>`，每次 markdown 文件保存 / fs.watch 触发时增量刷新该文件的引用集合
- [ ] 资产面板 UI 分三维度展示：本 markdown 引用 / 其他 markdown 引用（带「N 个其他文件引用」标签）/ 真正未引用（孤儿候选）
- [ ] test：工程维度缓存命中与增量更新正确性测试（3 文件 2 资产的简单工作区 fixture）
- [ ] test：面板展示分组与徽标正确性测试（mount Sidebar + 注入缓存）



## P3 — 远期方向

- [x] **CI E2E 验收门** `#e2e-ship-gate` `P3` `L`
  - 消费 build.yml 构建的 Windows 产物，起 WebDriver 跑 `e2e/specs/multi-window.spec.ts`
  - [x] Phase 1: `continue-on-error`（report 不阻塞 release attach）
  - [ ] Phase 2: 稳定后移除 `continue-on-error`，硬门
  - 前置：`cargo install tauri-driver` + 匹配的 `msedgedriver.exe`；appData 隔离走 `e2e/helpers/appdata.ts` 的 snapshot/restore

- [ ] **AI 辅助写作** `#ai-assist` `P3` `?`

- [ ] **主题市场** `#theme-market` `P3` `XL` `?`
  - 自定义颜色方案 / 字号规范 / 段落间距整套打包
  - 导入 / 导出主题 JSON
  - 社区分享（远期）

- [ ] **多种自带主题预设** `#theme-presets` `P3` `M`
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

- [ ] **ESLint warning 逐步清理** `#eslint-ci` `P3` `M` `← #eslint-setup`
  - 0.7.10 收敛后 0 error / 180 warning；CI 仅卡 error（`--quiet`），warnings 不阻断
  - `no-console` 已关闭（由 `lint:console` 专用脚本管 `console.log` / `debug`，`warn` / `error` 合理保留）
  - 剩余构成：~100 `no-non-null-assertion` / ~30 `no-explicit-any` / 少量 `no-useless-escape` / `no-control-regex`
  - 策略：coding agent 在接触文件时顺手修复该文件中的 warnings（CLAUDE.md 约定），逐步收敛至 0


- [ ] **表格增强二期** `#table-enhance-2` `P3` `M` `← #table-enhance`

  - [ ] **插入时选 MxN 尺寸**:当前 `Mod-t` 只能插 2 × 2 表,扩展为插入前让用户选行数 × 列数,支持右键菜单与快捷键触发;编辑后光标落到新表首 cell。

  - [ ] **表头行开关(header toggle)**:当前 schema 强制带首行 header,无法创建无头表、也无法把已有表头行去掉。效果 = 右键菜单"切换表头行":表头行与正文行整行互换(内容保留),表体增删 / 对齐 / 移动逻辑不受影响。
- [ ] **AI Coherence Layer 共享版本数据层** `#coherence-layer` `P3` `L` `← #local-timeline`
  - 在本地版本时间线基础上抽象出统一的版本数据层，供未来 AI 集成消费
  - 提供结构化的版本 diff API（不只是行级，需理解 markdown 语义）
  - 版本数据可被 AI 用于上下文重建、变更意图推断、多文件一致性检查
  - 依赖 #local-timeline 的快照存储管线已就绪，此条目聚焦数据层抽象与 AI 消费接口

- [ ] **Stryker 变异测试** `#stryker` `P2` `L`
  - Velo 测试只跑 v8 覆盖率，容易高估有效性；变异测试能抓"测试过了但其实没断言"的假绿
  - 先对核心模块（`markdownIO` / `documentStore` / schema）开
  - 发版前跑，不进每次 commit 路径
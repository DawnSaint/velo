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
P2  #system-tray ──→ #daily-note
    #git-integration ──↔── #local-timeline ──→ #recent-locations
    #wikilink ──→ #go-to-def · #find-refs
    #block-drag · #table-enhance · #md-lint · #changelog-popup
    #font-ui（独立）
                                                                │
P3  #code-signing · #e2e-ship-gate（独立，CI 核心已通）
    #ai-assist · #export-more · #pdf-preview · #bookmark（独立）
    #theme-market · #theme-presets（独立）
```





## 已知问题

> 已发布功能中待修复的缺陷 / 限制 / 平台缺口。

- [ ] **表格操作 + Ctrl+Z 后文档仍为脏(dirty),即便内容视觉上回到原始状态** `P2` `M`  **复现**:打开 `sample.md`(含表格以外的其他语法块,如 math / footnote / image / html inline 等),在表格内做加行/加列等任一变异操作后再 `Ctrl+Z` 撤销 —— 表格视觉回到原样,但标签页仍显示"已修改未保存"。**暂未定位根因**(纯 ProseMirror 历史 undo 本身已探针验证能一字不差回到操作前内容 `undo_probe.txt`,因此脏位不归零的路径在 store 同步 / markdownIO round-trip / checkExternalChange 链路,而非 PM 历史)。**触发条件猜测**:markdownIO 对某些节点(非表格)round-trip 不稳定(`toMarkdown(fromMarkdown(s))` 的"稳态 canonical"≠用户 undo 后再序列化的结果),字节不等 → `dirty = content !== lastSavedContent` 永不归零。**所需样例**:一份能复现的最小 `sample.md`(业务数据可隐去,但须保留"触发该缺陷的非表格语法 + 一个表格"的组合)。拿到后跑 `toMarkdown(fromMarkdown(s))` vs undo 后再序列化的首个字节分叉点一次性回填修复



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

### 编辑器增强

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

- [ ] **字体配置 UI** `#font-ui` `P2` `S`
  - `editorStore.fontFamily` 已有 store 字段，仅设置面板未暴露
  - 补一个字体族选择器（系统字体 + 常用编程字体下拉）

### 通知与反馈

### 资产面板工程级未引用 `#asset-orphan` `P2` `M` `← #workspace-index`

> 把 v0.6.4 资产面板的孤儿判定从「本 markdown 没引用过」升级为「整个工作区没被任何 markdown 引用过」，避免用户误以为其他文档仍引用的图片是孤儿而误删。

- [x] [RESEARCH](./research/asset-panel-global-orphan.md)：对比 rust / JS 增量索引层方案，与知识图谱调研合并索引层讨论
- [ ] 模块级索引缓存：维护 `Map<assetAbsPath, Set<absPathMd>>`，每次 markdown 文件保存 / fs.watch 触发时增量刷新该文件的引用集合
- [ ] 资产面板 UI 分三维度展示：本 markdown 引用 / 其他 markdown 引用（带「N 个其他文件引用」标签）/ 真正未引用（孤儿候选）
- [ ] test：工程维度缓存命中与增量更新正确性测试（3 文件 2 资产的简单工作区 fixture）
- [ ] test：面板展示分组与徽标正确性测试（mount Sidebar + 注入缓存）



## P3 — 远期方向

- [ ] **CI E2E 验收门** `#e2e-ship-gate` `P3` `L`
  - 消费 build.yml 构建的 Windows 产物，起 WebDriver 跑 `e2e/specs/multi-window.spec.ts`
  - Phase 1: `continue-on-error`（report 不阻塞 release attach）；Phase 2: 稳定后移除，硬门
  - 前置：`cargo install tauri-driver` + 匹配的 `msedgedriver.exe`；appData 隔离走 `e2e/helpers/appdata.ts` 的 snapshot/restore

- [ ] **AI 辅助写作（本地 LLM 优先）** `#ai-assist` `P3` `L` `?`
  - 集成 Ollama：通过 Tauri shell 调 `ollama run`，不依赖云端，隐私零泄露
  - 场景化命令挂在命令面板 `>` 模式下：「润色这段」「展开大纲」「总结全文」「改写更简洁」，选区作为输入
  - 可选：行内补全（类似 Copilot，走本地小模型，只对 markdown 文本补全）

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

- [ ] **表格增强二期** `#table-enhance-2` `P3` `M` `← #table-enhance`
  > 暂不引入 HTML `<table>` 兜底方案(单元格合并 / Excel 粘贴等天然依赖它的功能单独规划)。

  - [ ] **插入时选 MxN 尺寸**:当前 `Mod-t` 只能插 2 × 2 表,扩展为插入前让用户选行数 × 列数,支持右键菜单与快捷键触发;编辑后光标落到新表首 cell。
  - [ ] **列宽持久化**:当前列宽拖拽(`columnResizing`)只改变运行期显示,保存后再打开会回落默认。效果 = 拖拽结果进 schema + markdownIO 双向携带,刷新 / 重开后保持用户设过的列宽;未显式设宽的列保持默认。
  - [ ] **表头行开关(header toggle)**:当前 schema 强制带首行 header,无法创建无头表、也无法把已有表头行去掉。效果 = 右键菜单"切换表头行":表头行与正文行整行互换(内容保留),表体增删 / 对齐 / 移动逻辑不受影响。


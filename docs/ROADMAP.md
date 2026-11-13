# Velo Roadmap

> **维护规范**:
>
> - 每条 `- [ ]` 完成后改 `- [x]`，不要删除条目
> - 实现过程中发现原计划无法落地或方案改了 → 用删除线 + `→` 注明实际走法
>
> **调研文档**（`docs/research/`）:
>
> - **如何引用**: 在对应功能条目末尾加 `—— [RESEARCH](./research/xxx.md)` 链接，ROADMAP 是调研文档的唯一入口
> - **文件命名**: `docs/research/<feature-name>.md`，一个功能一篇，不设总索引文件
> - **写什么**: 候选方案对比、第三方依赖评估、与现有架构的结合点、风险点、推荐路线；不写实现步骤（实现后进 architecture docs）





## 依赖链速览

> 关键路径：核心功能到远期方向的解锁顺序。横向 `→` 表示阻塞，纵向表示优先级递减。

```
P2  #workspace-index ──→ #backlinks · #wikilink · #workspace-symbol · #broken-link · #asset-orphan
    #system-tray ──→ #daily-note
    #wikilink ──→ #go-to-def · #find-refs
    #block-drag · #table-enhance · #md-lint · #changelog-popup
    #diff-autoscroll · #diff-change-preview · #diff-ruler（独立）

P3  #code-signing（独立，CI 核心已通）
    #ai-assist · #export-more · #pdf-preview · #bookmark（独立）
    #theme-market · #theme-presets（独立）
```

## 已知问题

暂无



## P2 — 体验增强

### 知识库 — 工作区索引 `#workspace-index` `P1` `L`

> `→ #backlinks` `→ #wikilink` `→ #workspace-symbol` `→ #broken-link` `→ #asset-orphan`
>
> 把工作区里的 .md 文件相互关联起来的地基。Velo 从"批量编辑 .md"上升到"知识库"的第一步。[RESEARCH](./research/knowledge-graph.md) —— 索引层选型与实测数据见 [ADR-20261113-001](./DECISIONS.md)（pulldown-cmark + rayon，5k 文件全量扫描 24.5s → 0.18s；markdown-rs 大文件性能悬崖不选）
>
> `workspaceStore` 维护 `Map<filePath, { headings, outgoingLinks }>`，文件变动时增量更新。索引层独立于 editor state，不只看当前文档。
>
> **实现要点（原调研沉淀，防重踩）**：① pulldown 把 `[[note-123]]` 拆成逐字符 Text 事件，需跨事件缓冲拼接匹配，缓冲无 `[[` 时必须保留尾部单个 `[`（可能是下一个 `[[` 的前半），直接 clear 永远配不上；② pulldown 无 frontmatter 支持，文件头 `---` 会被当 setext heading 下划线（每文件 headings 多 1），extractor 先剥离 YAML 头；③ fenced code block 内伪链接由 Code 事件天然跳过（JS 正则方案需状态机排除）；④ walker 复用 `workspace.rs` 的 `scan_workspace`，不重复建设；⑤ 实现期第一优先验证 IPC 序列化成本（5k 索引明细几 MB 可能反超解析：先回传摘要 / 增量 diff / 明细按需查询），第二建三方语法对齐测试集。

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

### 版本历史 diff — 体验增强

> 双模式 diff、Block Tree Diff、语义化渲染已交付，以下是遗留与新增的体验补强。

- [ ] **diff 视角自动跳转第一个 diff + hunk 导航 ~~+ 折叠未变更区~~** `#diff-autoscroll` `P2` `S` → 折叠子项不实现，见下
  - 选中版本条目进入 diff 视图时，自动滚动到第一处变更（源码 / 预览双模式）
  - 「上一处 / 下一处」导航按钮 + `n/N` 计数（`Alt+↑` / `Alt+↓`）：源码模式用 `extractHunks(displayRows)` 定位行 DOM，预览模式用变更锚点（doc pos）经子组件跳转

- [ ] **修改预览** `#diff-change-preview` `P2` `M` `?`
  - 痛点：预览 diff 的格式 / 节点类型变更只用琥珀色下划虚线提示「这里有变更」，看不出具体改了什么（加粗 → 斜体、段落 → 标题 2、链接地址变化等），用户必须切到源码模式看 markdown 原文才明白
  - 目标：不离开富文本渲染态就能读懂改动内容；候选方向为悬停 / 点击琥珀标记展示「旧值 → 新值」浮层，或就地展开被替换的旧片段
  - 需覆盖语义化渲染已分类的变更（marks 变化 / 节点类型变化 / split·merge 边界），并与删除片段的删除线语义区分
  - 方案未定，开发前先在 `docs/research/` 写调研文档并由本条目链接进入

- [ ] **变更定位 ruler** `#diff-ruler` `P2` `M` `?`
  - 参考 VSCode 的 Git diff overview ruler：在 diff 视图右侧滚动条区域叠加一条 ruler，按每处变更在全文中的相对位置画绿色（新增）/ 红色（删除）块，长文档滚动时也能一眼看出改动分布
  - 点击 / 拖动色块跳转到对应变更，与 `#diff-autoscroll` 的 hunk 导航共用同一套变更锚点，避免维护两份定位数据
  - 源码模式按行号映射、预览模式按 block 位置映射；无变更时不显示 ruler
  - 方案未定，开发前先在 `docs/research/` 写调研文档并由本条目链接进入



### 知识库 — 双链扩展

- [ ] `[[wikilink]]`**语法** `#wikilink` `P2` `XL` `← #workspace-index` `→ #go-to-def` `→ #find-refs`
  - schema + remark 插件 + syntax/inline 注册 + NodeView（hover 显示目标文件预览，点击跳转）
  - 尽量复用 linkClickPlugin 的源码编辑态语义，避免又做一套交互
  - 按新增语法 checklist 走全流程（schema / markdownIO / syntax / test）
  - test：`[[link]]` 语法 round-trip 测试（含 alias / heading / missing / 路径变体）

- [ ] **Go to Definition** `#go-to-def` `P2` `S` `← #wikilink`
  - 在 `[[wikilink]]` / markdown 链接上 Ctrl+Click / F12 跳目标文件

- [ ] **Find References** `#find-refs` `P2` `S` `← #backlinks`
  - Shift+F12 列出当前文件被工作区内哪些 .md 引用（反向链接的单点入口）

- [ ] **工作区符号搜索（`#`模式）** `#workspace-symbol` `P2` `S` `← #workspace-index`
  - 命令面板 `#` 前缀：跨文件搜索所有标题，选中后打开目标文件并跳转
  - 与 `@`（当前文档标题）、`:`（行号）、`>`（命令）并列，共用前缀分发机制
  - 数据来源复用 `#workspace-index` 的 headings 索引，零额外数据层

- [ ] **损坏链接检测** `#broken-link` `P2` `M` `← #workspace-index`
  - 索引时标记指向不存在文件的 `[[link]]`，编辑器内 Decoration 标红 + tooltip 提示

- [ ] **链接资产面板** `#link-assets` `P2` `M`
  - 扫描当前文档所有 `link` 节点，列出本地路径 + 外链分组
  - 点击条目把光标定位到引用位置（PM `view.dispatch + scrollIntoView`）
  - 引用计数为 0 的本地资产标灰（孤儿候选）



### 资产面板工程级未引用 `#asset-orphan` `P2` `M` `← #workspace-index`

> 把 v0.6.4 资产面板的孤儿判定从「本 markdown 没引用过」升级为「整个工作区没被任何 markdown 引用过」，避免用户误以为其他文档仍引用的图片是孤儿而误删。

- [x] [RESEARCH](./research/asset-panel-global-orphan.md)：对比 rust / JS 增量索引层方案，与知识图谱调研合并索引层讨论
- [ ] 模块级索引缓存：维护 `Map<assetAbsPath, Set<absPathMd>>`，每次 markdown 文件保存 / fs.watch 触发时增量刷新该文件的引用集合
- [ ] 资产面板 UI 分三维度展示：本 markdown 引用 / 其他 markdown 引用（带「N 个其他文件引用」标签）/ 真正未引用（孤儿候选）
- [ ] test：工程维度缓存命中与增量更新正确性测试（3 文件 2 资产的简单工作区 fixture）
- [ ] test：面板展示分组与徽标正确性测试（mount Sidebar + 注入缓存）

## P3 — 远期方向

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
  - 剩余构成：\~100 `no-non-null-assertion` / \~30 `no-explicit-any` / 少量 `no-useless-escape` / `no-control-regex`
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
  - 先对核心模块（`markdownIO` / `documentStore` / schema）

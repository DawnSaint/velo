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
P1  #diff-wysiwyg ──→ #diff-block-tree ──→ #diff-semantic-render · #diff-incremental
    #diff-algo · #diff-autoscroll（独立）
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

> 把版本历史 diff 从纯行级只读列表升级为双模式（源码 diff + WYSIWYG diff）可切换的富文本 diff 视图，对齐飞书文档版本对比体验。
>
> 当前痛点：DiffView 是纯 `<div>` 渲染的只读行级列表，只有一种形态；diff 算法为朴素 LCS（O(m×n) DP 表），大文档内存占用高且无字符级细化；选中条目后视口不自动跳转到第一个有差异的位置，用户需手动滚动查找；自动保存模式下无「未保存」条目，用户缺少快速查看「我改了什么」的入口。
>
> **双模式设计**：源码 diff 保留现有行级对比（升级算法 + 字符级高亮）；WYSIWYG diff 在 ProseMirror 只读渲染上叠加 Decoration 标记增删（新增 = 绿色整框 / 下划线，删除 = 删除线 + 灰字，格式 / 类型 = 琥珀点线），用户看到的是富文本渲染态的变更对比而非原始 markdown 源码。两种模式在 diff 视图工具栏一键切换，**共用同一套 Myers 算法实现，但不共用同一份 diff 结果**（源码模式按 markdown 行对齐，预览模式按 ProseMirror 顶层 block 对齐，两者粒度不同构；切换回预览会重建只读 EditorView 并重新解析 + 比对）。

- [x] **diff 算法升级** `#diff-algo` `P1` `M`
  - [x] 从朴素 LCS（O(m×n) DP 表）升级为 Myers diff 算法（时间复杂度 O((m+n)·D)，D 为编辑距离）；`myersDiff` 同时供行级 diff 与 Block Tree Diff 复用
  - [x] 快照按 D 分配（每步只存 2D+3 个槽位）+ 公共前后缀预裁剪：空间从 O(D·(m+n)) 降到 O(D²)，5000 行 / 10% 改动实测 **79MB → 4.4MB**，耗时 103ms → 34ms（冷启动，含 10% 均匀改动）
  - [x] 支持 hunk 级语义：连续的 added/removed 行合并为一个 hunk 单元（`extractHunks`；当前仅测试覆盖，UI 消费方随 `#diff-autoscroll` 一起启用）
  - [x] 增加字符级（inline）diff 层：同一行内只标红/标绿变更的字符，而非整行着色
  - [x] 大文档（> 5000 行）diff 性能基线：计算 < 100ms —— 实测 5000 行 / 10% 改动 ~34ms，5000 行 / 中段改 50 行 ~2.4ms

- [x] **WYSIWYG diff 模式** `#diff-wysiwyg` `P1` `L`
  - 在 ProseMirror 只读渲染上叠加 Decoration 标记增删：`Decoration.inline` 给新增文本挂绿色下划线，给删除文本挂删除线 + 灰字；连续新增块由 overlay 画一个整框
  - ~~用纯背景色区分增删，不叠删除线（避免与 markdown 删除线语法 strike mark 冲突）~~ → 方案改为线条语义：底色会切碎排版流、被代码块 / 表头自身背景盖掉，左竖条与引用块 / 警告框自带彩条撞脸；删除线只作用于删除片段，不与正文 strike mark 混淆（见 `docs/architecture/styles.md`）
  - 旧版本 markdown 经 `fromMarkdown` 解析为 PM Node，与新版本 PM Node 做结构级对齐
  - 删除内容用 `Decoration.widget` 在对应位置插入带删除线的灰度文本片段（不占文档 pos，只视觉呈现）
  - 复用项目已有 PM Decoration 基建范式（`findHighlight.ts` / `cjkLetterSpacing.ts` / `CodeHighlightWidget.ts`）
  - ~~配合 `viewportPlugin` 做视口感知 decoration 构建，大文档只构建可见区域 diff 标记~~ → 未落地（实际为全量构建），并入 `#diff-incremental`
  - 标题 / 表格 / 图片 / 代码块 / 公式等富文本元素正常渲染，只在其变更的文本片段上叠加高亮
  - diff 视图只读（`editable: false`），不支持在 diff 中直接编辑（远期考虑）前回溯需保留每步 V 快照，空间是 O(D²) 而非 O(m+n)；要兑现需改成「分治 + middle snake 回溯」（只留两份 V 数组），实现复杂度与边界风险都高
  - ~~两种 diff 模式共用同一算法结果，切换模式不重算 diff~~ → 不采纳：源码模式对齐 markdown 行、预览模式对齐 PM bloc

- [x] **源码 diff 模式升级** `#diff-source` `P1` `S`
  - 保留并升级现有行级 diff 视图：Myers 算法 + 字符级 inline 高亮
  - 等宽字体行列表，`+`/`-` 前缀，行背景色区分增删
  - 与 WYSIWYG diff 共用同一 Myers 算法实现（对齐粒度不同：本模式按 markdown 行，预览模式按 PM block）
  - 保留异步加载 Git content 的 loading 态与竞态守卫逻辑

- [x] **双模式切换 UI** `#diff-switch` `P1` `S` `← #diff-wysiwyg` `← #diff-source`
  - diff 视图工具栏新增「源码 / 预览」模式切换按钮（同 Word 修订模式切换语义）
  - 切换即时生效，不重新加载 content；但**切回预览会重建只读 EditorView 并重算 block diff**（2000 段文档约 300ms，其中 ~93% 是两次 `fromMarkdown` 解析，diff 只占 ~21ms）。如需消除，可把 `DiffView.vue` 的 `v-else-if` 换成 `v-show` 保留实例，并在重新显示时补一次 `refreshViewport`

- ~~**短时间 diff 条目合并展示** `#diff-merge` `P2` `S`~~ → 不实现，由缺陷修复替代
  - 2 分钟 ⊂ 磁盘层 5 分钟滑动合并窗口：连续 auto 保存早已被合并成 1 条累积 diff 条目，UI 层没有子条目可折叠；manual / blur 打断（需求明确排除）、auto 间隔 ≥ 5 分钟（超出 2 分钟窗口）、Git commit（非快照）均不构成场景；默认 `autoSaveEnabled` / `autoSaveOnBlur` 均为关闭，折叠组恒为空
  - 「短时间冒出一堆条目」的真实成因是缺陷：合并判断误依赖 `versionHistoryStore.snapshotsByFile` 内存缓存，而该缓存只在用户打开版本历史面板时填充，面板未打开 / 重启 / 换文件期间合并静默失效、磁盘堆积碎片快照。已把合并逻辑下沉到 `persistence.ts`，由 `saveVersionSnapshot` 基于磁盘快照在一次读盘内完成判断 / 删旧 / 写新 / 修剪
  - 另：UI 层再引入一套 2 分钟分组会与磁盘层合并语义重叠，「累计 +/-」与现有逐条 diff 基准不可加（有删改时逐条统计相加 ≠ 组内首尾一次性 diff）

- [ ] **diff 视角自动跳转第一个 diff + hunk 导航 ~~+ 折叠未变更区~~** `#diff-autoscroll` `P2` `S` `← #diff-block-tree` → 折叠子项不实现，见下
  - 选中版本条目进入 diff 视图时，自动滚动到第一处变更（源码 / 预览双模式）
  - 「上一处 / 下一处」导航按钮 + `n/N` 计数（`Alt+↑` / `Alt+↓`）：源码模式用 `extractHunks(displayRows)` 定位行 DOM，预览模式用变更锚点（doc pos）经子组件跳转
  - ~~折叠未变更区域（默认折叠，对齐飞书「默认折叠无关内容」）：预览模式隐藏未变更 block 连续段中段（两侧各留 1 个上下文 block）+ 可点击展开的「⋯ N 段未修改」折叠条；源码模式把远离变更的连续 unchanged 行折叠为「⋯ N 行未修改」可展开行；无变更时不折叠~~ → 不实现，预览 diff 保持全文渲染
  - ~~**回退说明（当前状态：未完成）**：三项曾落地后主动回退，重做时按上述设计重新落地~~ → 代码已全部移除且不再重做：`DiffView.vue` 全量渲染、`DiffPlan` 无 `folds` / `hunks`、`WysiwygDiffView` 不 expose `scrollToChange` / 不 emit `change-count`、`_editor-diff.scss` 无折叠相关 class

- [x] **WYSIWYG diff 结构化升级（Block Tree Diff）** `#diff-block-tree` `P1` `L` `← #diff-wysiwyg`
  - 原状：`buildDecorations` 把新旧 PM doc 拍平成纯文本做行级 diff，导致——格式变更（加粗/链接）不可见、节点类型变更（段落→标题）不可见、非文本节点（图片/分割线/公式）删除不可见、段落拆分误报为删行+加行、表格结构变更乱码
  - ~~顶层 Block 级 diff：在 block 序列上跑 Myers，比对 key = 节点类型 + attrs + 文本 + inline marks 签名~~ → 已落地（`plugins/blockDiff.ts`：`collectBlocks` / `diffBlocks`）
  - 语义化变更分类：文本修改 / 纯增删 / 同文异 key（格式·类型变更）/ split·merge 全部区分（渲染细节见 `#diff-semantic-render`）
  - ~~非文本节点纳入比对：image / hr / math 等 leaf 节点用 attrs 做 key，删除时渲染类型占位 widget 而非裸文本~~ → 已落地（删除块改为 `DOMSerializer` 序列化旧 block 的带样式只读片段）
  - 不采纳：OT/CRDT 操作日志 diff、按作者着色——本地快照模型无操作日志与 per-block 作者数据，只能事后反推，投入产出比极低

- [x] **diff 语义化渲染** `#diff-semantic-render` `P1` `M` `← #diff-block-tree`
  - 格式变更可视化：仅 marks 变化的区间加 Decoration.inline（区别于增删的第三种样式 + tooltip「格式变更」）——`diffInlineMarkRanges` 逐字符比对 marks 签名，区间精确到变化文本（`velo-diff-format-changed` 琥珀点线下划线）
  - 删除内容保留结构：整 block 删除时 widget 渲染带样式的只读片段（标题保留字号、列表项保留缩进），而非裸文本 span——`DOMSerializer` 序列化旧 block（`velo-diff-deleted-block` 删除线 + 灰字 + 非文本块灰描边），`blockSummary` 文本占位随之移除
  - 段落拆分 / 合并的边界提示：block 边界处加「段落在此拆分」widget，替代删行+加行误报——`diffBlocks` 新增 split / merge op（去空白后文本相同判定），渲染 `velo-diff-boundary-hint` badge（「段落在此拆分」/「N 个段落已合并」）
  - 节点类型变更标记：琥珀点线描边 + tooltip（如「段落 → 标题 2」）——`nodeTypeLabel` 含关键 attrs（标题级别 / 代码块语言），`velo-diff-type-changed` + decoration title tooltip

- [x] **diff 视图增量渲染** `#diff-incremental` `P2` `M` `← #diff-block-tree`
  - 选中条目变化时不销毁重建 EditorView：`newContent` 变 → `setInitialViewportHint` + `EditorState.create`（复用同一批插件实例）+ `view.updateState`；`oldContent` 变 → 只 `setMeta(diffDecorationKey, { oldDoc })`
  - 大文档视口感知 decoration 构建（原 `#diff-wysiwyg` 的 viewportPlugin 设想并入此项）：`diffDecorationPlugin` 持 `DiffPlan`（`entries` / `groups`）+ `built`（已建 entry），`decorations()` 只对「视口内 + 粘性已建」entry 建装饰，滚动时由 viewport meta 只追加新进视口 entry（同 `CodeHighlightWidget` seenSet 粘性范式）
  - 注：折叠态不属此项——未变更区折叠归 `#diff-autoscroll`（不实现）

- [x] test：Block Tree Diff 结构比对单元测试（格式变更可见 / 节点类型变更 / 图片等非文本节点删除 / 段落拆分合并 / 空块配对退化）
- [x] test：语义化渲染单元测试（marks 变化区间精确标记 / 类型变更 tooltip / 删除片段保留结构 / split·merge 边界提示 / 拆分+改文本退化为 pair+insert）
- [x] test：增量渲染单元测试（窄 viewport 只建可见 entry / 滚动后粘性追加）——原「折叠默认生效 + toggleFold 展开 / hunk 锚点与折叠区计数」随 `#diff-autoscroll` 回退一并移除

- [x] **状态栏「未保存」点击进入 diff** `#diff-unsaved-entry` `P2` `S`
  - 底部状态栏「未保存」标记从纯展示 `<span>` 改为可点击 `<button>`（琥珀色 chip，hover 有反馈，带 aria-label「查看未保存修改的 diff」）
  - 点击 → 进入未保存条目 diff（`openUnsavedDiff()`），无未保存条目时静默不开（文档已保存 / 自动保存模式）
  - 自动保存模式下「未保存」标记不显示（已有 `v-if` 守卫），此入口主要服务手动保存用户
  - 实现比原计划更轻：不加载 Git 历史（未保存条目的 old 方只取最新本地快照，无快照则磁盘基线）、不切换侧栏 tab。因为 diff 视图本就独立于侧栏（命令面板「版本历史」同样只开 diff 视图）
  - 注意：必须先 `loadCurrentFileSnapshots()` 再设 `selectedEntryId`，否则 `diffOldContentAsync(UNSAVED_ID)` 会退化到 `lastSavedContent`，基准从「上一版本」变成「最后一次写盘」

- [x] test：Myers diff 算法正确性单元测试（含移动 / 空行 / 纯新增 / 纯删除 / 大段重排）
- [x] test：WYSIWYG diff Decoration 构建正确性测试（PM Node 树对齐 + 增删标记位置）
- ~~test：双模式切换不重算 diff（切换前后 DecorationSet 引用不变）~~ → 不适用：双模式本就不共用同一份 diff 结果（见 `#diff-algo`），该断言的前提不成立



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
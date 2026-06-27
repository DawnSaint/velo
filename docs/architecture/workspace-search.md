# Workspace Search

> **本文件负责**: 大纲搜索、Ctrl+P 快速打开、Ctrl+Shift+P 命令面板与 Ctrl+Shift+F 工作区全文搜索。
>
> **何时阅读**: 改 `EditorOutline.vue`、`QuickOpenPanel.vue`、`CommandPalettePanel.vue`、`WorkspaceSearchPanel.vue`、`quickOpenIndex.ts`、`commandPalette.ts`、`workspaceSearch.ts`、fuzzy scoring 或最近文件语义时。
>
> **先记住**:
> - 大纲搜索是视图层过滤，不污染 tree / 折叠态 / store。
> - Ctrl+P 索引是 per-root 内存缓存，fs.watch 只标记 stale，不做局部 patch。
> - 最近文件分两层:Ctrl+P 用 per-workspace recent;顶栏用全局 recent。
> - Ctrl+Shift+P 命令面板是 App shell 的轻量聚合入口,不是 VSCode 式全局命令系统。
> - Ctrl+Shift+F MVP 实时遍历 raw markdown，不建持久索引。
> - WYSIWYG raw offset 只能在 ordinal 可对齐时定位，否则只打开文件。
>
> **相关文件**: [架构索引](../ARCHITECTURE.md) / [文件树](./file-tree.md) / [查找替换](./find-replace.md)


## 设计要点

- **大纲搜索过滤是视图层独立路径,不污染 tree / 折叠态 / store**: 顶部搜索框按 heading 文本做大小写不敏感的子序列 fuzzy 匹配(`src/utils/outlineFilter.ts:fuzzyMatch` + `fuzzyMatchIndices` + `filterHeadings`,不引第三方库)。filter 阶段完全不动 `outlineStore` / `collapsedKeys`,也不维护祖先链 —— "仅展示命中条目",祖先不命中就不入列;`flatList` walker 在 filter 激活时对非命中祖先跳过 push 但**仍递归走完子树**,防止深层命中被漏掉。filter 模式下隐藏 chevron(`hasChildren = false`):命中条目为扁平列表,没有"展开/折叠"的语义需求,清空 query 后用户原折叠意图原样回归。关键字字符在 displayText 内联渲染主题色高亮段(`buildSegments` 把 `matchIndices` 切成 `{ text, match }[]`,模板逐段渲染,匹配段用 `<span>` 加 `color: var(--md-primary-color)` + `font-semibold`,**不**加背景色避免文字抖动);搜索框 focus 边色同样走 `--md-primary-color`,与大纲高亮色源统一。scroll-spy 沿用 `flatList.visible` 集合自动适配 filter 模式,filter 命中区间外的滚动位置自然失高亮,无需特例分支

- **Ctrl+P 查找文件:工作区 .md 索引 + fzf 评分 + 最近优先双分区**(v0.5.2): 全局快捷键挂 `App.vue:onKeydown`(同 Ctrl+F / Ctrl+S 同一处),无工作区静默 return。索引走单例 `Map<root, { entries, stale, pending }>`(`src/utils/quickOpenIndex.ts`),首次 `ensureIndex(root)` 递归 readDir BFS 收集 .md(隐藏目录 `.git` 等过滤),pending promise 挂在 slot 上防并发重复 walk。**失效策略走"标记 stale 而非局部 patch"**:工作区根 fs.watch 的 `scheduleDirtyFlush` 任何脏事件都 `invalidate(root)`,下次面板打开重扫;切工作区 `clearAll()` 清整张表。与 FileTree "脏目录集 + 子树重拉"同款哲学,简单可靠。**fuzzy 评分**(`src/utils/fuzzy.ts:fuzzyScore`)在 `outlineFilter` 的子序列匹配之上加分:连续段长度平方累加 + 词首字符(分隔符 / `_` / `-` / `.` / 空格后)bonus + 起始位置惩罚。两套 fuzzy 工具(`fuzzy.ts` 评分 / `outlineFilter.ts` boolean+indices)**故意分文件**,职责单一便于各自演化(大纲后续可能加正则,Ctrl+P 后续可能调评分权重)。**最近优先双分区**:面板始终把结果拆成"最近打开"(`workspaceStore.activeWorkspace.recentFiles`,头部=最新,cap 10)+ "其他"(扣掉 recent 的剩余)两段;**最近段保留 recent 顺序不被 fuzzy score 重排**(语义:最近优先 > 相关性),query 激活时只对该段做"过滤不重排";其他段空 query 走 alpha、有 query 按 score 降序。**recentFiles 持久化粒度 per-workspace**(与 expandedDirs/lastFile 同栈在 velo-workspaces.json),`setLastFile(path)` 内部自动 push;`renamePathPrefix` 跟随重写避免移动 / 重命名后 recent 指向死路径;v0.5.3 计划中的"跨工作区最近文件"是另一套全局粒度,与本字段不冲突。**结果排版**:文件名(保留 .md 后缀)+ 灰色相对路径副标(VSCode/Obsidian 风格),命中字符段**只用 `font-bold` 加粗不写独立颜色**,继承父容器 color —— 与大纲搜索约定一致(主题色高亮容易在暗色态产生"深蓝感",改纯加粗后字色随暗/亮色态自适应);选中行背景走 `color-mix(--md-primary-color 12%)`,**不**叠暗色 gray-800 底,避免主色 + 蓝灰底叠出深蓝。**暗色面板底色**用 `#1a1a1a` 与 App 主底对齐,**不**用 Tailwind `gray-900`(后者偏 slate-blue,与 App 整体中性灰冲突)。**面板生命周期**:`v-if` 控制实例存活,关闭即销毁;打开走 `documentStore.confirmDiscardIfDirty()` → `openPath()` → `workspaceStore.setLastFile()`,与 FileTree 单击同条契约(同时把 path 写入 recentFiles)

- **Ctrl+Shift+F 全文搜索:JS 端实时扫 .md + raw 命中定位**(v0.5.2): 全局快捷键同样挂 `App.vue:onKeydown`,无工作区静默 return;左贴边 ActivityBar 的“全局搜索”入口复用同一条 `openWorkspaceSearch()` 路径,不另起侧栏搜索状态。面板是独立 `Teleport` 浮层,关闭即取消当前 run。MVP 不建持久索引:每次 query debounce 后走 `src/utils/workspaceSearch.ts` 递归 `readDir` BFS(隐藏目录整段跳过)→ `readTextFile` → 复用查找替换的 `buildPattern` 跑 RegExp,按行匹配,结果只展示命中行(不渲染上下文行),同一行多命中拆多条 row;目录 / 文件读取失败按 quickOpen 同款静默跳过。进度按 scanning/searching/canceled/done 汇报,取消只能在每次 Tauri fs await 之后生效(不能中断已发出的 plugin-fs 调用),旧 run 结果用 token 丢弃。结果坐标是 raw markdown offset,点击打开仍走 `confirmDiscardIfDirty()` → `openPath()` → `workspaceStore.setLastFile()`;源码模式下 raw offset 与 CM6 坐标一致,优先重算 ordinal 命中后 select;WYSIWYG 下 raw offset 不能可靠映射 PM doc pos,只在 PM 可见文本命中数量与 raw 文件命中数量一致时按 ordinal select,否则仅打开文件、不自动切到源码模式,避免模式意外跳转。

- **Ctrl+Shift+P 命令面板:App shell 命令聚合,不引入完整命令系统**(v0.5.7): 命令面板沿用 QuickOpen 的顶部浮层、键盘导航与 `fuzzyScore` 评分,但搜索对象是 App shell 的可执行操作而不是文件索引。命令列表在 `App.vue` 组装,因为打开 / 保存 / 导出 / 查找替换 / 源码模式 / 左侧面板这些动作的状态与副作用都由 App shell 持有;`CommandPalettePanel.vue` 只负责输入、分组展示、disabled 呈现和执行选中项,`src/utils/commandPalette.ts` 只做 query 归一化、跨字段 fuzzy 匹配与 title 高亮切段。这里**故意不做 VSCode 式 command registry / context key / 参数化命令系统**,避免把轻量入口变成第二套 shell 状态机。最近文件条目读取全局 `recentFilesStore.entries`,执行仍复用 App 的 `openRecentFile(path)` 路径;Ctrl+P 的 per-workspace recent 继续只服务当前工作区快速打开。工作区相关命令无 active root 时保留可见但 disabled,用于告诉用户“功能存在,需要先打开工作区”,而 Ctrl+P 原快捷键仍保持无工作区静默。


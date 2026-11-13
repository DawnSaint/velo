# Workspace Search

> **本文件负责**：Ctrl+P / Ctrl+Shift+P 统一命令面板（file / command / @ symbol / : line 四模式）与 Ctrl+Shift+F 工作区全文搜索（含替换）。
>
> **何时阅读**：改 `QuickCommandPanel.vue`、`WorkspaceSearchPanel.vue`、`quickCommand.ts` / `quickOpenIndex.ts` / `commandPalette.ts` / `workspaceSearch.ts` / `fuzzy.ts` / `outline.ts` / `revealHeading.ts` / `useStaleEntry.ts`，或调 fuzzy 评分、最近文件语义、raw offset 定位时。
>
> **代码入口**：`src/components/{QuickCommandPanel,WorkspaceSearchPanel}.vue`、`src/utils/{quickCommand,quickOpenIndex,commandPalette,workspaceSearch,fuzzy,outline,revealHeading}.ts`、`src/composables/{useCrossModeSync,useStaleEntry,useWorkspaceSearch,useWorkspaceWatch}.ts`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [文件树](./file-tree.md) · [查找替换](./find-replace.md) · [Tauri](./tauri.md)

## 红线

- **模式前缀保留在输入框 raw value 里**，`parseQuickCommand` 只剥前缀 + 一个可选空格；不要另做模式徽标或独立模式 state。
- **file 模式索引是 per-root 内存缓存，fs.watch 只标记 stale，不做局部 patch**。
- **raw offset 定位只在 ordinal 可对齐时用**，否则只打开文件 —— 不要强映射。
- **WYSIWYG symbol 跳转走 DOM 查询，不做 raw 行号 → PM pos 映射**（计数规则在特殊节点上不一致）。
- **dirty tab 一律跳过替换**（替换读磁盘基线，覆盖会毁掉未保存编辑）。
- **不在有命中时插「新建文件」行**（会抢默认选中）。
- **失效历史记录只在 `exists` 明确 false 时判失效**，抛错按有效处理，绝不误删。
- **替换 / scope 变化用 `rerunToken` 自增触发重跑**，不要 watch `initialQuery`。
- **面板根必须挂 `data-quick-command-panel` / `data-workspace-search-panel`**，`App.vue` 的 `closest()` 靠它判焦点在面板内、避免重复触发全局快捷键。

## 架构

### 统一命令面板（Ctrl+P / Ctrl+Shift+P）

顶部居中 Teleport 浮层（无遮罩，`fixed inset-0` 透明层作点击外部关闭命中区，整体 `mt-[4vh]`）。一个输入框，首字符决定模式，前缀字符保留在 raw value：

| 前缀 | 模式 | 搜索对象 | 定位 |
| --- | --- | --- | --- |
| `''` | file | 工作区 `.md`（per-root 索引） | `openPathInTab` |
| `>` | command | App shell 命令聚合 | 执行命令 |
| `@` | symbol | 当前文档标题树（`parseHeadings`） | source 走 raw offset / WYSIWYG 走 DOM |
| `:` | line | 行号（源码概念） | 切源码 + CM6 行高亮 |

- **两套行视图统一**为 `UnifiedRow` / `UnifiedSection`，共用 `flatRows` / `selection` / 跨段线性键盘导航。
- **Ctrl+P / Ctrl+Shift+P 同模式 → 关，不同模式 → 切**：切模式靠 `App.vue` 的 `mountKey` 强制 remount 让新 `initialQuery` 生效（`open` watcher 只在 false→true 触发）。
- **file 模式**：索引是单例 `Map<root, { entries, stale, pending }>`（`quickOpenIndex.ts`）。模块内 `walkRoot` 优先 Rust `scan_workspace_files`（1 次 IPC），旧版后端 / web 端回落按层并发 BFS（并发上限 8）；`ensureIndex` 首次 walk，pending promise 挂 slot 防并发重复 walk。`useWorkspaceWatch` 的 `scheduleDirtyFlush` 任何脏事件都 `invalidate(root)`，切工作区 `clearAll()`。
- **fuzzy 评分**（`fuzzy.ts:fuzzyScore`）：子序列匹配 + 连续段长度平方累加 + 词首字符 bonus（分隔符 / `_` / `-` / `.` / 空格后）+ 起始位置惩罚。
- **最近优先双分区**：结果拆「最近打开」（per-workspace `activeWorkspace.recentFiles`，cap 10，保留 recent 顺序不被 score 重排）+「其他」（空 query 走 alpha、有 query 按 score 降序）。
- **create-if-not-found**：query 非空 + 无命中 + 有 activeRoot + 名称合法时，顶部插「新建文件: `<name>.md`」；复用 `writeTextFile(path, '')` + `finalName` / `validateName`，建盘前 `exists` 守门防 truncate 覆写。**不复用 `file.new` 命令**（那是未命名临时 tab，语义是「新草稿」）。
- **顶部前缀介绍行**：file 模式 + 空 query + 工作区有 `.md` 时插三行（Terminal / AtSign / ListOrdered 图标 + 模式名 + 用途），`isHelp` 标记；`resetSelectionToFirst` 跳过 `isHelp`，默认 Enter 仍打开首文件。选中即 `switchToPrefix`。异步索引加载完若选中停在 `isHelp` 行，flatRows watcher 一并重置。
- **command 模式**：命令列表在 `App.vue` 组装（打开 / 保存 / 导出 / 查找替换 / 源码模式 / 左侧面板的状态与副作用都由 App shell 持有），`QuickCommandPanel.vue` 只管输入 / 分组 / disabled / 执行，`commandPalette.ts` 做跨字段 fuzzy 与 title 高亮切段。最近文件条目读全局 `recentFilesStore.entries`，执行复用 `openRecentFile(path)`。**故意不做 VSCode 式 command registry / context key / 参数化命令系统**。工作区相关命令无 active root 时保留可见但 disabled。
- **@ symbol 模式**：标题解析复用 `outline.ts:parseHeadings`（与 EditorOutline 同源），按 `heading.level` 缩进。Enter 不直接跳，emit `reveal-heading: { level, displayText }`，由 `useCrossModeSync` 按当前模式二选一。source 走 `findHeadingRawOffset`（逐行扫 + `stripFencedCodeBlocks` 防误匹配代码块 `#`，`stripFormatting` 后比对，offset 即 CM6 pos）；WYSIWYG 走 `revealHeadingInDom`（`querySelectorAll('h{level}')` + textContent + scrollIntoView + 1500ms `outline-highlight`）。`revealHeadingInDom` 抽在 `revealHeading.ts`，与大纲面板共用。
- **: line 模式**：输入 `:` → `line-enter` 记原模式 + 光标锚点（WYSIWYG 记 PM `captureAnchor`、源码记 CM6 pos）**但不切源码**，只收起面板 + 显示 hint。敲行号 → `line-preview: N`：WYSIWYG 置 `switched=true` + `pendingPreview` + `toggleSourceMode()`（行号是源码概念）；源码直接 `applyLinePreview(N)`。`applyLinePreview` = `findLineOffset` + `setSelection` + `scrollMatchIntoView` + dispatch `cmLineHighlightEffect.of(N)`（不 focus）。CM6 行高亮 = `cmLineHighlightField`（`StateField<number|null>`）+ `cmLineHighlightDeco`（`Decoration.line`，class `velo-cm-line-jump`）。Enter 确认（留源码 + 当前行，清高亮）；Esc / 离开 / 关闭取消（`onLineCancel` 用 `pendingLineRestore` 覆盖 anchor 恢复）。

### 工作区全文搜索（Ctrl+Shift+F）

侧栏第三个 tab（`workspaceStore.sidebarTab === 'search'`），与 FileTree / EditorOutline 在 `Sidebar.vue` 互斥 `v-if`，不再 Teleport 浮层。关闭走 Esc / ActivityBar 搜索图标 / `emit('update:open', false)` → `toggleSidebarTab`。MVP 不建持久索引，每次 query debounce 后走 `workspaceSearch.ts`。

- **搜索**：`searchWorkspaceMarkdown` 优先 Rust `search_workspace`（grep-searcher + rayon + Channel 流式），invoke reject（旧版后端 / 正则方言不支持）降级 JS 按层并发 `readDir` + `readTextFile` + `buildPattern`（复用查找替换的 RegExp 构造）。结果只展示命中行（不渲染上下文行 / 行号），同一行多命中拆多条 row。
- **取消**：Rust 侧 `cancel_workspace_search(searchId)` 置位 AtomicBool（每文件 / 每命中行检查）；JS 侧 controller 只能在 await 间隙生效，旧 run 结果用 token 丢弃。`onBeforeUnmount` 兜底 `cancelActive`。
- **命中段高亮**与 FindReplace Decoration 共用 `.velo-find-match`（`_editor-base.scss` 金色 `rgba(255,215,0,.35)`），不依赖 `--md-primary-color`（用户自定义主色过浅时 `color-mix` 几乎不可见）。hover 走菜单色系（`hover:bg-gray-100 dark:hover:bg-gray-700`）+ `.velo-ws-hovered` class；selected 走主色 `color-mix(--md-primary-color 12%)` inline style（specificity 最高，selected + hover 同条时显示主色）。hover / selected 拆两个独立 state。
- **点击结果不自动关闭面板**（侧栏不遮挡编辑器，允许连续点多个结果）。
- **替换**：`WorkspaceSearchPanel.vue` 只管 UI，`applyWorkspaceReplace(hits, plan, dirtyPaths)` 是编辑器无关纯函数 IO，`useWorkspaceSearch` 编排。面板 emit `apply-replace` 携 `{ hits, replacement, scope: 'one' | 'all' }` → snapshot `documentStore.documents` 的脏 tab fullPath 集合 → `applyWorkspaceReplace` → 遍历 changedFiles 同步到打开中的 clean tab（`loadContentInto`）→ 写 `replaceStatus` prop + `rerunToken++` 触发重跑。**「替换」= 当前选中条目所在文件的所有命中**（对齐 Ctrl+H 但放宽到按文件全部）；「全部替换」= 所有结果命中文件。regex 复用 `replaceInText`（保留 `$1` / `$2`）。
- **scope**：文件树右键「在此文件夹中搜索」带 `scopeDir`，把搜索范围从工作区根收窄到子目录；scope chip 显示当前 scope + ✕ 清除，不持久化。
- **文件分组折叠**：每个分组 header 可点击折叠（ChevronRight + rotate-90），折叠态是组件本地 `Set<fullPath>`，不持久化 —— 切 tab / 改 query / rerun 都不清空，只要文件仍在结果里就保持折叠。

### 定位链路（raw offset → 编辑器）

- **source mode**：CM6 `findMatches` 在原始 markdown 整串上跑，offset 与 raw 1:1。优先 `matches[hit.matchOrdinal]`；ordinal 越界（文件被改过）fallback `getRangeText(rawFrom, rawTo) === matchText` 校验文本未变后用 raw offset 跳。
- **WYSIWYG**：PM `findMatchesInDoc` 只走 text 节点，跳过 `code_block` / `image` / `mermaid` 等所有非 text 节点；raw scan 是 per-line 全串正则，**包含**这些节点源码 —— 两侧计数规则天然不一致。prose 节点（paragraph / heading / list）上 raw ordinal 与 PM pmMatches 对齐（PM text node 一次 exec，同段 N 个 match ordinal 0..N-1，与 raw per-line scan 一致）；raw 命中落在非 text 节点时 PM `pmMatches[ordinal]` undefined → 静默放弃（文件已打开，用户至少能浏览到目标行附近）。**不自动切 source mode**（避免劫持当前编辑模式）。
- **字符实体例外**：`char_ref` mark 让 PM 查找同时搜解码文本与实体字面量，`buildCharRefIndexMap` 映回 PM 坐标（只覆盖部分字面量的命中夹到整个实体），ordinal 因此能与 raw 逐行扫描对齐 → `setSelection` 生效 → `charRefSourceEditPlugin` 把该处临时替换成浅灰 `&#x20;`，光标移出该区间或失焦即还原。后端算 matches 前 `flushCharRefReveal` 还原上次跳转的源码态，保证坐标属于渲染态 doc。
- **早期版本**曾校验 `pmMatches.length === hit.fileMatchCount` 过滤「文件被改过」，因上述计数差异等价于「文件不能含任何特殊节点」，已去除。

### 失效历史记录统一清理

5 个入口共用 `useStaleEntry.ts`：

- `isMissingPath` 只在 `exists` **明确返回 false** 时判失效，抛错（权限 / 网络盘抖动）按有效处理。
- `confirmRemove` 走 `useConfirmStore` 自绘弹窗（取代原生 confirm）。
- ① 历史工作区、②「文件」下拉「最近文件」子菜单、③ command 模式「打开最近文件」都汇到 App shell 的 `openRecentFile(path)`，确认后 `recentFilesStore.removePaths([path])` 精确删。
- ④ file 模式「最近打开」是 per-workspace `recentFiles`：索引天然过滤死路径，但 store 会残留占 cap —— `refreshIndex()` 扫完盘后对「不在索引里」的项批量 `exists` 复核，静默 `workspaceStore.removeRecentFiles(missing)`；索引仍 stale 时用户点到那条会再判一次，弹框确认后移除并 `invalidate(root)`。
- ⑤ 启动 `startupMode='last-file'` 用 `probeExistingPath(paths, 5)` 找第一条仍存在的全局最近文件，顺路静默批量清掉探测途中确认失效的记录（冷启动不弹框，最多探 5 条避免开机 IO 风暴），全失效回退空白文档。
- **落盘竞态**：`saveRecentFilesPatch` 是「读盘 → merge patch → 写盘」，逐条 fire-and-forget 删除会互相覆盖，故 `RecentFilesPatch.deletes` 收数组、`removePaths` 一次合成单个 patch；与 `deletePrefixes`（前缀删）分开，不误伤同名前缀文件。工作区目录侧同款坑走 `WorkspacePatch.removedRoots`，见 [file-tree.md](./file-tree.md)。

## 关键取舍

- **统一面板是前缀分发而非模式切换器**：一个输入框、首字符决定模式，保留旧 Ctrl+P / Ctrl+Shift+P 的肌肉记忆；`>` 前缀在输入框里可见，模式靠首字符自然区分。
- **file 索引「标记 stale 而非局部 patch」**：与 FileTree「脏目录集 + 子树重拉」同款哲学，简单可靠；walk 成本可控（Rust 单 command）。
- **command 模式是 App shell 的轻量聚合入口**，不是 VSCode 式全局命令系统 —— 命令列表在 `App.vue` 组装，避免第二套 shell 状态机。
- **命中高亮用固定金色而非主色**：金色饱和度高、与主色解耦，浅 / 深主题下都保证可见；用户自定义主色过浅时 `color-mix` 会几乎不可见。
- **hover / selected 拆两个独立 state**：早期把 hover 合并进 `selectedFlatIndex`（`@mousemove="selectRow"`）导致 hover 立即触发主色底、菜单色 hover 永远看不到；删 mousemove 又让 hover 完全失去反馈。现在 hover 由 mouseenter/leave 改、只挂 class；selected 由键盘 + Click 共同改、走 inline style。
- **WYSIWYG 不做 raw → PM pos 映射**：PM text node 计数与 raw per-line scan 在含 `code_block` / `image` / `mermaid` 时不一致，强映射会「结果已过期」；WYSIWYG 直接 DOM 查询定位，语义是「跳到这个标题的视觉位置」。
- **替换语义 = 按文件替换全部**：用户点了某条命中，大概率想清理整个文件；若想逐条改，先单文件打开再 Ctrl+H。
- **`rerunToken` 计数器触发重跑**：比 `watch(() => initialQuery)` 更明确（「有重跑信号」），且 initialQuery 不变不会触发。

## 附录

- **模式前缀**：`''` file / `>` command（Ctrl+Shift+P）/ `@` symbol / `:` line；`#` workspace-symbol 暂缓。
- **面板根选择器**：`data-quick-command-panel` / `data-workspace-search-panel`。
- **Rust 下沉**：遍历 / 搜索 / 替换已下沉 `src-tauri/src/workspace.rs`，JS 旧路径保留为 fallback；详见 [tauri.md](./tauri.md)。

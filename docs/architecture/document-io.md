# Document IO Architecture

> **本文件负责**：文档打开 / 保存、外部改动同步、崩溃恢复草稿、版本历史、持久化文件，以及写盘 / echo / fs:watch 相关的设计取舍。
>
> **何时阅读**：改 `documentStore` 的打开 / 保存 / 外部变更同步、草稿、持久化语义，或调 `lastSavedContent` / `lastSelfEmitted` / fs:watch 行为时。
>
> **代码入口**：`src/stores/{document,versionHistory,persistence,workspace,recentFiles}.ts`、`document.ts` 的 `DocState`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [编辑器](./editor.md) · [文件树 / 工作区](./file-tree.md)

## 红线

- **`lastSavedContent`（磁盘基线）只在 `loadContent` / `save` / `saveAs` / `loadContentIntoTabs` 四个入口推进**，绝不在 `setContent` 里推进。
- **`save()` 写盘前先推进 `lastSavedContent`**，用于短路自己触发的 fs:watch。
- **echo 哨兵 `lastSelfEmitted` 不要绕过**，否则编辑时光标被重置。
- **不在 `setContent` 里 canonicalize**（会退化成 echo 误吞）。
- **大文档（> `CANON_SKIP_THRESHOLD` = 2000 行）与含字符实体文档走 raw 基线**，不要为省一次序列化改掉。
- **`checkExternalChange` 的 canonical fallback 要保留**（未保存时 disk 是 raw）。
- **自动保存模式下三处 dirty 指示器全部跳过**（TabBar / StatusBar / 标题栏）。
- **`content === lastSavedContent` 时不写盘、不写版本快照**。

## 架构

### 打开 / 保存

- **打开**：`confirmDiscardIfDirty` → `openDialog` → `readTextFile` → `loadContent`；`openPath` 成功返回 `true` 并推进全局最近文件，失败弹 message 后返回 `false`，不污染当前文档。
- **保存**：`save()` → `saveDoc` → `writeTextFile`，写盘前乐观推进 `lastSavedContent` 过滤自己的 fs:watch 事件；失败回滚。Ctrl+S / 失焦 / 关闭拦截走同一 `save()`。

### 多标签入口

| 入口 | 行为 | 触发点 |
| --- | --- | --- |
| `openPathInTab(path)` | 已开 → 切到该标签；未开 → 新开（或复用干净未命名标签） | 树点击 / 右键「在编辑器中打开」/ Ctrl+P / 工作区搜索命中 / 顶栏最近 / Welcome 选文件 / 拖入 / CLI args |
| `openPathInNewTab(path)` | **始终**新开标签，即便 path 已被打开 | 树中键点击（VSCode 资源管理器中键语义）；允许同一文件以独立标签并存（各自独立 undo / 滚动 / 光标） |
| `openSampleTab(content, label)` | 装载示例到新标签或复用干净未命名标签 | Welcome 选 sample |

三者共用同一条 read → `loadContent` → push recent 流水线，仅「是否复用已开标签」分支不同；错误处理（`readTextFile` 抛错 → 弹原生 message → 不创建空标签）对齐。

### 外部改动同步

`checkExternalChange`（fs:watch + window focus 兜底）按序判定：

1. `disk === lastSavedContent` → 自己的写（save 后 fast path），忽略
2. `canonical(disk) === lastSavedContent` → 磁盘原文与 canonical 基线语义等价（未保存时 disk 是 raw，基线是 canonical），忽略
3. `canonical(disk) === content` → 别人重写为同样内容，刷新基线
4. `!dirty` → 静默 reload
5. `dirty` → 弹确认

**canonicalize 有 disk memo**：`DocState.externalCanonicalCache` 以磁盘原文为 key 缓存结果，磁盘未变时整趟 `toMarkdown(fromMarkdown(disk))` 双往返直接跳过。key 是磁盘原文而非基线，所以 `save` / `saveAs` / 草稿恢复推进 `lastSavedContent` 时不需要同步这个缓存，换路径也不会串味。

### 崩溃恢复（Hot Exit，per-workspace）

- 脏盘每 30s 写草稿到 `appDataDir/drafts/{workspaceKey}/{id}.json`；`workspaceKey = encodePathAsId(workspaceRoot)`。A 工作区的草稿只在下次打开 A 时恢复（VSCode Hot Exit 语义）。
- 启动恢复在 `loadContentIntoTabs` 内静默完成：并行读磁盘 + 查草稿，有草稿则用草稿内容装载 + 设磁盘基线（`lastSavedContent = diskContent`）让 `dirty=true`，并删除已消费的草稿文件；无草稿走正常磁盘读取。无 Dialog，无中断。
- 无 `activeRoot` 时 `workspaceKey` 回退到 `_no_workspace`，草稿仍落盘 + 恢复 —— 覆盖「只打开文件没开工作区」的场景。
- webview 刷新 / 卸载前 `pagehide` 同步落盘草稿 + workspace 状态（防止 500ms debounce 未触发）。
- 草稿 ID：`file-{encodePathAsId(path)}` / `untitled-{docId}`，无 window scope（多窗口隔离由 per-workspace 目录天然保证）。

### 版本历史

- 每次保存（手动 / 自动 / 失焦）写一份快照到 `appDataDir/versions/{pathId}/{timestamp}.json`，`VERSION_SNAPSHOT_CAP = 50`、`VERSION_SNAPSHOT_MAX_AGE_DAYS = 30`，超出任一限制按 `savedAt` 修剪最旧的。
- **无变化时（`content === lastSavedContent`）不写盘、不写快照**，避免 Ctrl+S 在 clean 状态下产生空 diff 条目。
- `saveDoc` 写盘成功后调 `saveVersionSnapshot(filePath, content, trigger)`（`persistence.ts`），由它在**一次 `loadVersionSnapshots` 读盘**内完成 auto 合并判断 → 删旧 → 写新 → 按 CAP + 过期天数修剪；store 再用返回的实际写入快照 + 被合并旧快照 id 调 `versionHistoryStore.upsertSnapshot` / `removeSnapshot` 同步内存缓存（`snapshotsByFile`），使面板即时刷新；缓存未加载（面板未打开）时 `upsertSnapshot` 跳过，下次打开从磁盘读。
- **自动保存快照合并**：`trigger='auto'` 时，若磁盘上该文件最近一条快照也是 `auto` 且在 `AUTO_SNAPSHOT_MERGE_WINDOW_MS`（5 分钟）内，先删旧快照再写新快照，避免版本历史被 +1/-1 碎片条目淹没；`manual` / `blur` 始终新建独立快照。判断以**磁盘真实快照**为准而非 UI 内存缓存 —— 后者只在面板打开时填充，依赖它会让合并静默失效、磁盘堆积碎片快照。
- **回到合并起点时不写新快照**：若新内容与被合并旧快照的前一条快照内容相同，只删旧快照不写新快照（调 `removeSnapshot` 同步移除内存缓存）。
- 恢复快照走 `restoreVersionContent`（同 Hot Exit 恢复语义：新开标签 + 设磁盘基线让 dirty=true）。
- 浏览入口：ActivityBar「版本历史」（`SidebarTab='history'`）→ `VersionHistoryPanel` 列出快照（每条显示与前一版本的 +/- 行数统计）；点击 → 编辑器区切 `DiffView`（覆盖编辑器，行级 diff + 「恢复此版本」按钮）。命令面板「浏览版本历史」同样触发。
- **diff 语义同 VSCode Local History**：每个条目与其**前一版本**做 diff（列表倒序，最新在前，前一版本 = 该条目后面那个），而非与当前编辑器内容做 diff；未保存条目的前一版本 = 最新已保存快照（或磁盘基线），最旧的快照无前一版本（diff old = 空字符串）。
- 文档 dirty 时列表头部插入虚拟「未保存」条目（`UNSAVED_ID`，不落盘），`content` = 当前编辑器内容；`openVersionHistory` dirty 时默认选中它，否则选最新快照。**自动保存模式下不生成虚拟条目**（`save()` 同步推进基线导致 dirty 反复横跳，条目忽现忽隐）—— `unsavedEntry` computed 在 `autoSaveEnabled` 时返回 null。
- **Git 条目缓存 key 含文件路径**（`versionHistory.ts`）：`gitContentCache` / `gitDiffStats` 的 key 是 `git:<hash>:<filePath>`，不是 `git:<hash>`。同一 commit 中不同文件内容不同，同仓库 A/B 文件的 commit 历史可能交集，key 不含路径会导致跨文件缓存污染。`loadGitHistory` / `loadGitContent` 直接用传入的 `filePath` 参数，不依赖 `allEntries` / `currentFileGitRoot` computed（竞态场景下可能返回旧文件）。`invalidate(filePath)` 按 `:<filePath>` 后缀匹配清除该文件的缓存条目。

### 持久化

`appDataDir/{velo-settings.json, velo-outline-state.json, velo-workspaces.json, velo-recent-files.json, drafts/, versions/}`，失败降级不阻塞 UI。

- **`velo-workspaces.json`**：main 冷启动 active hint + 每个根的 `expandedDirs` / `lastFile` / `sidebarTab` / `recentFiles` / `openTabs` / `activeTab`。多窗口下 `active` 不代表全局唯一当前工作区，动态窗口只加载 known roots 与 per-root 状态，保存时按当前窗口 active workspace 做 patch merge，不全量覆盖其它窗口新写入的 roots。
- **`sidebarWidth`** 已从 per-workspace 迁到全局 `velo-settings.json`（走 `editorStore`）；`WorkspaceState.sidebarWidth` 字段已删除，旧 JSON 中的 per-workspace 值由启动期 `migrateWorkspacesIfNeeded` 迁移。
- **`WorkspacePatch.active` 三态语义**：`string` = 有 active workspace，正常覆盖磁盘；`null` = 用户显式关闭工作区（`activeExplicitlyCleared` 标记），覆盖磁盘为 null，下次冷启动不恢复；`undefined` = 动态窗口 / watcher 误触发（无 `activeRoot` 但非用户主动关闭），保留磁盘已有 `active` 不覆盖。`snapshotActiveForPersistence` = `active ?? (activeExplicitlyCleared ? null : undefined)`；`setActiveRoot(非 null)` 与 `loadFrom` 重置标记。
- **`velo-recent-files.json`**：跨工作区的全局最近打开文件，与 workspace 内 `recentFiles` 分离；只由显式 `openPath` 成功推进，不监听 `currentFilePath` 变化（避免重命名 / 草稿恢复 / 外部重载误刷新最近时间）。条目 `{ path, openedAt }` 做读盘 merge + 去重排序，降低多窗口错峰写入覆盖。
- **`velo-outline-state.json`**：大纲折叠状态按文件 path 存，**不**迁进 per-workspace —— 折叠跟工作区无关，跨工作区打开同一文件应仍记住折叠。
- **启动期一次性迁移**：`App.vue` `initSettings()` 在加载前调 `migrateSettingsIfNeeded()` + `migrateWorkspacesIfNeeded()`，把旧版本配置迁移到当前版本并写回磁盘；之后 `loadSettings` / `loadWorkspaces` / `loadDraft` 只认当前版本，不再内联兼容逻辑。迁移函数用逐级链（v1→v2→…→vN），每级只处理本版到下一版的变更；`migrateSettingsIfNeeded` 还处理同版本号内的废弃字段清理（`darkMode` → `themeMode`、删除 `fontFamily`、`'system'` 字体值 → 平台默认 key）。

## 关键取舍

- **`loadContent` 把磁盘内容过一遍 markdownIO canonical**：markdownIO round-trip（multi-empty-lines / html inline 等）在 `toMarkdown` 后不与磁盘原文字节相等 —— 用户打开一个 6 空行的文件，即使不编辑，`content` 与 `lastSavedContent` 也会因 round-trip drift 永远不一致，出现「输入再删回原状也一直 dirty」的 bug。修法：`toMarkdown(fromMarkdown(c, schema))`，canonical 形式**同时**塞进 `content` 与 `lastSavedContent`。后续编辑器 emit 的 canonical 与基线一致，edit + revert 归零；代价是打开时即时规范化（典型 markdown 编辑器行为）。
- **canonical 基线顺带建块缓存**：`loadContentInto` 的小文档路径本来就要 `toMarkdown(pmDoc)` 取 canonical 基线，`serializeDocIncremental` 用同一次逐块序列化同时产出基线串与块缓存，首次编辑即可命中增量路径；逐块 stringify 与全量同量级（小文档约 +20ms），换来首次编辑不必再全量重建。
- **`pendingPmDoc` 跳过冗余 fromMarkdown（C0）**：`loadContentInto` 解析出的 PM Node 存入 `DocState.pendingPmDoc`（`markRaw`），`EditorInner` 在 modelValue watch 与 `useProseMirror` fromMarkdown 回调中通过 `consumePendingPmDoc()` 一次性消费，跳过第二次 `fromMarkdown`。打开链路从 3 次 markdownIO（`fromMarkdown` × 2 + `toMarkdown` × 1）降到 2 次（小文档）或 1 次（大文档 + C0b）。
- **C0b：大文档跳过 canonical round-trip**：`> CANON_SKIP_THRESHOLD`（2000 行）时 `content` 与 `lastSavedContent` 直接用 raw 磁盘内容，省 `toMarkdown` 100–300ms；代价是 CRLF / 多余空行等非 canonical 文件 type+delete dirty 不归零。`checkExternalChange` 的 canonical fallback 不受影响。阈值不是可随手删的性能补丁（删掉等于给大文档重新加一次主线程序列化）。
- **含字符实体文档走 raw 基线**：`fromMarkdown` 会把 `&#x20;` / `&nbsp;` 解码成普通字符，canonical 结果若塞进 `content` / `lastSavedContent` 会静默改写磁盘内容且因两者相等不显示 dirty。`hasCharRefOutsideCode()` 只在代码块 / 行内代码之外检测，命中则 `content` 与 `lastSavedContent` 直接用 raw，源码逐字节保真、打开不 dirty。代价同 C0b（type+delete 不归零），且一旦编辑，debounce 回写的 `toMarkdown` 仍会把实体规范化掉 —— 保真只覆盖「打开且不编辑」。`char_ref` mark 落地后 `toMarkdown` 已能把对齐过的实体原样写回（见 [editor.md](./editor.md)），但 raw 基线**不因此退役**：`scanCharRefs` 与 mdast 解码串对不上时该处仍是普通文本、含 CRLF 的实体文档还需逐字节保真。
- **echo 哨兵（`lastSelfEmitted`）**：EditorInner / SourceModeEditor dispatch 时先把 markdown 写进 `lastSelfEmitted`，父级 watch 看到匹配则跳过 echo，避免编辑时光标被重置。
- **`setContent` 不推进基线（历史坑）**：曾用 `echosToAccept` 计数器让编辑器「规范化回吐」推进基线，但计数器无法区分「编辑器 echo」与「用户真实编辑」—— 用户恰好在 echo 到达前敲键时，编辑被误吞成 echo，把 `lastSavedContent` 推向新内容。后果：切窗口再 focus 时 `checkExternalChange` 看到 `disk(旧) !== lastSavedContent(新) !== content(新)` + `dirty=true`，弹出「文件在编辑器外被修改」误报。
- **debounce 待回写不能被 modelValue 变化吞掉**：`EditorInner` 的 150ms `toMarkdown` debounce 里 `pendingDoc` 才是 view 的最新内容，而大纲 / 状态栏 / 自动保存只读 `documentStore.content`。`cancelPendingEmit()` 若跑在 self-emit echo 判定之前，echo 回环撞上后一笔编辑就会把那笔编辑永久丢弃 —— 表象是编辑器里标题已删、大纲仍挂旧 title、点击跳转找不到 DOM 无反应；debounce 窗口内切标签（`activeId` 已变）还会让旧标签的编辑被 cancel 或 emit 到新标签。规则：echo 分支直接返回、不碰 pending emit；切标签在 `tabSwitchToken` watch 里先 flush 并用 `setContentForDoc(docId, ...)` 按 id 回写；`lastSelfEmitted` 同时记 docId 且切标签时清空，否则跨标签会把外部替换误判成 echo 而跳过 view 重建。回归测试 `__tests__/contentSync.test.ts`。
- **自动保存模式下 UI 隐藏 dirty 标记**：`save()` 写盘前同步推进 `lastSavedContent` → `dirty` 立刻变 `false`，下一次按键又变 `true`，在 TabBar（tab dot）、StatusBar（橙色「未保存」胶囊）、窗口标题栏（`•`）三处表现为橙色忽闪。`autoSaveEnabled` 为 true 时三处全部跳过：TabBar `displayTabs` 用 `t.dirty && !autoSaveEnabled`、StatusBar `v-if` 叠加 `!autoSaveEnabled`、`syncTitle` 的 `isDirty` 强制 `false`。`documentStore.dirty` computed 本身不变，仅 UI 层不展示 —— 自动保存的核心理念是「用户无需关心保存状态」。
- **fs.watch 生命周期 race**：`startWatchOf` / `stopWatch` fire-and-forget 理论可泄漏；`checkExternalChange` 早退故无实际影响。

## 附录

- **尾部空行 `toMarkdown` 出口补偿**（`markdownIO.ts`）：`processor.stringify` 按 CommonMark 强制文档以单 `\n` 收尾并吃掉尾部空段，导致尾部空行每 round 丢 2 `\n`。但 PM doc 里尾部空段是活的（`<br />` 占位转成的空 paragraph），只是被 stringify 吃掉。`toMarkdown` 出口按 doc 尾部连续空段数 K 补 `\n`（K≥1 时 strip 尾 `\n` 后补 `2K+1` 个），使 `toMarkdown(fromMarkdown(x))` 对尾部空行严格 idempotent —— 2+ 个尾部空行字节守恒。**不要**改 `preprocessBlankLines` 公式做这事（段间占位的 ceil 公式对段间已结构闭合，改它只增风险不解决尾部；stringify 才是元凶）。边界：恰好 1 个尾部空行（`X\n\n`，N=2）CommonMark 不可表示，fromMarkdown 不产空段，塌缩成 0 —— 与 VSCode/Typora 同行为。
- **`WorkspacePatch` / `RecentFilesPatch`**：见 `persistence.ts`；`RecentFilesPatch.deletes` 收数组，与 `deletePrefixes`（前缀删）分开，不误伤同名前缀文件。

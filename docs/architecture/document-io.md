# Document IO Architecture

> **本文件负责**: 文档的打开 / 保存、外部改动同步、崩溃恢复草稿、持久化文件，以及写盘 / echo / watch 相关的设计取舍与维护者注意点。
>
> **何时阅读**: 改 `documentStore` 的打开 / 保存 / 外部变更同步、草稿、持久化语义，或调整 `lastSavedContent` / `lastSelfEmitted` / fs:watch 行为时。
>
> **先记住**:
> - `documentStore.content` 是编辑器文本唯一来源,`dirty = content !== lastSavedContent`(数据流基础见 [架构入口](../ARCHITECTURE.md))。
> - `save()` 写盘**前**先推进 `lastSavedContent`,用于短路自己触发的 fs:watch。
> - `lastSavedContent`(磁盘基线)**只在** `loadContent` / `save` / `saveAs` / `loadContentIntoTabs`(Hot Exit 恢复)里推进,**不在** `setContent` 里推进(后者只回写编辑器内容,不污染基线)。
> - echo 哨兵 `lastSelfEmitted` 防止自 emit 的回写重置光标,**不要**绕过。
> - Hot Exit 草稿按 workspace 隔离,启动恢复在 `loadContentIntoTabs` 内静默完成,无 Dialog。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [编辑器](./editor.md) / [文件树 / 工作区](./file-tree.md)

---

## 文件操作

- 打开: `confirmDiscardIfDirty` → `openDialog` → `readTextFile` → `loadContent` ;`openPath` 成功返回 `true` 并推进全局最近文件,失败弹 message 后返回 `false`,不污染当前文档
- 保存: `writeTextFile`,**写盘前乐观推进** `lastSavedContent` 过滤自己的 fs:watch 事件;失败回滚
- Ctrl+S / 失焦 / 关闭拦截走同一 `save()`

## 多标签打开入口(v0.6.0)

| 入口 | 行为 | 触发点 |
|------|------|--------|
| `openPathInTab(path)` | 已开 → 切到该标签;未开 → 新开(或复用干净未命名标签) | 树点击 / 右键"在编辑器中打开" / Ctrl+P 选中 / 工作区搜索命中 / 顶栏最近 / Welcome 选文件 / 拖入编辑器 / CLI args |
| `openPathInNewTab(path)` | **始终**新开标签,即便 path 已被打开 | 树中键点击(VSCode 资源管理器中键语义);允许同一文件以独立标签并存(各自独立 undo / 滚动 / 光标) |
| `openSampleTab(content, label)` | 装载示例到新标签或复用干净未命名标签 | Welcome 选 sample |

两份入口共用同一条 read → loadContent → push recent 流水线,仅"是否复用已开标签"分支不同;错误处理(readTextFile 抛错 → 弹原生 message → 不创建空标签)对齐。

## 外部改动同步

`checkExternalChange`(fs:watch + window focus 兜底)按序判定:

1. `disk === lastSavedContent` → 自己的写(save 后 fast path),忽略
2. `canonical(disk) === lastSavedContent` → 磁盘原文与 canonical 基线语义等价(未保存时 disk 是 raw,lastSavedContent 是 canonical),忽略
3. `canonical(disk) === content` → 别人重写为同样内容,刷新基线
4. `!dirty` → 静默 reload
5. `dirty` → 弹确认

`loadContentInto` 把磁盘内容 canonicalize 后同时塞进 `content` 与 `lastSavedContent`,所以基线是 canonical 形式而非磁盘原文。save() 写的是 canonical,写完后 `disk === lastSavedContent` 走 fast path;但未保存时磁盘仍是 raw 原文,直接与 canonical 基线比会误判外部修改,因此 step 2 在 exact match 失败后把 disk 也 canonicalize 再比。**大文档(> 2000 行)跳过 canonical round-trip**(C0b):`content` 与 `lastSavedContent` 直接用 raw 磁盘内容,省 `toMarkdown` 100–300ms;代价是 CRLF / 多余空行等非 canonical 文件 type+delete dirty 不归零。`checkExternalChange` 的 canonical fallback 不受影响。

## 崩溃恢复(Hot Exit,per-workspace)

脏盘每 30s 写草稿到 `appDataDir/drafts/{workspaceKey}/{id}.json`;草稿按工作区隔离,A 工作区的草稿只在下次打开 A 时恢复,打开 B 时不恢复(VSCode Hot Exit 语义)。启动恢复在 `loadContentIntoTabs` 内静默完成:并行读磁盘 + 查草稿,有草稿则用草稿内容装载 + 设磁盘基线让 `dirty=true`,并删除已消费的草稿文件;无草稿则正常读磁盘。无 Dialog,无中断。无 workspace(无 `activeRoot`)时用 fallback key `_no_workspace` 作 workspaceKey,草稿仍落盘 + 恢复 —— 覆盖"只打开文件没开工作区"的场景(同 VSCode/Typora)。webview 刷新 / 卸载前 `pagehide` 同步落盘草稿 + workspace 状态(防止 500ms debounce 未触发)。草稿 ID:`file-{encodePathAsId(path)}`(文件)/ `untitled-{docId}`(未命名文档),无 window scope。

## 版本历史(#local-timeline)

每次保存(手动 / 自动 / 失焦)写一份快照到 `appDataDir/versions/{pathId}/{timestamp}.json`,保留最近 50 个且不超过 30 天,超出任一限制时按 `savedAt` 修剪最旧的。**无变化时(`content === lastSavedContent`)不写盘、不写快照**,避免 Ctrl+S 在 clean 状态下产生空 diff 历史条目。快照由系统自动管理,用户不可手动删除单条或清空全部(面板只提供查看 / diff / 恢复)。与草稿分工:草稿是 dirty 期间 30s 定时落盘用于 Hot Exit 崩溃恢复,写盘成功后清除;版本快照是保存点的只读归档,不参与基线 / echo / fs:watch。`saveDoc` 写盘成功后调 `saveVersionSnapshot` + `pruneVersionSnapshots`(persistence.ts)落盘,再调 `versionHistoryStore.upsertSnapshot` 同步更新内存缓存(`snapshotsByFile`,同样按 CAP + 过期天数修剪),使版本历史面板即时刷新;缓存未加载(面板未打开)时 `upsertSnapshot` 跳过,下次打开时 `loadSnapshots` 从磁盘读。**自动保存快照合并**:`trigger='auto'` 时,若该文件最近一条快照也是 `auto` 且在 5 分钟合并窗口内,先 `deleteVersionSnapshot` 删旧快照再写新快照(磁盘 + 内存缓存同步替换),避免版本历史被 +1/-1 碎片条目淹没;`manual` / `blur` 保存始终新建独立快照。**回到合并起点时不写新快照**:若新内容与被合并旧快照的前一条快照(合并前的基线)内容相同,说明用户在合并窗口内编辑后又回到起点,只删旧快照不写新快照(调 `removeSnapshot` 同步移除内存缓存),避免版本历史出现无变化的条目。恢复快照走 `restoreVersionContent`(同 Hot Exit 恢复语义:新开标签 + 设磁盘基线让 dirty=true)。浏览入口为 ActivityBar「版本历史」(`SidebarTab='history'`)→ 侧栏 `VersionHistoryPanel` 列出快照条目(每条显示与前一版本的 +/- 行数统计);点击条目 → 编辑器区切换为 `DiffView`(覆盖编辑器,行级 diff + 「恢复此版本」按钮)。命令面板「浏览版本历史」同样触发此流程。diff 语义同 VSCode Local History:每个条目与其**前一版本**做 diff(列表倒序,最新在前,前一版本 = 该条目后面那个),而非与当前编辑器内容做 diff;未保存条目的前一版本 = 最新已保存快照(或磁盘基线,无快照时),最旧的快照无前一版本(diff old = 空字符串)。文档 dirty 时列表头部插入虚拟「未保存」条目(`UNSAVED_ID`,不落盘),`content` = 当前编辑器内容;`openVersionHistory` dirty 时默认选中未保存条目,否则选最新快照。**自动保存模式下不生成虚拟「未保存」条目** —— `save()` 同步推进 `lastSavedContent` 导致 dirty 反复横跳,未保存条目忽现忽隐割裂感强;`unsavedEntry` computed 在 `autoSaveEnabled` 时返回 null,`openVersionHistory` 在 `autoSaveEnabled` 时跳过 `UNSAVED_ID` 选中逻辑。

## 持久化

`appDataDir/{velo-settings.json, velo-outline-state.json, velo-workspaces.json, velo-recent-files.json, drafts/, versions/}`,失败降级不阻塞 UI。`velo-workspaces.json` 走"main 冷启动 active hint + 每个根的 expandedDirs / lastFile / sidebarTab / recentFiles / openTabs / activeTab"格式;多窗口下 `active` 不代表全局唯一当前工作区,动态窗口只加载 known roots 与 per-root 状态,保存时按当前窗口 active workspace 做 patch merge,不全量覆盖其它窗口新写入的 roots。sidebarWidth(v0.7.13)已从 per-workspace 迁到全局 `velo-settings.json`(走 `editorStore`),`WorkspaceState.sidebarWidth` 字段已从接口删除,旧 JSON 中的 per-workspace 值由启动期 `migrateWorkspacesIfNeeded` 迁移到 `velo-settings.json`。`WorkspacePatch.active` 三态语义(`string` / `null` / `undefined`)区分"有 active workspace" / "用户显式关闭工作区" / "watcher 误触发不覆盖",详见维护者注意点。`velo-recent-files.json` 是跨工作区的全局最近打开文件,与 workspace 内 `recentFiles` 分离;只由显式 `openPath` 成功推进,不监听 `currentFilePath` 变化,避免重命名 / 草稿恢复 / 外部重载误刷新最近时间。全局最近文件用 `{ path, openedAt }` 条目做读盘 merge + 去重排序,降低多窗口错峰写入覆盖。大纲折叠状态(`velo-outline-state.json`)仍按文件 path 存,**不**迁进 per-workspace —— 大纲折叠跟工作区无关,跨工作区打开同一文件应仍记住折叠。**启动期一次性迁移**:App.vue `initSettings()` 在加载前调 `migrateSettingsIfNeeded()` + `migrateWorkspacesIfNeeded()`,把旧版本配置文件迁移到当前版本并写回磁盘;之后 `loadSettings` / `loadWorkspaces` / `loadDraft` 只认当前版本,不再内联兼容逻辑。迁移函数采用逐级迁移链(v1→v2→…→vN),每级只处理本版到下一版的变更;`migrateSettingsIfNeeded` 处理同版本号内的废弃字段清理(`darkMode` → `themeMode`、删除 `fontFamily`、`'system'` 字体值 → 平台默认 key)。

---

## 设计要点

- **自家写盘不打扰**: `save()` 写盘前推进 `lastSavedContent`,自己触发的 fs:watch 被 `disk === lastSavedContent` 短路。
- **`checkExternalChange` canonical 比对**: `lastSavedContent` 是 canonical 形式(`loadContentInto` 过了一遍 markdownIO),但磁盘原文可能与 canonical 不字节相等(多余空行 / whitespace normalize)。save() 写 canonical → 写完后 fast path 命中;未保存时 disk 是 raw → exact match 失败后把 disk 也 canonicalize 再比,避免非 canonical 文件编辑后切窗口 focus 误报"外部修改"。
- **echo 哨兵** (`lastSelfEmitted`): EditorInner / SourceModeEditor dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch 看到匹配则跳过 echo,避免编辑时光标被重置。
- **Hot Exit 草稿按 workspace 隔离**: 草稿写到 `appDataDir/drafts/{workspaceKey}/{id}.json`,`workspaceKey` = `encodePathAsId(workspaceRoot)`(与 `versions/` 中的 `pathId` 同款逻辑)。A 工作区的未保存内容只在下次打开 A 时静默恢复,打开 B 时不恢复(同 VSCode)。草稿 ID 简化为 `file-{encodePathAsId(path)}` / `untitled-{docId}`,无 window scope —— 多窗口隔离由 per-workspace 目录天然保证。`loadContentIntoTabs` 启动恢复时并发查草稿,有草稿则用草稿内容 + 设磁盘基线(`lastSavedContent = diskContent`)让 `dirty=true`,并删掉已消费的草稿;无草稿走正常磁盘读取。无 `activeRoot` 时 `activeWorkspaceRoot` 回退到 `_no_workspace` fallback key,草稿仍落盘 + 恢复 —— 覆盖"只打开文件没开工作区"的场景(同 VSCode/Typora)。
- **自动保存模式下 UI 隐藏 dirty 标记**: `save()` 写盘前同步推进 `lastSavedContent` → `dirty` 立刻变 `false`,而用户下一次按键又使 `dirty` 变 `true`,在 TabBar(tab dot)、StatusBar(橙色"未保存"胶囊)、窗口标题栏(`•`)三处表现为橙色忽闪忽闪。`autoSaveEnabled` 为 true 时,三处 dirty 指示器全部跳过:TabBar 的 `displayTabs` 用 `t.dirty && !autoSaveEnabled`、StatusBar 的 `v-if` 叠加 `!autoSaveEnabled`、`syncTitle` 的 `isDirty` 在 `autoSaveEnabled` 时强制 `false`。`documentStore.dirty` computed 本身不变,仅 UI 层不展示 —— 自动保存的核心理念是"用户无需关心保存状态"。

---

## 维护者注意点

- **fs.watch 生命周期 race**: `startWatchOf` / `stopWatch` fire-and-forget 理论可泄漏；`checkExternalChange` 早退故无实际影响。
- **`setContent` 不推进基线**: 编辑器每次按键都回写 `content`,但 `lastSavedContent` 绝不在 `setContent` 里推进。曾用过 `echosToAccept` 计数器让编辑器"规范化回吐"推进基线,但计数器无法区分"编辑器 echo"与"用户真实编辑"—— 用户恰好在 echo 到达前敲键时,编辑被误吞成 echo,把 `lastSavedContent` 推向新内容。后果:切窗口再 focus 时 `checkExternalChange` 看到 `disk(旧) !== lastSavedContent(新) !== content(新)` + `dirty=true`,弹出"文件在编辑器外被修改"误报。基线推进只走 `loadContent` / `save` / `saveAs` / `loadContentIntoTabs`(Hot Exit 恢复)四个入口。
- **`pendingPmDoc` 跳过冗余 fromMarkdown(C0)**: `loadContentInto` 解析出的 PM Node 存入 `DocState.pendingPmDoc`(`markRaw` 包裹),`EditorInner` 在 modelValue watch 与 `useProseMirror` fromMarkdown 回调中通过 `consumePendingPmDoc()` 一次性消费,跳过第二次 `fromMarkdown` 调用。打开链路从 3 次 markdownIO(`fromMarkdown` × 2 + `toMarkdown` × 1)降到 2 次(小文档)或 1 次(大文档 + C0b)。消费后置 `undefined`,不影响 fs:watch / 切标签恢复等路径。
- **`loadContent` 把磁盘内容过一遍 markdownIO canonical**: `markdownIO` round-trip(multi-empty-lines / html inline 等)在 `toMarkdown` 后不与磁盘原文字节相等 —— 用户打开一个 6 空行的文件,即使不编辑,`content` 与 `lastSavedContent` 也会因为 round-trip drift 永远不一致,出现"输入再删回原状也一直 dirty"的 bug。修法:`loadContent` 里把磁盘内容走 `toMarkdown(fromMarkdown(c, schema))`,canonical 形式**同时**塞进 `content` 与 `lastSavedContent`(`content` 也对齐 canonical 而非原文)。后续编辑器 emit 的 canonical 与基线一致,edit + revert 归零;代价是打开磁盘文件时即时规范化(典型 markdown 编辑器行为),多空行等 whitespace drift 在保存时被消除。**不要在 `setContent` 里做这件事**,否则又退化成 echo 误吞(见上条)。
- **尾部空行 `toMarkdown` 出口补偿**(`markdownIO.ts`): `processor.stringify` 按 CommonMark 规范强制文档以单 `\n` 收尾并吃掉尾部空段,导致尾部空行每 round 丢 2 `\n`。但 PM doc 里尾部空段是活的(`<br />` 占位转成的空 paragraph),只是被 stringify 吃掉。`toMarkdown` 出口按 doc 尾部连续空段数 K 补 `\n`(K≥1 时 strip 尾 `\n` 后补 `2K+1` 个),使 `toMarkdown(fromMarkdown(x))` 对尾部空行严格 idempotent —— 2+ 个尾部空行字节守恒。**不要**改 `preprocessBlankLines` 公式做这事:段间占位的 ceil 公式对段间已结构闭合,改它只增风险不解决尾部(stringify 才是吃尾部空段的元凶)。边界:恰好 1 个尾部空行(`X\n\n`,N=2)CommonMark 不可表示,fromMarkdown 不产空段,塌缩成 0 —— 与 VSCode/Typora 同行为,无法绕开除非放弃 remark-parse。
- **`WorkspacePatch.active` 三态语义**: `saveWorkspacePatch` 的 `active` 字段区分三种值,解决"动态窗口 watcher 误触发覆盖 active"与"用户主动关闭工作区需写入 null"的矛盾:
  - `string`: 有 active workspace,正常覆盖磁盘
  - `null`: 用户显式关闭工作区(`closeWorkspace` 设 `activeExplicitlyCleared = true`),覆盖磁盘为 null,下次冷启动不恢复该工作区
  - `undefined`: 动态窗口 / watcher 误触发(无 `activeRoot` 但非用户主动关闭),`saveWorkspacePatch` 保留磁盘已有 `active` 不覆盖

  `snapshotActiveForPersistence` 通过 `activeExplicitlyCleared` 标记区分后两种场景:`active ?? (activeExplicitlyCleared ? null : undefined)`。`setActiveRoot(非 null)` 重置标记,`loadFrom` 启动恢复也重置。`pagehide` 中同步保存 workspace 状态,防止 500ms debounce 未触发。
- **Git 条目缓存 key 含文件路径**(`versionHistory.ts`): `gitContentCache` / `gitDiffStats` 的 key 是 `git:<hash>:<filePath>`,不是 `git:<hash>`。同一 commit 中不同文件的内容不同,同仓库中 A/B 文件的 commit 历史可能交集(同一 commit 同时修改两个文件),若 key 不含文件路径会导致跨文件缓存污染——A 的 content 被复用给 B。`loadGitHistory` 中预加载 / diff 统计也不依赖 `allEntries` computed(它读 `documentStore.currentFilePath`,竞态场景下可能返回旧文件的条目),而是直接用传入的 `filePath` 参数构建条目列表。`loadGitContent` 用 `entry.filePath` 从 `gitRootByFile` 查找仓库根,不依赖 `currentFileGitRoot` computed。`invalidate(filePath)` 同步清除该文件的 `gitContentCache` / `gitDiffStats` 条目(按 `:<filePath>` 后缀匹配)。

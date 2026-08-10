# Document IO Architecture

> **本文件负责**: 文档的打开 / 保存、外部改动同步、崩溃恢复草稿、持久化文件，以及写盘 / echo / watch 相关的设计取舍与维护者注意点。
>
> **何时阅读**: 改 `documentStore` 的打开 / 保存 / 外部变更同步、草稿、持久化语义，或调整 `lastSavedContent` / `lastSelfEmitted` / fs:watch 行为时。
>
> **先记住**:
> - `documentStore.content` 是编辑器文本唯一来源,`dirty = content !== lastSavedContent`(数据流基础见 [架构入口](../ARCHITECTURE.md))。
> - `save()` 写盘**前**先推进 `lastSavedContent`,用于短路自己触发的 fs:watch。
> - `lastSavedContent`(磁盘基线)**只在** `loadContent` / `save` / `saveAs` / `recoverDraft` 里推进,**不在** `setContent` 里推进(后者只回写编辑器内容,不污染基线)。
> - echo 哨兵 `lastSelfEmitted` 防止自 emit 的回写重置光标,**不要**绕过。
> - 草稿恢复 `loadRecoverableDrafts` 必须在 `openPath` 之后调。
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

## 崩溃恢复

脏盘每 30s 写草稿到 `appDataDir/drafts/`;启动时 `loadRecoverableDrafts` 必须在 `openPath` *之后*调,排除当前文档草稿。

## 版本历史(#local-timeline)

每次保存(手动 / 自动 / 失焦)写一份快照到 `appDataDir/versions/{pathId}/{timestamp}.json`,保留最近 20 个(超出按 `savedAt` 修剪)。与草稿分工:草稿是 dirty 期间 30s 定时落盘用于崩溃恢复,写盘成功后清除;版本快照是保存点的只读归档,不参与基线 / echo / fs:watch。`saveDoc` 写盘成功后调 `saveVersionSnapshot` + `pruneVersionSnapshots`(persistence.ts),不经 `versionHistoryStore`(避免循环依赖);store 只在 UI 层懒加载。恢复快照走 `restoreVersionContent`(同 `recoverDraft` 语义:新开标签 + 设磁盘基线让 dirty=true)。浏览入口为 ActivityBar「版本历史」(`SidebarTab='history'`)→ 侧栏 `VersionHistoryPanel` 列出快照条目;点击条目 → 编辑器区切换为 `DiffView`(覆盖编辑器,行级 diff + 「恢复此版本」按钮)。命令面板「浏览版本历史」同样触发此流程。

## 持久化

`appDataDir/{velo-settings.json, velo-outline-state.json, velo-workspaces.json, velo-recent-files.json, drafts/, versions/}`,失败降级不阻塞 UI。`velo-workspaces.json` 走“main 冷启动 active hint + 每个根的 expandedDirs / lastFile / sidebarTab / sidebarWidth / recentFiles”格式;多窗口下 `active` 不代表全局唯一当前工作区,动态窗口只加载 known roots 与 per-root 状态,保存时按当前窗口 active workspace 做 patch merge,不全量覆盖其它窗口新写入的 roots。`velo-recent-files.json` 是跨工作区的全局最近打开文件,与 workspace 内 `recentFiles` 分离;只由显式 `openPath` 成功推进,不监听 `currentFilePath` 变化,避免重命名 / 草稿恢复 / 外部重载误刷新最近时间。全局最近文件用 `{ path, openedAt }` 条目做读盘 merge + 去重排序,降低多窗口错峰写入覆盖。大纲折叠状态(`velo-outline-state.json`)仍按文件 path 存,**不**迁进 per-workspace —— 大纲折叠跟工作区无关,跨工作区打开同一文件应仍记住折叠。

---

## 设计要点

- **自家写盘不打扰**: `save()` 写盘前推进 `lastSavedContent`,自己触发的 fs:watch 被 `disk === lastSavedContent` 短路。
- **`checkExternalChange` canonical 比对**: `lastSavedContent` 是 canonical 形式(`loadContentInto` 过了一遍 markdownIO),但磁盘原文可能与 canonical 不字节相等(多余空行 / whitespace normalize)。save() 写 canonical → 写完后 fast path 命中;未保存时 disk 是 raw → exact match 失败后把 disk 也 canonicalize 再比,避免非 canonical 文件编辑后切窗口 focus 误报"外部修改"。
- **echo 哨兵** (`lastSelfEmitted`): EditorInner / SourceModeEditor dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch 看到匹配则跳过 echo,避免编辑时光标被重置。
- **多窗口草稿 ID 带 window scope**:Tauri 窗口启动后用当前 window label 作为 `draftScope`,草稿 ID 变为 `win-{label}-file-{pathId}` / `win-{label}-untitled`;dev web 或旧路径无 scope 时保留 `file-{pathId}` / `untitled`。这样两个窗口编辑同一文件或各自未命名文档不会互相覆盖草稿,恢复列表按 savedAt 展示多份候选而不是静默合并。

---

## 维护者注意点

- **fs.watch 生命周期 race**: `startWatchOf` / `stopWatch` fire-and-forget 理论可泄漏；`checkExternalChange` 早退故无实际影响。
- **`setContent` 不推进基线**: 编辑器每次按键都回写 `content`,但 `lastSavedContent` 绝不在 `setContent` 里推进。曾用过 `echosToAccept` 计数器让编辑器"规范化回吐"推进基线,但计数器无法区分"编辑器 echo"与"用户真实编辑"—— 用户恰好在 echo 到达前敲键时,编辑被误吞成 echo,把 `lastSavedContent` 推向新内容。后果:切窗口再 focus 时 `checkExternalChange` 看到 `disk(旧) !== lastSavedContent(新) !== content(新)` + `dirty=true`,弹出"文件在编辑器外被修改"误报。基线推进只走 `loadContent` / `save` / `saveAs` / `recoverDraft` 四个入口。
- **`pendingPmDoc` 跳过冗余 fromMarkdown(C0)**: `loadContentInto` 解析出的 PM Node 存入 `DocState.pendingPmDoc`(`markRaw` 包裹),`EditorInner` 在 modelValue watch 与 `useProseMirror` fromMarkdown 回调中通过 `consumePendingPmDoc()` 一次性消费,跳过第二次 `fromMarkdown` 调用。打开链路从 3 次 markdownIO(`fromMarkdown` × 2 + `toMarkdown` × 1)降到 2 次(小文档)或 1 次(大文档 + C0b)。消费后置 `undefined`,不影响 fs:watch / 切标签恢复等路径。
- **`loadContent` 把磁盘内容过一遍 markdownIO canonical**: `markdownIO` round-trip(multi-empty-lines / html inline 等)在 `toMarkdown` 后不与磁盘原文字节相等 —— 用户打开一个 6 空行的文件,即使不编辑,`content` 与 `lastSavedContent` 也会因为 round-trip drift 永远不一致,出现"输入再删回原状也一直 dirty"的 bug。修法:`loadContent` 里把磁盘内容走 `toMarkdown(fromMarkdown(c, schema))`,canonical 形式**同时**塞进 `content` 与 `lastSavedContent`(`content` 也对齐 canonical 而非原文)。后续编辑器 emit 的 canonical 与基线一致,edit + revert 归零;代价是打开磁盘文件时即时规范化(典型 markdown 编辑器行为),多空行等 whitespace drift 在保存时被消除。**不要在 `setContent` 里做这件事**,否则又退化成 echo 误吞(见上条)。
- **尾部空行 `toMarkdown` 出口补偿**(`markdownIO.ts`): `processor.stringify` 按 CommonMark 规范强制文档以单 `\n` 收尾并吃掉尾部空段,导致尾部空行每 round 丢 2 `\n`。但 PM doc 里尾部空段是活的(`<br />` 占位转成的空 paragraph),只是被 stringify 吃掉。`toMarkdown` 出口按 doc 尾部连续空段数 K 补 `\n`(K≥1 时 strip 尾 `\n` 后补 `2K+1` 个),使 `toMarkdown(fromMarkdown(x))` 对尾部空行严格 idempotent —— 2+ 个尾部空行字节守恒。**不要**改 `preprocessBlankLines` 公式做这事:段间占位的 ceil 公式对段间已结构闭合,改它只增风险不解决尾部(stringify 才是吃尾部空段的元凶)。边界:恰好 1 个尾部空行(`X\n\n`,N=2)CommonMark 不可表示,fromMarkdown 不产空段,塌缩成 0 —— 与 VSCode/Typora 同行为,无法绕开除非放弃 remark-parse。

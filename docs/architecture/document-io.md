# Document IO Architecture

> **本文件负责**: 文档的打开 / 保存、外部改动同步、崩溃恢复草稿、持久化文件，以及写盘 / echo / watch 相关的设计取舍与维护者注意点。
>
> **何时阅读**: 改 `documentStore` 的打开 / 保存 / 外部变更同步、草稿、持久化语义，或调整 `lastSavedContent` / `echosToAccept` / `lastSelfEmitted` / fs:watch 行为时。
>
> **先记住**:
> - `documentStore.content` 是编辑器文本唯一来源,`dirty = content !== lastSavedContent`(数据流基础见 [架构入口](../ARCHITECTURE.md))。
> - `save()` 写盘**前**先推进 `lastSavedContent`,用于短路自己触发的 fs:watch。
> - echo 哨兵 `lastSelfEmitted` 防止自 emit 的回写重置光标,**不要**绕过。
> - 草稿恢复 `loadRecoverableDrafts` 必须在 `openPath` 之后调。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [编辑器](./editor.md) / [文件树 / 工作区](./file-tree.md)

---

## 文件操作

- 打开: `confirmDiscardIfDirty` → `openDialog` → `readTextFile` → `loadContent` (设 `echosToAccept=1`)
- 保存: `writeTextFile`,**写盘前乐观推进** `lastSavedContent` 过滤自己的 fs:watch 事件;失败回滚
- Ctrl+S / 失焦 / 关闭拦截走同一 `save()`

## 外部改动同步

`checkExternalChange`(fs:watch + window focus 兜底)按序判定:

1. `disk === lastSavedContent` → 自己的写,忽略
2. `disk === content` → 别人重写为同样内容,刷新基线
3. `!dirty` → 静默 reload
4. `dirty` → 弹确认

## 崩溃恢复

脏盘每 30s 写草稿到 `appDataDir/drafts/`;启动时 `loadRecoverableDrafts` 必须在 `openPath` *之后*调,排除当前文档草稿。

## 持久化

`appDataDir/{velo-settings.json, velo-outline-state.json, velo-workspaces.json, drafts/}`,失败降级不阻塞 UI。`velo-workspaces.json` 走“active root + 每个根的 expandedDirs / lastFile / sidebarTab”格式,跨工作区切换记忆各自展开状态与 sidebar tab。大纲折叠状态(`velo-outline-state.json`)仍按文件 path 存,**不**迁进 per-workspace —— 大纲折叠跟工作区无关,跨工作区打开同一文件应仍记住折叠。

---

## 设计要点

- **自家写盘不打扰**: `save()` 写盘前推进 `lastSavedContent`,自己触发的 fs:watch 被 `disk === lastSavedContent` 短路。
- **echo 哨兵** (`lastSelfEmitted`): EditorInner / SourceModeEditor dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch 看到匹配则跳过 echo,避免编辑时光标被重置。

---

## 维护者注意点

- **fs.watch 生命周期 race**: `startWatchOf` / `stopWatch` fire-and-forget 理论可泄漏；`checkExternalChange` 早退故无实际影响。

# File Tree and Workspace

> **本文件负责**：工作区模型、文件树懒加载、CRUD、右键菜单、内部拖拽 move、虚拟滚动、侧栏外壳（ActivityBar / 设置页 / 资产面板 / 大纲）与相关踩坑。
>
> **何时阅读**：改 `src/components/Sidebar/**`、`src/components/settings/**`、`src/components/ActivityBar*.vue`、`src/stores/workspace.ts` / `editor.ts`、`src/tauri/fs.ts`，或动文件树 CRUD / drag-drop / fs.watch 刷新时。
>
> **代码入口**：`src/components/Sidebar/`（`FileTree.vue` + 5 个 composable + `treeUtils.ts` + `Sidebar.vue` + `EditorOutline.vue` + `AssetPanel.vue` + `VersionHistoryPanel.vue`）、`src/components/settings/`、`src/components/ActivityBar.vue` / `ActivityBarContextMenu.vue` / `FileMenuButton.vue`、`src/stores/workspace.ts` / `editor.ts` / `persistence.ts`、`src/composables/useContextMenu.ts`、`src/components/ContextMenuShell.vue`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [Tauri](./tauri.md) · [工作区搜索](./workspace-search.md) · [文档 IO](./document-io.md)

## 红线

- **TreeNode 必须 `reactive()` 包装**：`dirIndex` 与 `rootNode` 必须持同一份 proxy，否则异步改 `node.loading` / `node.children` 不触发重渲，UI 卡骨架屏且**控制台无报错**。
- **CRUD 后复用旧 TreeNode**（按 name + isDir），不要整树重建。
- **`loadDirChildren` 与 `cancelInline` / `loadContent` 必须同一 microtask**，跨 await 会分两帧 flush 造成闪烁。
- **删除 / 重命名 / 移动当前打开文件走 `documentStore.loadContent` 既有契约**，不要在 FileTree 内自起 watch 或 mutate `currentFilePath`。
- **内部 move 只调一次 `loadContent`**；跨目录 move 后必须 `pruneDirIndexPrefix(srcPath)`。
- **`revealFile` 逐级拼路径用 `join()`**，不要用 `/`（Windows 的 `fullPath` / `dirIndex` key / `expandedDirs` 都是 `\`）。
- **splitter 拖拽用 mouse 事件，不用 HTML5 `draggable`**（Tauri 底层仍监听 dragenter/dragover 探测 OS 文件 drop）。
- **右键菜单统一走 `useContextMenu` + `ContextMenuShell`**，不各写 listener。
- **编辑器侧 flex `min-w-0` 链必须完整**，漏一层侧栏开合就从「压」变「推」。

## 架构

### 模块拆分

| 文件 | 职责 |
| --- | --- |
| `Sidebar/FileTree.vue` | UI 状态机 + 事件接线（展开 / 点击 / 中键 / 右键 / 删除 / revealFile / 全局监听） |
| `Sidebar/useTreeData.ts` | 数据层：`rootNode` / `dirIndex` / `loadDirChildren` / `refreshDir` / `pruneDirIndexPrefix` |
| `Sidebar/useDragMove.ts` | 拖拽源 + 内部 move（hover-expand / 校验 / performMove） |
| `Sidebar/useInlineEdit.ts` | 行内新建 / 重命名状态机 + 校验 + 提交 |
| `Sidebar/useVirtualScroll.ts` | 虚拟滚动 + sticky 目录头（`ROW_HEIGHT=30` / `OVERSCAN=5`） |
| `Sidebar/useCopyPaste.ts` | 复制 / 粘贴（clipboard ref / 目录递归 / `pasteInto`） |
| `Sidebar/treeUtils.ts` | 纯函数：路径 / 排序 / 命名校验 / 错误格式 |
| `Sidebar/RootActionButtons.vue` | 根行四个操作按钮（消除普通行与 sticky 头的重复模板） |
| `Sidebar/Sidebar.vue` | 侧栏容器，按 `sidebarTab` v-if 互斥渲染 |

composable 之间通过回调参数解耦（`closeContextMenu` / `cancelInline` 由 FileTree 传入），不互相引用。

### 数据流

- **CRUD**：`FileTree.vue` 直走 `src/tauri/fs` 的 `mkdir` / `remove` / `rename` / `writeTextFile`，reveal 走 `src/tauri/opener` 的 `revealItemInDir`；随后**主动 `loadDirChildren(parent)` 重拉**，不等 fs:watch 的 120ms debounce。
- **复制 / 粘贴**：组件本地 `clipboard` ref 记源路径 + 是否目录（单实例剪贴板，支持多次粘贴）；文件走 `copyFile`，目录递归 `readDir` + `mkdir` + `copyFile`；`treeUtils.uniqueName` 处理同名（`foo 副本.md`）；禁止贴入自身后代。
- **内部拖拽 move**：文件 MIME `TREE_PATH_MIME`，目录 MIME `TREE_DIR_PATH_MIME`（独立 MIME 让目录无法被拖入编辑器）。校验链 `src===dst` / `parent(src)===dst` / 拖入自身后代；成功后 `fs.rename` → `workspaceStore.renamePathPrefix` → `recentFiles.renamePathPrefix` → `loadContent(content, newPath)`（当前文件命中或落在被移目录子树时用前缀拼新路径，单次调用）→ `pruneDirIndexPrefix` → 双侧 `loadDirChildren`，全程同一 microtask。
- **工作区根 watch**：`activeRoot` 变化时先 stop 后 start 单 recursive 句柄，事件把 `dirnameOf(event.paths)` 入脏目录集，前端 120ms debounce 后对每个脏目录调 `FileTree.refreshDir`。
- **标签持久化**：`WorkspaceState.openTabs` + `activeTab`，数据源是 `documentStore.openFilePaths`；App.vue watcher 写盘（写盘前 dedupe + cap 50）。启动恢复走**两阶段**：Phase 1 `createTabsFromPaths` 只建标签壳（不读盘），Phase 2 `loadContentIntoTabs` 并发读盘装载；`tabsReady` 守门编辑器不闪「未命名」。
- **侧栏宽度**：全局 UI 偏好，`editorStore.sidebarWidth`（200–600，默认 256）→ `velo-settings.json`；`workspaceStore.sidebarWidth` 是 computed，`setSidebarWidth` 委托 editorStore。
- **设置页**：整页接管编辑器主区，`settingsOpen`（tab 是否存在）+ `settingsActive`（是否激活）双 ref 两态模型；分组经 `settings/registerGroups.ts` 注册（内置 3 组：编辑器 / 外观 / 关于，末组仅 `isTauri()` 时注册）。

## 关键取舍

### 树数据与渲染

- **失效工作区只在访问时校验，清理必须穿透 patch merge**：校验放 App shell 的 `handleSetActiveRoot`（不塞进展示组件 `StatusBar`），`exists` 明确 false 才弹确认框，**`exists` 抛错按有效处理**（权限 / 网络盘抖动不能误删记录）。`workspaceStore.removeRoot` 只删内存 key，而工作区保存是「读盘 + merge 当前窗口 patch」语义，磁盘旧 key 会被 merge 回来 → `WorkspacePatch.removedRoots` 每次 patch 都带且不清空，由 `saveWorkspacePatch` 在 merge 后删除，并清掉 `active` hint。启动期只对恢复出的 active root 做一次静默校验，不批量扫全部 known roots。
- **工作区根 watch 必须 `watchImmediate` 而非 `watch`**：plugin-fs 的 `watch()` 内部是 `{ delayMs: 2000 }`，不传 delayMs 时 Rust 侧走 notify-debouncer-full，其 FileIdMap 会在同步 command 里对整棵树 WalkDir 取 file id → 打开含 node_modules 的大目录会占死主线程。`watchImmediate` 强制 `delayMs: undefined` → RecommendedWatcher 递归单句柄。单文件监听仍用 `watch({ delayMs: 100 })`。
- **节点复用 + mutation 后立即清 inline**：`loadDirChildren` 按 name + isDir 复用旧引用，只对增删 entry 建新对象；`submitInline` / `confirmAndDelete` 中 `loadDirChildren` 与 `cancelInline` / `loadContent('', null)` 之间不能有 await。`rebuildFromRoot` 的骨架屏 loading 是 200ms 延迟 toggle（本地 readDir 通常 <50ms，避免闪一帧）。
- **根节点纳入 `flatItems` + 根折叠态本地 ref**：根作为 `depth=0` 第一行渲染；根折叠走组件本地 `rootCollapsed`（切工作区 watch 显式重置），不进 `workspace.expandedDirs`，避免污染 per-path 展开集。空目录也渲染展开箭头（`probeDirEmptiness` 预探测已移除）。`dragstart` 必须先 `closeContextMenu() + cancelInline()`；`effectAllowed` 必须 `'all'`（`'copyLink'` 下 `move` 会被浏览器拒绝）。
- **hover-expand**：拖拽悬停折叠目录 500ms 自动展开；切 row / 容器空白 / dragend / drop 都要 `clearHoverExpandTimer()`，否则 timer 跨拖拽残留造成「幽灵展开」。根目录走 `rootCollapsed` 独立分支。
- **虚拟滚动 + sticky 目录头**：`flatItems` 仍生成完整拍平数组，渲染只 `slice(start, end)` + `OVERSCAN`，上下 spacer 撑总高；`updateViewport` 把虚拟范围与 sticky 头计算合并到同一次 rAF。sticky 头用内存数组 + 固定行高算 offset，不走 `querySelectorAll` / `offsetTop`（消除 O(n) DOM 扫描）。`revealFile` 用 `findIndex` + 手动 `scrollTop` 居中 + 同步 `updateViewport`，不用 `scrollIntoView`（虚拟滚动下目标行可能不在 DOM）。

### 行内编辑与文件系统

- **行内 input 校验失败不自动关闭**：Enter 提交、Esc 取消、点外部提交；失败把错误写进 input 的 `title`，row 保留、焦点回 input。**空名校验必须落在 input value 上**（空 + `.md` = `.md` 仍非空，会漏过 trim 检查）；同名冲突只在 submit 校验，不在 typing 阶段报红。父目录未展开时 `openInlineNew` 须先 `setDirExpanded(true) + loadDirChildren`。
- **删除 / 重命名当前打开文件**：删除命中「当前文件或落在被删子树」→ `loadContent('', null)` 走 store 自己的 stopWatch + 清路径；重命名命中当前文件 → `loadContent(documentStore.content, newPath)`（不动 content / lastSavedContent，只换 path + stopWatch/startWatchOf）。漏走一条 watch 路径会让外部修改检测漂到旧路径。
- **`revealItemInDir` 只能 desktop**：plugin-opener 移动端 unsupported；dev web 端需降级。
- **异步 drop 的两个守卫**：`dropPos` 在落盘前捕获，插入前 clamp 到 `doc.content.size`（否则 silent swallow `RangeError` → 图片丢失无反馈）；`.md` drop 链若等待 dirty 确认框期间又来一次图片 drop，`InsertImageFn` 的 `capturedCurrentFilePath` 与当前 `currentFilePath` 不一致就跳过插入（否则 src 用了旧 assets/ 相对路径 → 图片裂开）。

### 外壳与布局

- **KeepAlive 下必须按 activated/deactivated 管监听**：App shell 缓存 `Sidebar` 实例避免重建 FileTree，但隐藏时全局副作用（FileTree 的 pointerdown / keydown / dragend / hover-expand timer，EditorOutline 的 scroll-spy / rAF）必须解绑。`Sidebar.vue` 内部 files / outline 仍要 v-if 互斥卸载，不要改 v-show。
- **侧栏宽度是全局粒度**：常量 `SIDEBAR_WIDTH_MIN/MAX/DEFAULT` + `clampSidebarWidth` 的 canonical home 在 `stores/editor.ts`，`workspace.ts` re-export 保持 import 路径；`WORKSPACES_VERSION` 已 bump 到 5，旧 JSON 的 per-workspace `sidebarWidth` 由启动期 `migrateWorkspacesIfNeeded` 迁到 `velo-settings.json`（全局值优先，不覆盖已有值）后删除字段。
- **拖拽双阈值 + 死区 snap**：A = `DRAG_COLLAPSE_BELOW`(80) 触发收起，B = `SIDEBAR_WIDTH_MIN`(200) 稳定下限；`[A, B]` 死区内视觉宽度 snap 到 B（`displaySidebarWidth = Math.max(sidebarWidthRef, B)` + `onCommit` 写 B 协同），屏幕上看不到 80–200 的瞬时值。`onDragCollapse` / `onDragReopen` 去重各调一次；`dragCollapseRestoreView` snapshot 必须在拖拽**两端**都清，避免陈旧值误开面板。
- **拖拽中 `pointer-events-none` + 冻结 `.velo-editor` 宽度**：拖拽每帧更新宽度会让鼠标在滞后窗口内反复进出侧栏 → 根行按钮 / 滚动条闪烁；同时宽度变化触发大文档 reflow + `content-visibility` 重算 + ResizeObserver，每帧 >16ms。前者给 `<aside>` 加 `pointer-events-none`，后者在拖拽开始测量 `.velo-editor` 宽度写入 `--velo-drag-editor-width` 并加 `body.velo-dragging-sidebar`（`styles/index.scss` 用固定宽度覆盖），结束再恢复。CM6 虚拟化渲染不需要冻结。
- **ActivityBar 布局是全局 UI 偏好**（走 `editorStore`），不随工作区持久化；「文件」固定顶部、「设置」固定底部，均不参与排序 / 不可隐藏。隐藏当前 active 入口时 App.vue watcher 把 `leftPanelView` 置 null，避免「面板开着但无 active 按钮」悬空态。
- **点文档 tab 自动定位文件树**：`TabBar.onTabClick` → App.vue `onTabClicked`，仅当 `leftPanelView==='sidebar' && sidebarTab==='files'` 时调 `revealFile(path, { flash:false })`；不切 tab 不强制开侧栏，也不加蓝高亮闪（与右键「在文件树中显示」的强制切换 + 闪烁相区别）。
- **`setActiveRoot` 不强切 sidebarTab**：用户主动切工作区保留当前 tab，只把当前 tab 写回新 workspace 记忆；唯一应用持久化 tab 的路径是 `loadFrom`（启动恢复）。`setActiveRoot(null)` 时 `'files'` / `'search'` 回退 `'outline'`，`'outline'` / `'assets'` / `'history'` 保留。

### 设置页与资产面板

- **设置分组可注册**：`settings/registry.ts` 的 `registerSettingsGroup({ id, title, icon, order, component })`，新分组加一行即可；设置页本身不硬编码分组，分组包 `div[data-group-id]` + `scroll-mt-6` 供 scroll-spy / `scrollToGroup` 定位。
- **设置搜索要求全量挂载**：`SettingsPage` 用 `v-show` 切换分组可见性（非 `v-if`），搜索索引才能覆盖未激活分组；`<SettingsItem>` 在 mount 时经 provide/inject 自动注册 label + keywords 到 `useSettingsSearchIndex`，新增设置项无需维护元数据。
- **资产面板**：扫当前文档 markdown 里的 `![alt](src)`（跳过围栏代码块 + 行内 code），按本地 / 外链分组；点击定位用 `NodeSelection.create` + `scrollIntoView` + `focus`，`occurrence` 区分同 src 多次出现；孤儿检测 debounce 300ms 扫 `<docDir>/assets/` 取差集。「重新组织到工作区 `assets/<docName>/`」成功后单事务批量 `setNodeMarkup` 改 src 并触发 autosave。拖入编辑器走独立 MIME `application/x-velo-asset-image`，不写 `text/plain`。
- **`EditorOutline` 的 `settingsActive` prop**：设置激活时跳过 scroll-spy 并显示自身空态，`Sidebar.vue` 不再需要 outline 专属空态分支。

### 标签恢复

- **openTabs restore 必须拍本地副本**：`loadFrom` 之后**立即**把 openTabs / activeTab `.slice()` 到本地变量；restore block 读 store 会被正在跑的 watcher 污染（N 个 tab 只恢复 1 个，并被 500ms debounce 落盘）。
- **批量恢复走 `openPathsInTabs` 并发**：串行 `openPathInTab` 会让 N 个标签逐个出现 + TabBar N 次重渲；批量版把 readTextFile 收进 `Promise.all`，commit 阶段无 await、所有 reactive 触发同一 microtask。`pristineConsumed` 显式跟踪「已消费原始空白文档」，不能依赖串行的隐式语义。
- **落盘前 dedupe + cap**：`setOpenTabsForActiveWorkspace` 写盘前 `dedupePreserveOrder` + `slice(0, 50)`；`normalizeWorkspaceState` 加载时同样清洗旧 JSON。UI 仍允许同 path 多实例 tab（中键新开的显式语义），持久化只记一份。
- **`openPathInTab(path, { silent: true })` 仅用于启动恢复**：被外部删的文件静默跳过 + console.warn；用户主动点开失败仍要弹原生错误框。不引入第二个并行函数。

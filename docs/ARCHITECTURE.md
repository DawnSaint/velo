# Velo Architecture

> **本文件负责**: 架构入口、技术栈 / 目录结构、数据流基础与模块路由。
>
> **何时阅读**: 开始任何任务前先读本文件；改技术栈、目录结构或数据流时直接更新本文件；其余改动按下方路由打开对应 `docs/architecture/*.md`。
>
> **先记住**:
> - 本文件承载全局概览与数据流基础，其余长篇设计细节放在对应模块文档。
> - 架构层变动写入对应模块；只有新增 / 删除 / 重命名模块或路由变化时才改“模块路由”。
> - 非显然 bug 的踩坑记录沉淀到对应模块的“设计要点 / 维护者注意点”。
> - 重大取舍进 `DECISIONS.md`，用户可见版本变化进 `RELEASE_NOTES.md`。
>
> **相关文件**: [DECISIONS](./DECISIONS.md) / [RELEASE_NOTES](./RELEASE_NOTES.md) / [测试](./architecture/testing.md)

---

## 模块路由

| 改动范围 | 读 / 更新 |
|---|---|
| 技术栈、目录结构、全局约定、`documentStore` 唯一数据源、生命周期、状态栏数据流 | 本文件 |
| 打开/保存、外部变更同步、echo 哨兵、草稿、持久化 | [`architecture/document-io.md`](./architecture/document-io.md) |
| ProseMirror 插件链、schema、markdownIO、syntax、NodeView/Decoration、mermaid、shiki、源码模式、跨模式同步 | [`architecture/editor.md`](./architecture/editor.md) |
| Ctrl+F / Ctrl+H、PM/CM6 查找后端、查找高亮、mermaid 源码定位 | [`architecture/find-replace.md`](./architecture/find-replace.md) |
| Sidebar、工作区、FileTree CRUD、文件树拖拽、TreeNode 复用、工作区根 watch、侧栏宽度持久化、auto-collapse、ActivityBar 排序/隐藏持久化、资产面板 | [`architecture/file-tree.md`](./architecture/file-tree.md) |
| Ctrl+P 快速打开、Ctrl+Shift+P 命令面板、Ctrl+Shift+F 全文搜索、fuzzy、最近文件 | [`architecture/workspace-search.md`](./architecture/workspace-search.md) |
| HTML/PDF 导出、mdast walker、DOMPurify、KaTeX、PrintToPDF | [`architecture/export.md`](./architecture/export.md) |
| Tauri 封装层、capabilities、CLI/single-instance、Windows 文件夹右键菜单 | [`architecture/tauri.md`](./architecture/tauri.md) |
| SCSS / Tailwind / scoped style / TS 行内样式分工、暗色模式、CSS 变量、class 命名约定 | [`architecture/styles.md`](./architecture/styles.md) |
| 测试目标、选型、目录规范、Tauri mock 边界、反过度测试、E2E | [`architecture/testing.md`](./architecture/testing.md) |

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 |
| 状态管理 | Pinia |
| 语言 | TypeScript |
| 构建 | Vite |
| 桌面壳 | Tauri 2.0 |
| WYSIWYG 编辑器 | ProseMirror |
| 源代码模式编辑器 | CodeMirror 6 |
| 数学公式 | KaTeX |
| 图表 | Mermaid |
| CSS | Tailwind + Sass |

具体版本见 `package.json` / `src-tauri/Cargo.toml`。

---

## 目录结构

> 只列到目录 + 关键入口文件级别，单个文件的职责在对应模块文档中描述。
> 新增 / 删除 / 重命名目录时同步此处；加文件不需要改这里。

```
velo/
├── docs/                        架构文档、决策记录、变更日志
│   └── architecture/            模块文档（editor / file-tree / export / tauri / styles / testing）
├── src/
│   ├── App.vue                  应用根组件：顶栏 + 主体（ActivityBar + 侧栏 + 编辑器）+ 状态栏
│   ├── main.ts                  应用入口
│   ├── stores/                  Pinia stores（editor / document / outline / folding / workspace / recentFiles / export / persistence）
│   ├── tauri/                   Tauri API 薄封装层（fs / dialog / path / window），业务侧只 import 这里
│   ├── lib/export/              导出管线（mdast walker + shiki / KaTeX / mermaid / DOMPurify）
│   ├── utils/                   跨组件纯工具（fuzzy / commandPalette / quickOpenIndex / workspaceSearch / documentStats 等）
│   ├── composables/             shell 层通用 composable（useContextMenu / useWorkspaceWatch / useCommandPaletteItems / useWorkspaceSearch / useGlobalKeybindings / useCrossModeSync）
│   ├── styles/                  Tailwind + Sass partial
│   ├── test/                    测试基建（vitest setup）
│   └── components/
│       ├── Sidebar/             左侧栏（tab 容器 + 大纲 + 文件树 + 资产面板）
│       ├── settings/            设置页（分组注册表 + 整页 SettingsPage + 各分组组件）
│       ├── ProseMirrorEditor/   WYSIWYG 编辑器核心
│       │   ├── editor/          schema / markdownIO / shortcuts / 源码编辑 session / transactionMeta
│       │   ├── nodes/           自定义 NodeView / Decoration（公式 / mermaid / 任务列表 / 脚注 / 代码块 / TOC / HTML）
│       │   ├── plugins/         通用插件（链接点击 / 空行保护 / remark 插件 / 语法自动转换 / 聚焦 / 打字机 / 粘贴）
│       │   ├── syntax/          实时语法注册表（block / inline）
│       │   ├── findreplace/     查找替换（浮层 UI + PM/CM6 双后端 + 高亮）
│       │   ├── image/           图片 paste/drop 上传 + 删除保护 + 树拖共享
│       │   └── composables/     useProseMirror / useResizeSplitter
│       ├── icons/               图标资源
│       ├── ContextMenuShell.vue 右键菜单通用壳（Teleport + 定位 + 壳样式）
│       ├── TabBar.vue           顶栏标签条（多标签 + 拖拽重排 + 右键菜单）
│       ├── ActivityBar.vue      左贴边功能栏（文件 / 工作区 / 大纲 / 搜索 / 设置）
│       ├── StatusBar.vue        底部状态栏
│       ├── SourceModeEditor.vue 源代码模式（CodeMirror 6 + shiki 高亮）
│       └── (其他)               Breadcrumbs / QuickCommandPanel / FileMenuButton / DraftRecoveryDialog / WelcomeDialog / WindowControls / WorkspaceSearchPanel / crossModeSync
└── src-tauri/
    ├── capabilities/            Tauri 权限配置
    └── src/                     Rust 端（窗口主题 / CLI / single-instance）
```

---

## 全局约定

- **路径别名**: `@/` → `src/`。
- **维护规范**（精炼，不是工作日志）:
  - 描述当前架构的最终状态，不记改动历史；后续修改覆盖前面的内容时只保留最新描述，不堆叠"原 X 现改 Y"的演进叙事
  - 不重述代码里已有注释的实现步骤（函数名 / 行号 / handler 注册顺序 / 内部判断分支等），只写设计的取舍与"踩过的坑"
  - 每条要点聚焦一个关键点：取舍理由 + 触发坑，砍掉步骤化叙述；已有条目覆盖新情况时合并而非新开
  - 版本号标注（`v0.4.x` 等）不进正文，演进记录归 [`RELEASE_NOTES.md`](./RELEASE_NOTES.md) / [`DECISIONS.md`](./DECISIONS.md)
- **新增模块时同步索引**: 新增 / 删除 / 重命名 `docs/architecture/*.md` 时，同步更新本文件“模块路由”。

---

## 数据流

**`documentStore.content` 是编辑器文本的唯一来源**,`dirty = content !== lastSavedContent`。
**生命周期**: `EditorInner.vue` onMounted 起裸 `EditorView`,onBeforeUnmount destroy。外部 modelValue 变化时用 `lastSelfEmitted` 值对比探测自 emit 的 echo,非 echo 则 `view.updateState(EditorState.create(...))` 替换内部 state。
**源代码模式**: `documentStore.sourceMode` 控制渲染哪个编辑器实例。`true` = `SourceModeEditor.vue`(CodeMirror 6,软换行 + 持久行号 + shiki 高亮,无 schema / 无 PM plugin,用户输入经 `updateListener` → `emit('update:modelValue')` 回写 `documentStore.content`);`false` = `ProseMirrorEditor`。两者 `v-if` 互斥挂载,`documentStore.content` 始终唯一数据源,自动保存 / 失焦保存 / 草稿 / fs:watch 透明穿透。echo 哨兵 `lastSelfEmitted` 同 PM 路径。主题切换走 ensureTheme → dispatch CM6 StateEffect → ViewPlugin rebuild(主题名镜像在 StateField,防 ensureTheme 未 resolve 期间全黑,见 [`architecture/editor.md`](./architecture/editor.md) 的 shiki 两条正交路径说明)。

**状态栏**: `App.vue` 汇总 `documentStore` 的内容 / 文件 / dirty / sourceMode、`workspaceStore` 的 active root / known roots，以及当前挂载编辑器上报的光标行列，传给 `StatusBar.vue` 展示。光标行列是 UI-only 状态，不进入 `documentStore`、不持久化；文档统计直接从 `documentStore.content` 计算。源码模式切换入口放在状态栏,仍只翻转 `documentStore.sourceMode`。

**面包屑**: 编辑器顶部常驻 `Breadcrumbs.vue`,显示「文件名 > 标题祖先链」。标题祖先链由当前挂载编辑器经 `heading-context-change` 事件上报(WYSIWYG 走 `headingChainFromDoc` 遍历 PM doc 节点;源码模式走 `headingChainFromMarkdown` 扫 raw markdown 行),与光标行列同属 UI-only 状态,不进 `documentStore`、不持久化。点击标题段复用 `onRevealHeading` 跳转(WYSIWYG 走 DOM `revealHeadingInDom`,源码模式走 `findHeadingRawOffset` + CM6 setSelection)。

**标签持久化**: `WorkspaceState` 增 `openTabs: string[]` + `activeTab?: string`(WORKSPACES_VERSION 4),数据源 `documentStore.openFilePaths`,由 App.vue watcher 自动同步(已有 deep watch 触发 500ms debounce)。启动恢复在 `loadFrom({restoreActive:true})` 命中后:有持久化标签时跳过 `startupMode='last-file'`,走两阶段恢复 —— Phase 1 `createTabsFromPaths` 立即创建全部标签条目(只设 `currentFilePath`,不读盘)让 TabBar 先显示 Tab 标题 + `tabsReady` 守门编辑器,Phase 2 `loadContentIntoTabs` fire-and-forget 并发读盘异步装载内容;无持久化标签时回退 `openPathInTab(lastFile)` / `init('')`;`setActiveRoot` 切工作区**不**应用新 workspace 的 openTabs(同 sidebarWidth READ 语义)。详见 [`architecture/file-tree.md`](./architecture/file-tree.md) 工作区段。

**文件 IO / 同步 / 持久化**: 打开 / 保存、外部改动同步、崩溃恢复草稿、持久化文件,以及写盘 / echo / fs:watch 的设计取舍与维护者注意点,见 [`architecture/document-io.md`](./architecture/document-io.md)。

---

## 同步规则

- 技术栈、目录结构、全局约定、数据流基础直接更新本文件。
- 不要把其他模块的长篇设计记录直接写进本文件；写进对应 `docs/architecture/*.md`。
- 新增 / 删除 / 重命名模块时，同步更新"模块路由"。

# Velo Architecture

> **本文件负责**: 架构入口、技术栈 / 目录结构、数据流基础与模块路由。
>
> **何时阅读**: 开始任何任务前先读本文件；改技术栈、目录结构或数据流时直接更新本文件；其余改动按下方路由打开对应 `docs/architecture/*.md`。
>
> **先记住**:
> - 本文件承载全局概览与数据流基础，其余长篇设计细节放在对应模块文档。
> - 架构层变动写入对应模块；只有新增 / 删除 / 重命名模块或路由变化时才改“模块路由”。
> - 非显然 bug 的踩坑记录沉淀到对应模块的“设计要点 / 维护者注意点”。
> - 重大取舍进 `DECISIONS.md`，用户可见版本变化进 `CHANGELOG.md`。
>
> **相关文件**: [DECISIONS](./DECISIONS.md) / [CHANGELOG](./CHANGELOG.md) / [测试](./architecture/testing.md)

---

## 模块路由

| 改动范围 | 读 / 更新 |
|---|---|
| 技术栈、目录结构、全局约定、`documentStore` 唯一数据源、生命周期、状态栏数据流 | 本文件 |
| 打开/保存、外部变更同步、echo 哨兵、草稿、持久化 | [`architecture/document-io.md`](./architecture/document-io.md) |
| ProseMirror 插件链、schema、markdownIO、syntax、NodeView/Decoration、mermaid、shiki、源码模式、跨模式同步 | [`architecture/editor.md`](./architecture/editor.md) |
| Ctrl+F / Ctrl+H、PM/CM6 查找后端、查找高亮、mermaid 源码定位 | [`architecture/find-replace.md`](./architecture/find-replace.md) |
| Sidebar、工作区、FileTree CRUD、文件树拖拽、TreeNode 复用、工作区根 watch、侧栏宽度持久化、auto-collapse | [`architecture/file-tree.md`](./architecture/file-tree.md) |
| Ctrl+P 快速打开、Ctrl+Shift+P 命令面板、Ctrl+Shift+F 全文搜索、fuzzy、最近文件 | [`architecture/workspace-search.md`](./architecture/workspace-search.md) |
| HTML/PDF 导出、mdast walker、DOMPurify、KaTeX、PrintToPDF | [`architecture/export.md`](./architecture/export.md) |
| Tauri 封装层、capabilities、CLI/single-instance、Windows 文件夹右键菜单 | [`architecture/tauri.md`](./architecture/tauri.md) |
| 测试目标、选型、目录规范、Tauri mock 边界、反过度测试、E2E | [`architecture/testing.md`](./architecture/testing.md) |

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 (`<script setup>`) |
| 状态管理 | Pinia |
| 语言 | TypeScript |
| 构建 | Vite |
| 桌面壳 | Tauri 2.0 |
| 编辑器 | ProseMirror (WYSIWYG) |
| 源代码模式编辑器 | CodeMirror 6 |
| 数学公式 | KaTeX |
| 图表 | Mermaid |
| CSS | Tailwind 3 + Sass |

具体版本见 `package.json` / `src-tauri/Cargo.toml`。

---

## 目录结构

```
velo/
├── docs/
│   ├── ARCHITECTURE.md          架构入口、技术栈、目录结构与数据流基础
│   └── architecture/            架构模块文档（含 testing.md 测试规约）
├── src/
│   ├── App.vue                    顶栏 + 左侧 ActivityBar + 左侧功能区(文件操作 / 工作区文件树 / 大纲 / 设置) + 编辑器 + 底部状态栏
│   ├── stores/                    editor 设置 / document 文件状态 / outline 折叠 / 块级折叠(folding) / workspace 工作区 / recentFiles 全局最近文件 / export / persistence IO
│   ├── tauri/                     Tauri API 薄封装层(fs / dialog / path),业务侧只 import 这里
│   ├── lib/export/                导出管线: markdown → HTML/PDF (mdast walker + shiki/KaTeX/mermaid/DOMPurify 复用)
│   ├── utils/                     fuzzy / commandPalette / quickOpenIndex / workspaceSearch 等跨组件纯工具
│   ├── styles/                    Tailwind + Sass partial
│   └── components/
│       ├── Sidebar/                左侧栏:tab 容器 + 大纲 + 文件树
│       │   ├── Sidebar.vue         大纲 / 文件 tab 切换容器(per-workspace 持久化 tab 选择)
│       │   ├── EditorOutline.vue   嵌在 Sidebar tab 内
│       │   ├── FileTree.vue        工作区根 + 子目录懒加载,点击 .md 打开;图片可见可拖入编辑器(v0.5.1);右键菜单 CRUD + 内部拖拽 move(v0.5.1:行内 input 新建 / 重命名 / 删除 / 在资源管理器中显示 / 跨目录拖动 rename)
│       │   ├── FileTreeContextMenu.vue 右键菜单(纯展示 + 事件转发,v0.5.1 抽组件;v0.5.x 加复制 / 粘贴;Teleport + 暴露 rootEl 供父级全局 pointerdown handler 判定”点外部”)
│       │   ├── useTreeData.ts       树数据 composable:rootNode + dirIndex + 懒加载 / 复用 TreeNode / 展开恢复 / 前缀清孤儿
│       │   └── treeUtils.ts         树纯函数:basename / parentDirOfPath / isAncestorOrSelf / 文件过滤排序 / 命名校验 / fs 错误格式
│       ├── composables/            shell 层通用 composable(v0.5.5 起)
│       │   └── useResizeSplitter.ts  侧栏分隔条:拖拽 / 双击收起 / 窗口过窄自动收起,跑 mousedown + window listener 不走 HTML5 draggable
│       ├── ActivityBar.vue          左贴边功能栏:文件操作 / 工作区 / 大纲 / 全局搜索 / 设置(只发事件,App.vue 持有 shell 状态)
│       ├── FileActionsPanel.vue     左侧文件操作面板:新建 / 打开 / 保存 / 导出命令列表(纯展示 + 事件转发)
│       ├── StatusBar.vue           底部状态栏:工作区 / 文件路径 / 文档统计 / 光标 / 脏盘入口
│       ├── CommandPalettePanel.vue 全局命令面板:Ctrl+Shift+P,聚合 App shell 命令 / 工作区动作 / 全局最近文件,复用 fuzzy 评分
│       ├── RecentFilesButton.vue   顶栏最近文件菜单:读取全局 recentFiles,点击后由 App.vue 统一打开
│       ├── EditorSettings.vue       设置内容,由左侧功能区承载
│       ├── DraftRecoveryDialog.vue
│       └── ProseMirrorEditor/
│           ├── index.vue          壳 (CSS 变量)
│           ├── EditorInner.vue    useProseMirror() + 裸 ProseMirror EditorView
│           ├── nodes/             自定义节点 (公式/mermaid/任务列表/脚注/代码块/TOC)
│           │   ├── MathNodeViews.ts
│           │   ├── MermaidSyntax.ts + MermaidDecoration.ts
│           │   ├── TaskListNodeView.ts
│           │   ├── FootnoteNodeViews.ts
│           │   ├── TocDecoration.ts        TOC 目录 Decoration.widget
│           │   ├── CodeHighlightWidget.ts
│           │   ├── CodeLineNumberWidget.ts  code_block 行号(可选开关)v0.5.11
│           │   ├── FoldDecoration.ts    块级折叠(heading / list_item)v0.5.12
│           │   ├── shikiCmPlugin.ts    源代码模式 CM6 shiki 高亮 ViewPlugin
│           │   └── TextareaEditor.ts  多行 textarea 编辑壳
│           ├── findreplace/       查找替换 (浮层UI + PM/CM6 双后端 + 高亮 + 匹配函数)
│           │   ├── FindReplace.vue   浮层面板(编辑器无关,经 backend 抽象驱动)
│           │   ├── backend.ts        FindReplaceBackend 接口 + createPmBackend/createCmBackend
│           │   ├── findIntent.ts     用户意图 provide/inject key(跨模式保留 query)
│           │   ├── findMatches.ts    buildPattern / findMatchesInDoc / replaceInText 纯函数
│           │   ├── findHighlight.ts  PM 高亮 Plugin (Decoration,findHighlightKey)
│           │   └── cmFindHighlight.ts CM6 高亮 StateField + effect (镜像 PM 侧)
│           ├── image/             图片 paste/drop 上传 + 删除保护 keymap + 树拖共享(treeDrop.ts)
│           ├── plugins/           通用插件
│           │   ├── linkClick.ts        链接点击/源码编辑态 session
│           │   ├── preserveEmptyLine.ts
│           │   ├── remarkAlert.ts      GFM alert remark 插件
│           │   └── syntaxAutoFormat.ts 语法实时转换框架
│           └── syntax/            实时语法注册表
│               ├── index.ts            注册入口
│               ├── block/              段首: heading / codeBlock / blockquote / list / hr / toc
│               └── inline/             段内: emphasis / strike / inlineMath / footnoteRef / link
│       ├── SourceModeEditor.vue    源代码模式 (CodeMirror 6 + shiki 高亮 + 行号)
│       └── crossModeSync.ts        跨模式光标/滚动同步:token 序列 + LCS 对齐
└── src-tauri/
    ├── capabilities/default.json  fs:allow-** (通用文本编辑器)
    └── src/{main,lib}.rs          窗口主题 / CLI args / single-instance
```

---

## 全局约定

- **路径别名**: `@/` → `src/`。
- **文档写当前状态**: 模块文档只描述最终架构与非显然取舍，不堆叠版本演进；演进记录归 [`CHANGELOG.md`](./CHANGELOG.md) / [`DECISIONS.md`](./DECISIONS.md)。
- **新增模块时同步索引**: 新增 / 删除 / 重命名 `docs/architecture/*.md` 时，同步更新本文件“模块路由”。

---

## 数据流

**`documentStore.content` 是编辑器文本的唯一来源**,`dirty = content !== lastSavedContent`。
**生命周期**: `EditorInner.vue` onMounted 起裸 `EditorView`,onBeforeUnmount destroy。外部 modelValue 变化时用 `lastSelfEmitted` 值对比探测自 emit 的 echo,非 echo 则 `view.updateState(EditorState.create(...))` 替换内部 state。
**源代码模式**: `documentStore.sourceMode` 控制渲染哪个编辑器实例。`true` = `SourceModeEditor.vue`(CodeMirror 6,软换行 + 持久行号 + shiki 高亮,无 schema / 无 PM plugin,用户输入经 `updateListener` → `emit('update:modelValue')` 回写 `documentStore.content`);`false` = `ProseMirrorEditor`。两者 `v-if` 互斥挂载,`documentStore.content` 始终唯一数据源,自动保存 / 失焦保存 / 草稿 / fs:watch 透明穿透。echo 哨兵 `lastSelfEmitted` 同 PM 路径。主题切换走 ensureTheme → dispatch CM6 StateEffect → ViewPlugin rebuild(主题名镜像在 StateField,防 ensureTheme 未 resolve 期间全黑,见 [`architecture/editor.md`](./architecture/editor.md) 的 shiki 两条正交路径说明)。

**状态栏**: `App.vue` 汇总 `documentStore` 的内容 / 文件 / dirty / sourceMode、`workspaceStore` 的 active root / known roots，以及当前挂载编辑器上报的光标行列，传给 `StatusBar.vue` 展示。光标行列是 UI-only 状态，不进入 `documentStore`、不持久化；文档统计直接从 `documentStore.content` 计算。源码模式切换入口放在状态栏,仍只翻转 `documentStore.sourceMode`。

**文件 IO / 同步 / 持久化**: 打开 / 保存、外部改动同步、崩溃恢复草稿、持久化文件,以及写盘 / echo / fs:watch 的设计取舍与维护者注意点,见 [`architecture/document-io.md`](./architecture/document-io.md)。

---

## 同步规则

- 技术栈、目录结构、全局约定、数据流基础直接更新本文件。
- 不要把其他模块的长篇设计记录直接写进本文件；写进对应 `docs/architecture/*.md`。
- 新增 / 删除 / 重命名模块时，同步更新“模块路由”和“旧位置迁移速查”。
- 文档写当前架构最终状态，不写工作日志；重大取舍用 ADR，普通用户可见变化用 CHANGELOG。

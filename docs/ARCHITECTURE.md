# Velo



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
| 导出 | HTML 自包含 + PDF (Tauri command 调平台原生 PrintToPDF via `with_webview`) |

具体版本见 `package.json` / `src-tauri/Cargo.toml`。

---

## 目录结构

```
velo/
├── docs/ARCHITECTURE.md
├── src/
│   ├── App.vue                    顶栏 + 侧边栏(大纲 / 文件) + 编辑器 + 设置
│   ├── stores/                    editor 设置 / document 文件状态 / outline 折叠 / workspace 工作区 / export / persistence IO
│   ├── tauri/                     Tauri API 薄封装层(fs / dialog / path),业务侧只 import 这里
│   ├── lib/export/                导出管线: markdown → HTML/PDF (mdast walker + shiki/KaTeX/mermaid/DOMPurify 复用)
│   ├── styles/                    Tailwind + Sass partial
│   └── components/
│       ├── Sidebar/                左侧栏:tab 容器 + 大纲 + 文件树
│       │   ├── Sidebar.vue         大纲 / 文件 tab 切换容器(per-workspace 持久化 tab 选择)
│       │   ├── EditorOutline.vue   嵌在 Sidebar tab 内
│       │   ├── FileTree.vue        工作区根 + 子目录懒加载,点击 .md 打开;图片可见可拖入编辑器(v0.5.1);右键菜单 CRUD + 内部拖拽 move(v0.5.1:行内 input 新建 / 重命名 / 删除 / 在资源管理器中显示 / 跨目录拖动 rename)
│       │   ├── FileTreeContextMenu.vue 右键菜单(纯展示 + 事件转发,v0.5.1 抽组件;Teleport + 暴露 rootEl 供父级全局 pointerdown handler 判定"点外部")
│       │   ├── useTreeData.ts       树数据 composable:rootNode + dirIndex + 懒加载 / 复用 TreeNode / 展开恢复 / 前缀清孤儿
│       │   └── treeUtils.ts         树纯函数:basename / parentDirOfPath / isAncestorOrSelf / 文件过滤排序 / 命名校验 / fs 错误格式
│       ├── EditorSettings.vue
│       ├── ExportButton.vue        顶栏导出按钮(Ctrl+Shift+E)
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

## ProseMirror 插件链

按 `EditorInner.vue` 里 `allPlugins` 数组顺序:

| 插件 | 用途 |
|------|------|
| keymap(Backspace/Delete → headingToParagraph) | 标题退格/删除转段落 (不降级 h2→h1) |
| keymap(Mod-z/y/Shift-z) | 撤销/重做 |
| keymap(Enter → dollarEnterCmd) | `$$`+Enter 进块级公式编辑态 |
| keymap(baseKeymap) | 接管基础键 |
| dropCursor / gapCursor | 拖放光标 + 跨非文本节点光标 |
| history | 撤销/重做栈 |
| tabIndent | Tab 缩进/反缩进;代码/段落插4空格;非列表 Shift-Tab 消费 |
| imageKeymapPlugin | atom 节点删除保护 (Backspace/Delete 紧贴先选中不直接删) |
| imageUploadPlugin | paste/drop 拦截 → 落盘 → 插入 image 节点。OS 拖入只接 image/*(文本返回 false);文件树拖入(自定义 MIME `application/x-velo-tree-path`,仅文件) .md 打开 / 图片落盘插图;**目录走独立 MIME `application/x-velo-tree-dir-path` 且不写 text/plain**,编辑器侧不识别 → 目录自然无法拖入编辑器(防止误把路径串当文本插)。共享 `image/treeDrop.ts` |
| markdownPastePlugin | text/plain 粘贴走 fromMarkdown,绕开 ProseMirror 默认 plain-text fallback 的 normalizeSiblings 错误合并(见设计要点) |
| linkClickPlugin + linkEditEscapeKeymap | 链接单击进源码编辑 / Cmd 跳转 / Escape 还原 |
| syntaxAutoFormatPlugin | dirty-range 局部扫,registry 驱动 (见设计要点) |
| codeHighlightPlugin | shiki dual-theme 代码高亮 + toolbar widget (见设计要点) |
| imageInlineViewPlugin | image NodeView (Tauri asset:// 代理) |
| mathEditPlugin | math_inline/block NodeView (KaTeX 实时预览) |
| mermaidDecoration | 扫 `code_block { language: 'mermaid' }` 渲染 SVG / 编辑态切换 widget (见设计要点) |
| taskListPlugin | `- [ ]` / `- [x]` checkbox NodeView |
| footnoteEditPlugin | 脚注 NodeView + 位置收集 |
| tocDecoration | `[TOC]` 目录 Decoration.widget (嵌套标题列表 + 点击跳转) |
| findHighlight | 查找替换高亮 |
| `buildShortcutKeymap`(editor/shortcuts)| declarative registry 输出的快捷键 keymap,统一在 `bindings.ts` 注册 |
| inputRules | ellipsis/emDash 纯文本快速路径 (其余语法走 syntaxAutoFormat) |

**markdown 解析**走 `editor/markdownIO.ts` 的 unified pipeline (remark-parse + remark-gfm + remark-math + preserveEmptyLine)。`fromMarkdown(md)` → EditorState,`toMarkdown(doc)` 回写。**键入触发**走 syntaxAutoFormat,不走 unified。

---

## 数据流

**`documentStore.content` 是编辑器文本的唯一来源**,`dirty = content !== lastSavedContent`。

**生命周期**: `EditorInner.vue` onMounted 起裸 `EditorView`,onBeforeUnmount destroy。外部 modelValue 变化时用 `lastSelfEmitted` 值对比探测自 emit 的 echo,非 echo 则 `view.updateState(EditorState.create(...))` 替换内部 state。

**源代码模式**: `documentStore.sourceMode` 控制渲染哪个编辑器实例。`true` = `SourceModeEditor.vue`(CodeMirror 6,软换行 + 持久行号 + shiki 高亮,无 schema / 无 PM plugin,用户输入经 `updateListener` → `emit('update:modelValue')` 回写 `documentStore.content`);`false` = `ProseMirrorEditor`。两者 `v-if` 互斥挂载,`documentStore.content` 始终唯一数据源,自动保存 / 失焦保存 / 草稿 / fs:watch 透明穿透。echo 哨兵 `lastSelfEmitted` 同 PM 路径。主题切换走 ensureTheme → dispatch CM6 StateEffect → ViewPlugin rebuild(主题名镜像在 StateField,防 ensureTheme 未 resolve 期间全黑,见维护者注意点 #5)。

**文件操作**:

- 打开: `confirmDiscardIfDirty` → `openDialog` → `readTextFile` → `loadContent` (设 `echosToAccept=1`)
- 保存: `writeTextFile`,**写盘前乐观推进** `lastSavedContent` 过滤自己的 fs:watch 事件;失败回滚
- Ctrl+S / 失焦 / 关闭拦截走同一 `save()`

**外部改动同步** (`checkExternalChange`, fs:watch + window focus 兜底):

1. `disk === lastSavedContent` → 自己的写,忽略
2. `disk === content` → 别人重写为同样内容,刷新基线
3. `!dirty` → 静默 reload
4. `dirty` → 弹确认

**文件树 CRUD**(v0.5.1): `FileTree.vue` 右键菜单(由 `FileTreeContextMenu.vue` 抽组件)直走 `src/tauri/fs` 的 `mkdir` / `remove` / `rename` / `writeTextFile` + `src/tauri/opener:revealItemInDir`(plugin-shell 的 `open(path)` 不能"高亮文件",plugin-opener 专门补这条);新建 / 重命名走行内 input,`.md` 后缀不可编辑自动拼接;mutation 后立刻 `loadDirChildren(parent)` 主动重拉,不等 fs:watch 的 120ms debounce;`loadDirChildren` **按 name + isDir 复用旧 TreeNode 引用**,未变化的子树 props 不变,Vue 跳过;children 更新与行内编辑 / 打开文件关闭合并在同一 microtask 同步排列,Vue 一次 flush,避免两帧闪烁。**联动 `documentStore`**:删除影响"当前打开文件"(含落在被删子树里的情况)→ `loadContent('', null)` 关闭文件,内容丢;重命名"当前打开文件"→ 走 ROADMAP line 19 同款"路径同步更新 currentFilePath 不重载内容"语义,通过 `documentStore.loadContent(content, newPath)` 复用 stopWatch + startWatchOf 路径,destructive op(destructive op 必 confirm,删除 dirty 文件文案加"未保存修改将丢失")在 FileTree 内弹原生 confirm。**内部拖拽 move**:文件走 TREE_PATH_MIME,**目录走 TREE_DIR_PATH_MIME**(独立 MIME 让目录无法被拖入编辑器,详见 imageUploadPlugin 行);FileTree 内部 drop 两种 MIME 都接受走 `fs.rename`(对 file/dir 同管线);校验链 src===dst / parent(src)===dst / 目录拖入自身后代;成功后 `fs.rename` → `workspace.renamePathPrefix(srcPath, newPath)` 把 expandedDirs / lastFile 前缀重写 → `loadContent(content, newPath)` 当前文件命中或落在被移目录子树时直接前缀拼新路径(单次调用避免双 watch swap) → `pruneDirIndexPrefix(srcPath)` 摘掉脱链子树 dirIndex 孤儿(否则 fs.watch 拿旧路径调 `refreshDir` 会在死节点上置 `node.error`) → 双侧 `loadDirChildren` 同 microtask flush。

**单实例 + 文件关联**: 冷启动走 `PendingCliArgs` + `get_cli_args`;二次启动走 `tauri-plugin-single-instance` → `cli-args` 事件。argv 解析(`parse_cli_args`)同时返回 `{files: .md 路径, dirs: 目录路径}`:files 路由 `documentStore.openPath`,dirs 路由 `workspaceStore.setActiveRoot`(目录与文件互不冲突,工作区根 + 当前文档各管各的);二次启动走目录分支**不**弹 dirty 确认——切工作区不动当前编辑文档。Windows "在 Velo 中打开"右键菜单(v0.5.1)由 `folder_menu::ensure_registered` 在 `setup()` 写 HKCU\Software\Classes\Directory\shell\OpenInVelo,启动期 best-effort 每次重写(见设计要点)。

**崩溃恢复**: 脏盘每 30s 写草稿到 `appDataDir/drafts/`;启动时 `loadRecoverableDrafts` 必须在 `openPath` *之后*调,排除当前文档草稿。

**持久化**: `appDataDir/{velo-settings.json, velo-outline-state.json, velo-workspaces.json, drafts/}`,失败降级不阻塞 UI。`velo-workspaces.json` 走"active root + 每个根的 expandedDirs / lastFile / sidebarTab"格式,跨工作区切换记忆各自展开状态与 sidebar tab。大纲折叠状态(`velo-outline-state.json`)仍按文件 path 存,**不**迁进 per-workspace —— 大纲折叠跟工作区无关,跨工作区打开同一文件应仍记住折叠。

**工作区**: `workspaceStore` 持有 `activeRoot` / `workspaces[root].{expandedDirs,lastFile,sidebarTab}` / `sidebarTab`。`Sidebar.vue` 走 tab 互斥渲染(v-if 而非 v-show,免得 EditorOutline scroll-spy DOM 监听与 FileTree dirIndex 同时活着争 scroll container)。工作区根挂单 recursive `fs.watch`(delayMs:150 + 前端 120ms 二次防抖,脏目录集驱动 `FileTree.refreshDir` 子树重拉)。`documentStore.currentFilePath` 变化同步到 `workspaceStore.lastFile`,重开工作区时可恢复。**`setActiveRoot` 不强切 sidebarTab**:用户主动切工作区(顶栏"打开文件夹"按钮 / 二次启动 dir argv / 树右键"作为工作区打开")保留当前 tab,只把当前 tab 写回新 workspace 记忆;**唯一**应用持久化 tab 的路径是 `loadFrom`(启动恢复)。否则"用户在文件 tab 时切工作区被强制弹回大纲"反直觉。

---

## 设计要点

- **自家写盘不打扰**: `save()` 写盘前推进 `lastSavedContent`,自己触发的 fs:watch 被 `disk === lastSavedContent` 短路
- **echo 哨兵** (`lastSelfEmitted`): EditorInner / SourceModeEditor dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch 看到匹配则跳过 echo,避免编辑时光标被重置
- **mermaid 走 Decoration.widget 不走 NodeView**: atom NodeView 的 outer dom `innerHTML` 变更会被 ProseMirror DOMObserver 当外部突变 → 全量 remount + 每字符 loader 闪烁;widget 的 `ignoreMutation` 默认忽略非 selection 突变。当前 `mermaid` 节点已废弃,```` ```mermaid ```` 改走 `code_block { language: 'mermaid' }`,由 `MermaidDecoration` 扫 code_block 渲染 SVG widget + 自管切换/删除/关闭按钮(默认 pre 隐藏,SVG `side:-1` 渲染在其前;点击 SVG 派发 setMeta 翻转 editNodePos,展开时 `queueMicrotask` 把光标放进 pre)。**坑**: plugin promise resolve 后不要 dispatch setMeta rebuild decorations,直接在 widget dom 上写 svg,否则 `WidgetType.eq` 失效 → 死循环;主题切换同理走 window listener 自改 dom + `spec.destroy` removeEventListener 防泄漏
- **mermaid + codeHighlight 双 plugin 分工**: codeHighlight 负责所有 code_block 的 toolbar + 语法高亮;mermaid 走 MermaidDecoration 自管 SVG widget + 切换/删除/关闭按钮(codeHighlight 在 lang='mermaid' 上不挂 toolbar,避免同 pos 同 side 多 widget 冲突)
- **mermaid 语法高亮旁路 shiki**: shiki bundled mermaid grammar 薄(只输出按行纯文本 token),`codeHighlight` 对 `lang==='mermaid'` 走自写 `tokenizeMermaid`(6 类:keyword/direction/shape/edge/label/comment),颜色从当前代码块主题按 TextMate scope 提取 hex 写进 `--shiki-light/dark` 局部变量(同 shiki token 形态);主题切换/dark 切换两条路径同 shiki
- **shiki dual-theme 代码高亮**: `codeToTokensWithThemes` 返回 token 级双色,每 token inline `--shiki-light/dark` 变量,SCSS 按 `html.dark` 选。**darkMode toggle 纯 CSS 切色(零重渲);换主题(换 hex)才 rebuild**,由 App.vue watch 触发。首屏零闪烁:App.vue `codeBlockReady` 守门 PM mount;`state.init` 同步拿 cached highlighter
- **shiki 预扫 + 懒加载 lang**: 启动只装 doc 实际 lang ∪ 5 项 BASELINE(js/ts/py/bash/json);运行时 miss 用 `hl.getLoadedLanguages()` 探活(不能用 `getLanguage()`,miss 时 throw),异步追加 grammar 后**不直接 rebuild highlighter**,经 plugin 端 `setDecorationRebuildCallback` 钩子让 plugin 自己 rAF 节流 rebuild decorations(见维护者注意点 #5)。**首次 miss 那帧无 token 是有意为之的"先骨架后着色"**
- **语法实时转换走 appendTransaction + dirty-range**(不走 InputRule 末尾匹配): `syntaxAutoFormat.ts` 从 `tr.mapping.maps` 提 dirty range → textblock 段首检测 + inline 正则扫描,黑名单(code_block/html_block/math_block)、code mark、link session 框架统一过滤。新增语法 = 写一个文件 + `syntax/index.ts` 注册一行。**坑**: block detector pattern 带 `^` 不带 `g`;inline 带带 `g` 不带 `^/$`;inline 扫描前 atom 用 NBSP 占位防穿透;语法 apply 直接改框架传入的 `tr`,不要自己 dispatch
- **NodeView 隔离**: `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror
- **粘贴 text/plain 必须注册 `clipboardTextParser`**: ProseMirror 默认 plain-text fallback 把整段按 `\n+` 拆 `<p>` 再 `normalizeSiblings` 自动包 blockquote,产出错位 doc。`markdownPastePlugin` 走 fromMarkdown 输出**封闭 slice `(0,0)`**(非 `maxOpen`)走标准 "join 前后 paragraph" 路径把 blocks merge 进 doc 顶层
- **样式分层**: ProseMirror 基础排版内联 `<style>`,公式/Mermaid/脚注/TOC 走 SCSS partial
- **TOC 目录走 Decoration.widget 不走 NodeView**: 跟 mermaid 同范式;widget key 含 headingsHash,变化自动重建。**坑**: `[TOC]` 回写 toMarkdown 必须用 mdast `html` 节点(非 text)包裹,text 节点里的 `[` 会被 escape 成 `\[`
- **源代码模式**: `SourceModeEditor` 独立 CodeMirror 6 `EditorView`,与 `ProseMirrorEditor` 经 `v-if` 互斥;`documentStore.sourceMode` 唯一开关。extensions: 持久行号 + 软换行 + drawSelection + highlightSpecialChars + history + 自定义 keymap(Tab 插 2 空格覆盖 `indentWithTab`;Escape → `toggleSourceMode`)+ `forbidFileDropPaste`(v0.5.1 起分叉:文件树拖入路径(自定义 MIME `application/x-velo-tree-path`) → .md 打开 / 图片落盘插图;OS 文件型 drop 图片同样落盘插 markdown 语法,与富文本行为镜像;非图片文件 drop preventDefault 防 webview 导航;paste 仍保持吞 image/*——源码模式 paste 无"树路径"概念。共享逻辑见 `image/treeDrop.ts`)+ shiki 高亮 ViewPlugin(`shikiCmPlugin.ts`,token.offset 即 CM6 doc pos)+ updateListener(docChanged → emit)。**主题名镜像在 StateField**,build 只读镜像不读 store(防 ensureTheme 未 resolve 期间全黑);dark/light 纯 CSS,切主题才 rebuild
- **跨模式光标 + 浏览状态同步**: App.vue 单点 `watch(sourceMode, cb, { flush: 'pre' })` 覆盖全部切换入口(Ctrl+\` / 工具栏 / Esc 都走这一个布尔翻转)。`flush:'pre'` 读**出**方向 view(卸载在 render 阶段,晚于 pre-flush watcher)抓锚点;`await nextTick` 后**入**方向 `onMounted` 已建 view → 应用。`crossModeSync.ts`: 两边各 token 化(剥 markdown 标记字符 `#*~_\`-+[]()!>|`——**`|` 入集关键**,否则无空格表格粘成一个 token),`captureAnchor` 取光标 ±64 个 token 序列 + token 内字符偏移,`applyAnchor` 跑 **LCS** 对齐(链接 URL、表格 `|`/`|---|` 分隔行是 CM6 多出、PM 没有的 token,整窗 indexOf 砍不掉 → 失败跳顶;LCS 当"未对齐"跳过)。光标 token 自身是多余方(如落在 URL 里)→ 退最近对齐邻居边界。最佳努力:空文档/view 未就绪放弃;LCS 矩阵超 4M 格(token > ~31k)退线性首现。滚动:CM6 `scrollIntoView(pos,{y:'center'})`;PM **不用** `tr.scrollIntoView()`(默认"最小滚入视口"= 跳到最底),改 `coordsAtPos`+祖先 `scrollBy` 居中;入方向主动 focus
- **查找替换双后端 (PM / CM6 共用)**: `FindReplace.vue` 经 `FindReplaceBackend` 抽象驱动,`createPmBackend`/`createCmBackend` 两份实现,`v-if/v-else` 互斥同一时刻一份活着。**用户意图(query/选项/替换文/showReplace)上提到 App.vue `provide(findIntentKey)`**,切模式时意图在 App.vue 存活 → query 跨模式保留;`matches`/`currentIndex` 模式相关,新挂载时 recompute。`replaceAll` 编辑器无关化:倒序遍历 matches,每个 `getRangeText` → `replaceInText`(全局正则在 match 子串重跑)→ `replaceRange`,逆序避免位置错位。两后端语义差异各自符合该模式所见文本(PM 走 prose 文本不跨块;CM6 在原始 markdown 全串含 `**`/`|`/`[]()` 可跨行);highlight PM 走 PM plugin setMeta、CM6 走 StateField + effect(镜像 PM 侧)。高亮 CSS `.velo-find-match`/`.velo-find-current` 全局共用
- **导出管线**: `lib/export/htmlRenderer.ts` 复用 `markdownIO.ts` 的同一份 unified pipeline(7 个 remark 插件)parse 出 mdast,自写轻量 walker 转 HTML 字符串,**不走 ProseMirror doc**(省去 PM doc → mdast 二次桥接)。**必须 `processor.runSync(processor.parse(md))` 而非只 `parse`** —— transformer 类插件(remarkAlert/remarkHighlight/remarkEncodeLinkUrls)在 run 阶段才执行(见维护者注意点 #14)。节点逐个 dispatch:code lang='mermaid' 走 mermaidHtml、其他 code 走 shikiHtml(复用 `CodeBlockLangs` 的 getHighlighterSync/getTokensSync,与编辑器 `CodeHighlightWidget` 同套 API 保证配色一致)、math 走 katexHtml(失败降级 `<span class="math-error">`)、html 走 sanitizeHtml(DOMPurify,配置与 `HtmlNodeView.ts` 同步,见维护者注意点 #11)、行内 html 先 `mergeHtmlInlineRunsMdast` 合并再 sanitize(见维护者注意点 #13)、image src 走 `convertFileSrc` 转 `asset://`(外部浏览器不解析——已知限制)、inline marks 嵌套、list 抽首段 paragraph 解包避免 `<li><p>` 割裂、alert → `<div class="velo-alert velo-alert-{variant}">`(对齐 editor schema toDOM,不包 blockquote)、table 标准化、**[TOC] 独占段落 → `<div class="velo-toc">` 嵌套目录**(headings 整篇预扫,链接用 `<a href="#slug">` 走原生锚点跳转)。降级:mermaid/katex/shiki 任一失败 → 原文/`math-error` + 收进 `warnings`,不中断。Dual theme token 仍写双 hex,dark 靠 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)` 接管(同 GitHub README 自适应);`@media print` 强制 light 给 PDF 用。**KaTeX 字体 inline base64**(`katexCss.ts` 走 `import.meta.glob` 把 20 个 woff2 inline,改写 `@font-face` src,否则相对 `url(fonts/...)` 在导出环境解析不到 → 字体回退,见维护者注意点 #20)

- **PDF 路径**: 不走 `iframe + window.print()` 弹系统对话框,改走 Tauri `with_webview` 调平台原生 PrintToPDF,与 Typora / Obsidian 同款静默写盘 UX。链路:前端 `invoke('export_pdf', { outputPath, html })` → Rust `pdf::export_pdf`(`src-tauri/src/pdf.rs`)新建 `visible(false)` 隐藏打印窗口(label `velo-pdf-printer-<n>`,`PRINTER_ID` 自增)→ `with_webview` 拿平台 handle → **Windows(完整实现,`pdf_windows.rs`)** cast `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`(`SetShouldPrintBackgrounds(true)` 必开,默认不打印背景),NavigationCompleted 后发起 PrintToPdf,`oneshot` 桥接 async;**macOS / Linux** 当前返回 `PdfError::Unsupported`。HTML 靠 `navigate("data:text/html;base64,...")`(需 tauri `webview-data-url` feature);`PRINT_LOCK` 全局 `tokio::Mutex` 防并发,30s 超时兜底;打印完 `printer.close()`。**走隐藏窗口而非主 webview**:`Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 所在 JS 上下文,弹不出反馈且回不来(见维护者注意点 #12)

- **store (`stores/export.ts`)**: `exportDocument()` 调 `saveDialog` 多 filter(HTML / PDF),按扩展名 dispatch:`.html` → `buildExportHtml` + `writeTextFile`;`.pdf` → `invoke('export_pdf', { outputPath, html })`。**reentrant 守门**(`exporting.value` 期间第二次调用立刻返回);成功/失败弹原生 `message`(故 Rust 端走隐藏打印窗口保主 webview 活着);**不**改 `currentFilePath`/`lastSavedContent`/`fs:watch` —— 导出是"产出一份静态文件",与"切换到那个文件继续编辑"是不同语义(见 DECISIONS ADR-20260621-001)

- **工作区根 fs.watch 走单 recursive 句柄 + 脏目录集 debounce**: `activeRoot` 变化时先 stop 后 start(沿用 documentStore 同款 race 容忍策略),回调把 `dirnameOf(event.paths)` 入 `dirtyDirs` Set,前端 120ms `setTimeout` 二次 debounce flush → 对每个脏目录调 `FileTree.refreshDir(dir)` 重拉那棵子树。`readDir` 一次 < 5ms,**不做 path diff**,简单可靠。当前文件 watch 与工作区根 watch 共存:当前文件也落在根树下会收到两份事件,documentStore 内 `disk === lastSavedContent` 短路 + `externalCheckInFlight` 重入保护已足够去重,不需要协调。**已知限制**:notify-rs 对网络盘 / OneDrive 漏报在目录级比文件级更严重,window-focus 兜底只覆盖当前文件,工作区根侧暂无等价兜底(代价高),见 DECISIONS ADR-20260623-001

- **Tauri API 业务侧只 import `src/tauri/*`**: `src/tauri/{fs,dialog,path}.ts` 是 `@tauri-apps/*` 的薄 re-export,业务代码不再直 import `@tauri-apps/plugin-fs` / `plugin-dialog` / `api/path`。`tauriOnly()` 命名导出从 persistence 内部 helper 提升到 `@/tauri/fs`,所有需要 web dev 端降级的地方统一通过它判断。封装层**不**统一错误形态 —— 调用方各自降级策略(persistence 走默认值 / document.save 弹 message / imageStorage throw)消化原 plugin-fs 不一致的错误形态。后续测试 mock 可逐步从 `@tauri-apps/*` 收敛到 `src/tauri/*`,本期保留旧 mock 形态借 vi.mock 透传(见 DECISIONS ADR-20260623-002)

- **"在 Velo 中打开"文件夹右键菜单走 HKCU 注册表 + 每启动 best-effort 重写**: `folder_menu::ensure_registered` 写在 HKCU\Software\Classes\Directory\shell\OpenInVelo(verb 子键 + command 子键),不写 HKLM —— HKCU 不需要 UAC 提升,普通用户启动即可注册;Windows shell 解析 Classes 时合并 HKCU+HKLM,效果等价。每次 `setup()` 重写而非"仅缺时写":自动跟随 exe 路径变化(用户把 Velo 拖到别处的场景),HKCU 写盘是同步快速 op 无可感知开销。命令模板 `"<exe>" "%1"` —— `%1` 而非 `%V`(后者用于 Directory\Background\shell 空白右键,本菜单挂的是 Directory\shell 即"右键文件夹"),引号必加防止路径含空格被拆词。失败仅 log::warn 不抛 —— Velo 是本地编辑器,菜单是 nice-to-have,启动不该被注册表故障阻塞

- **大纲搜索过滤是视图层独立路径,不污染 tree / 折叠态 / store**: 顶部搜索框按 heading 文本做大小写不敏感的子序列 fuzzy 匹配(`src/utils/outlineFilter.ts:fuzzyMatch` + `fuzzyMatchIndices` + `filterHeadings`,不引第三方库)。filter 阶段完全不动 `outlineStore` / `collapsedKeys`,也不维护祖先链 —— "仅展示命中条目",祖先不命中就不入列;`flatList` walker 在 filter 激活时对非命中祖先跳过 push 但**仍递归走完子树**,防止深层命中被漏掉。filter 模式下隐藏 chevron(`hasChildren = false`):命中条目为扁平列表,没有"展开/折叠"的语义需求,清空 query 后用户原折叠意图原样回归。关键字字符在 displayText 内联渲染主题色高亮段(`buildSegments` 把 `matchIndices` 切成 `{ text, match }[]`,模板逐段渲染,匹配段用 `<span>` 加 `color: var(--md-primary-color)` + `font-semibold`,**不**加背景色避免文字抖动);搜索框 focus 边色同样走 `--md-primary-color`,与大纲高亮色源统一。scroll-spy 沿用 `flatList.visible` 集合自动适配 filter 模式,filter 命中区间外的滚动位置自然失高亮,无需特例分支

---

## 维护者注意点

> **禁令速查**(只路由到正文,不重复理由;改对应代码前先查这里):
>
> - 不要 `dispatch setMeta` 触发 mermaid / shiki 重建 —— mermaid 见设计要点「mermaid 走 Decoration.widget」;shiki darkMode 切色见 #5
> - 不要 `await getHighlighter` 后立刻 dispatch —— 见 #5
> - 不要用 `getLanguage()` 探活 miss —— 见设计要点「shiki 预扫 + 懒加载 lang」
> - 语法 apply 直接改框架传入的 `tr`,不要自己 dispatch —— 见设计要点「语法实时转换」
> - 不要把脚注编号写回 `attrs.label` —— 见 #4
> - 快捷键不要在 EditorInner.vue 硬编码 —— 见 #9
> - inline syntax regex 不要依赖 registry 顺序,自带 word boundary —— 见 #10
> - DOMPurify 配置改一处必须同步另一处 —— 见 #11
> - PDF 新建窗口必须在 async command 里做,闭包不能 self-reference —— 见 #12
> - 行内 raw HTML 不要孤立 sanitize,先合并 —— 见 #13
> - 导出不要只 `parse(md)`,必须 `runSync` —— 见 #14
> - Windows PDF 不要忘 `SetShouldPrintBackgrounds(true)` —— 见 #15
> - 导出 DOM class 名不要与 editor NodeView 跑偏 —— 见 #16
> - 导出脚注 slug 不要复用 heading slugify 的 toLowerCase —— 见 #17 / #19
> - 导出 KaTeX 字体不要漏 inline —— 见 #20
> - 新增暗色规则不要只写一边 —— 见 #21
> - 新增 mdast node 类型不要漏 walker case(walker 不自动递归未知 children) —— 见 #22
> - FileTree 新增节点不要 raw 对象,必须 `reactive()` 包 —— 见 #23
> - 异步图片 drop 不要直接 `tr.insert(dropPos)`,必须 clamp + 比对 currentFilePath snapshot —— 见 #24
> - `[TOC]` 回写 toMarkdown 不要用 text 节点 —— 见设计要点「TOC 目录走 Decoration.widget」
> - FileTree CRUD 写盘后不要 `loadDirChildren` 全量重建,要复用旧 TreeNode —— 见 #28
> - FileTree CRUD 后 children 更新与 inline 关闭不要跨 await(否则两帧闪烁) —— 见 #28
> - FileTreeContextMenu 不要在组件内自己挂全局 close listener,统一走父级 —— 见 #29
> - FileTree 内部拖拽 move 不要先 `loadContent(content, srcPath)` 再切到 newCur,也不要在 fs.rename 成功后 `loadContent(content, oldPath)` —— 见 #30
> - 不要清理 `getTokensCached` 这层 LRU —— 见 #32

1. **路径别名**: `@/` → `src/`
2. **fs.watch 生命周期 race**: `startWatchOf`/`stopWatch` fire-and-forget 理论可泄漏;`checkExternalChange` 早退故无实际影响
3. **Tauri 权限**: `capabilities/default.json` fs 开 `**`(通用文本编辑器),分发时收紧
4. **脚注 label 是显示文本,无自动编号**: 扩展点是在 `FootnoteNumberPlugin.state` 加 `numbering: Map<label, number>`,**不要**把编号写回 `attrs.label`(丢语义,跟 GFM 不符)
5. **shiki 两条正交路径**: darkMode toggle 纯 CSS 切色(零重渲,不要 dispatch setMeta);换主题 hex 变了才 rebuild,由 App.vue watch 触发。懒加载 lang(`ensureLanguage`)/主题(`ensureTheme`)只 append grammar/hex **不重建 highlighter**,走 plugin 端 `setDecorationRebuildCallback` 钩子让 plugin 自己决定 rebuild 时机;**不要 await getHighlighter 后立刻 dispatch setMeta**。CM6 源码模式同理:主题名镜像在 StateField,build 只读镜像(防 ensureTheme 未 resolve 期间全黑)
6. **clipboard 统一走** `@tauri-apps/plugin-clipboard-manager` 的 `writeText`
7. **code toolbar widget 用真盒子**,不能 `display:contents`: `display:block; height:22px`,`side:-1` 渲染在 `<pre>` 之前,用 `:has(+ pre:hover)` 联动 hover
8. **dev web 端 Tauri API 必须 `isTauri()` 守门**: 纯 vite 调 `@tauri-apps/api/*` 同步 throw,单行 throw 会让 async 整条 reject。`persistence.ts` 走 `tauriOnly()`;`App.vue` 顶层 `const tauri = isTauri()`,fire-and-forget 异步 `if (tauri)` 守门,onMounted await 链路整段 `if (tauri) { ... }` 包裹
9. **快捷键 declarative registry**: 所有键位在 `editor/shortcuts/bindings.ts` 集中注册,**不**在 EditorInner.vue 硬编码。新加快捷键 = 新建 command 文件 + `bindings.ts` 加 1 行 `registerShortcut(...)`,不碰 EditorInner / registry.ts
10. **inline syntax regex 必须自带 word boundary**,不依赖 registry 顺序防误识别: 开口 `(?<!\W)` / 闭口 `(?!\W)` 等挡前后导;inner 不含分隔符(如 strong inner `[^\n*]+?`)。例:`**33**` 必须被 strong 吃掉、`text==hi==` 不应被 highlight 误识别 —— 见 `syntax/inline/strong.ts` / `highlight.ts` 顶部注释
11. **导出 DOMPurify 配置必须与 `HtmlNodeView.ts` 同步**: `lib/export/sanitizeHtml.ts` 的 `PURIFY_CONFIG` 与 `nodes/HtmlNodeView.ts` 字段一致(FORBID_TAGS / FORBID_ATTR / ALLOWED_URI_REGEXP);任一处变更两处同步改。后续可抽 `src/lib/sanitizeConfig.ts` 共用
12. **PDF 走隐藏打印窗口而非主 webview**: `Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 上下文,弹不出反馈且应用回不来;隐藏窗口让主应用全程不动。初始 URL 选 `about:blank`(tauri-runtime-wry 对其特判为"不设初始 URL",避免"初始页 vs data URL"两个 NavigationCompleted 竞态)。Windows: cast `ICoreWebView2_7` 拿 PrintToPdf、cast `ICoreWebView2Environment6` 拿 CreatePrintSettings(v1 环境没这方法);`SetShouldPrintBackgrounds(true)` 必开(默认不打印背景,alert SVG / 代码块底色 / 暗色底全丢)。HTML 注入靠 `navigate("data:text/html;base64,...")`(需 `webview-data-url` feature)。`PRINT_LOCK` 防并发,30s 超时兜底。**新建窗口必须在 async command 里做**(`WebviewWindowBuilder::build` 从同步 command / 事件 handler 调会死锁);**闭包不能 self-reference**(webview7/settings 必须 move 进 handler)。macOS / Linux 待实现
13. **行内 raw HTML 必须先合并再 sanitize**: remark 把 `<kbd>Mod</kbd>` 拆成 html/text/html 3 个 mdast 节点,孤立开标签被 DOM parser 自动闭合成 `<kbd></kbd>` → `Mod` 游离到标签外。编辑器(`markdownIO.ts:mergeHtmlInlineRuns`)/导出(`htmlRenderer.ts:mergeHtmlInlineRunsMdast`)各走一个标签栈状态机(开标签 push、闭标签 pop、栈空 flush)合并成整段再一次性 sanitize,两份逻辑刻意同构,改一处同步另一处。**已知限制(两侧一致)**:HTML 区域内夹带 mark(emphasis/strong/link 等)会丢,保 mark 需重写成 span tree,留后续
14. **导出必须 `runSync(parse(md))` 不能只 `parse`**: unified 的 `parse()` 只跑 parser,transformer 类插件(remarkAlert/remarkHighlight/remarkEncodeLinkUrls,返回 `tree => {...}`)在 `run()`/`runSync()` 阶段才执行。只 parse 会导致 alert 仍是 blockquote、`==高亮==` 不生效、链接 URL 空格不 encode。修复后导出与 editor `fromMarkdown` 同形:`processor.runSync(processor.parse(md) as Root)`。`remarkGfm` 不受影响(同时注册 micromark 扩展,parse 期生效)。`remarkPreserveEmptyLine` 是 parser 拦截,注入的 `<br />` 空段占位由 walker `isEmptyBrPlaceholder` 兜成 `''`,加 runSync 不改变
15. **Windows PDF 必须开 `SetShouldPrintBackgrounds(true)`**: WebView2 `ICoreWebView2_7::PrintToPdf` 默认 `ShouldPrintBackgrounds=false`,不打印任何 `background-color`/`background-image`(alert `::before` SVG 图标、shiki 代码块底色、表格条纹、暗色底全丢)。`CreatePrintSettings()` 后必须调该 setter;设置失败不致命,best-effort `let _ =` 忽略。导出 HTML 的 `@media print` 把底色翻 light 供 PDF 用,前提就是背景会被打印。导出 task list `<li>` 挂 `class="velo-task-item"`(exportStyles.scss 给 `list-style:none`)去默认 disc 圆点 —— editor 侧靠 `li[data-item-type="task"]` 去圆点,导出走 native `<input type="checkbox">`,用 class 单独兜
16. **导出 DOM class 名必须与 editor NodeView verbatim 一致**: 导出样式来源是 `_editor-*.scss` 经 `@forward` 注入 `exportStyles.scss`,前提是 walker 输出 DOM 的 class 名跟 editor NodeView 一致;class 跑偏 → 样式落空(踩坑:footnote `footnote-ref-node` vs `footnote-ref`)。规约:加 NodeView / 重命名 class 时,grep `class="...` 看 export 侧 walker 写的类名,两边字符串 verbatim 一致。**非原生控件(task checkbox / 自定义折叠箭头等)editor / export DOM 形态必然不同**:editor 靠 `data-item-type` / `.task-content` 等选择器,导出走 native `<input>`,那些规则不命中 —— 要么在 `exportStyles.scss` 末尾补 export-only 覆盖规则,要么改 walker 复刻 editor DOM,不要假设 @forward 进来就有了
17. **导出脚注 def 对齐编辑器 flex 三段**: `_footnote.scss` 把 `.footnote-definition` 写成 `display:flex` 三段(`.footnote-label` 标号 + `.footnote-content` 描述 + `.footnote-backref` 回链 ↩)+ `.footnote-content > p { display:inline; margin:0 }` 拉平首段。导出 walker 必须输出同款 class/id:`<div class="footnote-definition" id="velo-fn-{slug}">...</div>`。**ref 端类名有意拆开**:导出是静态 `<sup><a href="#...">label</a></sup>`,套编辑器 `.footnote-ref-node` 的 contentEditable 专有样式(cursor/outline/user-select/:focus)无意义或冲突,所以 walker 走单独的 `.footnote-ref` class;`_footnote.scss` 必须有 `.footnote-ref` 块镜像 `.footnote-ref-node` 视觉(主色 + hover 高亮 + border-radius/font-size),`.footnote-ref a` 显式 `color:inherit; text-decoration:none`。`htmlRenderer.test.ts` 的 SCSS 源断言守住这条规则。slug 用 `label.replace(/[^a-zA-Z0-9_-]/g, '_') || 'fn'`(大小写敏感保留、非 ASCII 替 `_`,**不能**复用 heading slugify 的 toLowerCase)
18. **blockquote 必须 reset `margin:0`**: 浏览器默认 `blockquote { margin: 1em 40px }`,那 40px 让 border-left 离行头 40px(引用线右偏)。`_editor-typography.scss` 只设 `padding` 没 reset margin。导出 HTML / 编辑器内一并修(共用同一份 typography partial)
19. **导出内部锚点 fragment 必须同源 slugify**: heading id 走 `slugify()`,外部浏览器把 href 字面空格 url-encode 成 `%20` 作 fragment,两边对不上 → HTML 点了没效果、PDF 不可点击(编辑器内 ctrl+click 有 `linkClick.ts:scrollToAnchor` 运行时 fallback,导出静态 HTML 没这层)。修法:导出 `case 'link'` 在 decode 后若 `href.startsWith('#')`,把 fragment 喂同款 `slugify()` 重写;**外部 URL fragment 不动**(远端 id 由远端决定)。规约:heading id 与内部链接 fragment 必须出自同一个 slugify 函数
20. **导出 KaTeX 字体必须 inline**: katex.min.css 里 `@font-face` 引用 `url(fonts/KaTeX_*.{woff2,woff,ttf})`,编辑器侧 Vite side-effect import 会改写 url();但**导出走 `?inline` 拿 CSS 原文,Vite 不改 url()**,导出旁无 `fonts/` → 字体回退。`lib/export/katexCss.ts` 顶层 `import.meta.glob` 拿 20 个 woff2 base64 data URI,`inlineKatexWoff2Fonts` 把每条 `@font-face` 的 src 改写成单条 woff2 data URI 并 strip woff/ttf(现代浏览器含 WebView2 首选 woff2,后两条只是 fallback;只 inline woff2 压到 ~340KB 而非全部 60 文件 ~1.3MB)。vitest 走纯函数 `inlineKatexWoff2Fonts(css, fontMap)` 验转换逻辑(`?inline` 在 vitest 与 prod build 行为不一致返回空)
21. **新增暗色规则要两处同步**: editor 走 `_editor-dark.scss` 的 `:is(.dark .velo-editor, .velo-editor.dark)`(Vue 控制 `<html class="dark">`),export 走 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)`(**自写副本,不 forward `_editor-dark.scss`**,导出 HTML 无 `.velo-editor.dark` 依赖)。两套语义不等价:导出只跟系统暗色偏好走,不能跟应用内 toggle 走。新增暗色规则必须两边写
22. **新增 mdast node 类型必须改 walker + CSS**: 导出 walker 的 `mdastNodeToHtml` switch `default: return ''` **静默丢节点**(无 warn 无错误)—— 任何 mdast 类型 walker 不显式 case,导出 HTML 直接消失。规约:新增自定义 mdast type = walker 加 case + 输出 DOM + class 名跟 editor NodeView 一致(联动 #16);新增 block 容器类型(children-recurse,类似 alert/blockquote)也要加专门 case 内部 `node.children.map(mdastNodeToHtml)`,**不要假设 walker 会自动递归未知 children** —— walker 只对已知 case 递归。checklist:加新 syntax 同时 grep `case '` 看 walker 是否覆盖
23. **FileTree 的 TreeNode 必须 `reactive()` 包装**: `dirIndex: Map<string, TreeNode>` 与 `rootNode = ref<TreeNode>` 持有同一份引用,如果用 raw 对象,`rootNode.value = node` 后 ref 里是 proxy,Map 里是 raw,异步 `loadDirChildren` 对 raw 改 `node.loading=false / node.children=[...]` 不触发模板重渲 → UI 永远卡在"加载中…"且**控制台无报错**。`makeNode` 统一返回 `reactive({...})`,保证 dirIndex 与 rootNode 内全是 proxy

24. **treeDrop / imageUploadPlugin 异步 drop 的 dropPos 越界 + race 守卫**:
    - `dropPos` 在落盘(含 `saveImageAssetFromPath` 磁盘读 + SHA-256 + 写,可达数秒)之前就已捕获,用户在此期间继续编辑导致 doc 变长/变短 → 原先的 pos 可能越界。`insertImageNode` 里做了 `Math.min(Math.max(dropPos, 0), doc.content.size)` clamp,**不 clmap 会 silent swallow RangeError → 图丢了用户无反馈**。
    - `.md drop → confirmDiscardIfDirty → openPath` 这条链如果等待对话框期间又来了一次图片 drop,那张图的 `dropPos` / `srcForMarkdown` 都是针对旧 doc 算的。`handleTreePathDrop` 产出的 `InsertImageFn` 签名带了 `capturedCurrentFilePath` 参数,`imageUploadPlugin` / `SourceModeEditor` 两侧在回调开头对比当前 `documentStore.currentFilePath` vs `captured`,不一致就跳过插入。**不跳则图插到新 doc 里 src 用了旧 assets/ 相对路径 → 图片裂开**。
25. **行内 input 校验失败不要自动关闭**: v0.5.1 起新建 / 重命名不再走 modal,改行内 input(对齐 VSCode / Finder 约定)。Enter 提交、Esc 取消、点外部提交。submit 时跑 validate(空名 / `.` `..` / 禁用字符 / 同名),失败把 `inlineNew.error` / `inlineRename.error` 写进 input 的 `title` 属性,row 仍存在,焦点回 input。**空名校验必须落在 input value 上,不能在 finalName(已拼 `.md`)上** —— 空 + ".md" = ".md" 仍非空,会漏过 trim 后的检查。同名冲突这种"前端 children 视图可能不完整"的情况也只放在 submit 时校验,不在 typing 阶段报红字打扰用户。父目录若未展开,`openInlineNew` 须先 `setDirExpanded(true) + loadDirChildren`,否则 inline row 落到不可见的折叠子树
26. **重命名 / 删除当前打开文件 → 走 `documentStore` 既有契约,不要在 FileTree 内自起 watch**:
    - 删除:`deleteContainsOpenFile(pathToDelete)` 判 `currentFilePath === pathToDelete || currentFilePath.startsWith(pathToDelete + sep())`,命中就 `loadContent('', null)` 让 documentStore 走自己的 stopWatch + 清 currentFilePath 路径(等价"用户从 OS 删了再打开")
    - 重命名:`currentFilePath === node.fullPath` 时调 `loadContent(documentStore.content, newPath)` —— 不动 content / lastSavedContent,只换 path + 内部 stopWatch + startWatchOf(newPath)(等价 `saveAs` 的 watch 切换路径)。**不要**自己 dispatch watch / 自己 mutate currentFilePath,store 内部 `loadContent` 才同步触发 stopWatch / startWatchOf + syncTitle,漏走一条 watch 路径都会让外部修改检测漂到旧路径上,文件重命名后再编辑 = checkExternalChange 拿旧路径读文件找不到
27. **Tauri 2 plugin-opener 只能 desktop**: `revealItemInDir` 移动端 unsupported,Velo 当前只打 desktop,future 加 mobile entry 时需自行在 capability / 调用点降级(消息弹"不支持")
28. **FileTree 节点复用 + mutation 后立即清 inline 状态,避免整树闪烁**: v0.5.1 起 CRUD 写盘后,`loadDirChildren` **必须**按 name + isDir 复用旧 `TreeNode` 引用,只对新增 / 删除的 entry 建新对象。否则父级 `flatItems` computed 看到新 proxy 引用就 reconcile 整树 → 整树重渲闪烁;复用后未变化的子树 props 不变,Vue 跳过。`submitInline` / `confirmAndDelete` 中 `loadDirChildren` 与 `cancelInline` / `loadContent('', null)` 之间**不能有 await**(会跨 microtask 边界,Vue 分两帧 flush),必须同一 microtask 同步排列,Vue 一次 flush 渲染。`loadDirChildren` 内部 `node.loading` 切换在子目录不可见(只有根 root 触发"加载中…"),所以根的 loading 由 `rebuildFromRoot` 单独 toggle,`loadDirChildren` 不再 toggle,免得在没必要的子树触发 2 次额外 reactive 通知
29. **FileTreeContextMenu 抽组件 + rootEl expose**: 右键菜单 5 项固定 UI + 5 个 emit,跟 FileTree 状态机耦合很浅,内联在 FileTree 会撑长模板。`FileTreeContextMenu.vue` 自管 `<Teleport to="body">` 并 `defineExpose({ rootEl })` 暴露 Teleport 后的 DOM 节点;FileTree 全局 `pointerdown` handler 拿 `contextMenuRef.value?.rootEl` 判定"点外部"关闭。**不**在组件内自己挂全局 listener(会和 FileTree 的 inline input close 逻辑竞争),也不在组件 emit close(让父级统一管理 `contextMenu.value` 状态)

30. **FileTree 内部拖拽 move:状态前缀重写 + dirIndex prune + 单次 loadContent**:
    - 与重命名 / 删除一样走 `documentStore.loadContent(content, newPath)` 既有契约,**不**自起 watch / 手动 mutate currentFilePath。dir 移动并包含当前文件时,直接合成 `newCur = newPath + cur.slice(srcPath.length)` 一次性传入,**不要**先 loadContent(content, srcPath) 再切到 newCur —— 两次 startWatchOf 会留一个指向已不存在路径的 watch 窗口。
    - `workspaceStore.renamePathPrefix(oldPath, newPath)` 必须早于 loadContent,把 `expandedDirs` / `lastFile` 中以 oldPath 为前缀的项整体重写;否则下次重开工作区 isDirExpanded 命中旧路径,readDir 抛错,整树降级到只展开根。
    - `pruneDirIndexPrefix(srcPath)` 必须紧跟 rename 成功:被移走的目录子树在 dirIndex 里全是孤儿(rootNode 已找不到它们,但 dirIndex 持有 key),后续工作区 fs.watch 用旧路径 debounced 调 `refreshDir` 会撞到孤儿,`readDir(deadPath)` reject 写 `node.error` 污染脱链节点。
    - 同 microtask 收尾(参考 #28):`fs.rename` resolve 之后 → renamePathPrefix → loadContent(必要时)→ pruneDirIndexPrefix → `Promise.all([loadDirChildren(srcParent), loadDirChildren(dstDir)])` 全程无 await 间隔,Vue 单帧 flush。

31. **根节点纳入 flatItems + 1 级"空目录"探测**: v0.5.1 起根节点作为 `flatItems` 第一行渲染(`depth=0`),不再用顶部独立 label 显示。右键根 row 走 rootContext 上下文菜单(同空白处右键),仅显示"新建文件 / 新建文件夹",其余项(重命名 / 删除 / reveal / 作为工作区打开)对根无意义。
    - **根折叠态走组件本地 `rootCollapsed` ref,不持久化**:折叠是临时 UI 操作,切工作区 / 重启都视觉默认展开。切工作区的 watch 必须显式重置 `rootCollapsed.value = false` —— FileTree 组件不会 unmount/remount,不重置会从上个工作区继承折叠态。不走 `workspace.expandedDirs` 是为了避开两个问题:一是污染"per-path 展开集"语义,二是要为旧 v0.5.0 工作区记忆做兼容默认展开的反写,徒增 store 复杂度。
    - "空目录隐藏箭头"逻辑:子目录 `children !== undefined && children.length === 0` 时不渲染展开箭头,但根 row 永远显示(根永远是目录,保留折叠 / 展开 affordance)。
    - 让"空 / 非空"在父目录加载完后立即生效(而非用户点击展开后才知道),`loadDirChildren` 末尾 fire-and-forget 对每个新 child dir 跑 `probeDirEmptiness`:**只在结果为空时**把 child.children 置 [],非空保留 undefined(留给用户首次展开时 `loadDirChildren` 全量加载)——这样不破坏懒加载初衷,只多打一次"是否为空"的轻量 readDir。
    - race 守卫:探测 await `readDir` 期间用户可能已点击展开 → `loadDirChildren` 抢先把 children 填好;探测 resolve 后必须重判 `children !== undefined`,命中就放弃覆盖。失败(权限等)静默 —— 等用户真正点开时 `loadDirChildren` 会暴露真实错误。
    - dragstart 必须先 `closeContextMenu() + cancelInline()`:菜单 / 行内 input 在拖拽期间残留,drop 时全局 pointerdown 会把行内 input 误提交。
    - `effectAllowed` 必须是 `'all'` 而非 `'copyLink'`:dropEffect='move' 必须在 effectAllowed 子集内,否则浏览器视为非法 → 树内 drop 拒绝;编辑器侧自行计算 dropEffect 不受 source 宽放影响。
    - **hover-expand**: 拖拽悬停折叠目录 500ms 自动展开(VSCode 行为),`armHoverExpand(dstDir)` 在 `onRowDragOver` 命中目录 row 时挂 timer;切到别的目录 / 文件 row / 容器空白 / dragend / drop 都必须 `clearHoverExpandTimer()`,否则 timer 跨拖拽残留,下次悬停同目录 500ms 内会触发"幽灵展开"。文件 row 解析到的父目录已展开(否则文件不可见),不挂 timer。根目录走 `rootCollapsed` 而非 `workspace.expandedDirs`,所以 `armHoverExpand` 对根 path 走独立分支。

32. **shiki token 必须缓存,`getTokensCached` 是 per-keystroke 关键路径**: `props.decorations(state)` 契约无脏区间钩子,每次 transaction 全量重跑;1000 行文档对所有 code_block 同步跑 `codeToTokensWithThemes` 累计 ~100ms 卡顿,实测占输入路径总耗时 90%+。`CodeBlockLangs.ts` 走 LRU(cap 200)按 `(lang + lightTheme + darkTheme + content-hash)` 缓存 token 数组,普通段落键入 ~99% 命中,单次 deco build 从 ~100ms 降到 ~5ms。**不要清理这层 cache,删了立刻退步 20x**。缓存值是 token 而非 Decoration —— `token.offset` 是块首相对偏移,与 doc 位置无关,`buildDecorations` 仍走 `blockStart + offset` 重算绝对 pos;直接缓存 Decoration 会脏(`Decoration.inline` from/to 是绝对位置,块在 doc 里移动就过时)。theme 名进 key 自然处理"切代码块主题"路径,rebuild 触发由 #5 那条 `setDecorationRebuildCallback` 钩子统一管。

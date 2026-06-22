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
│   ├── App.vue                    顶栏 + 大纲 + 编辑器 + 设置
│   ├── stores/                    editor 设置 / document 文件状态 / outline 折叠 / export / persistence IO
│   ├── lib/export/                导出管线: markdown → HTML/PDF (mdast walker + shiki/KaTeX/mermaid/DOMPurify 复用)
│   ├── styles/                    Tailwind + Sass partial
│   └── components/
│       ├── EditorOutline.vue
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
│           ├── image/             图片 paste/drop 上传 + 删除保护 keymap
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
| imageUploadPlugin | paste/drop 拦截 → 落盘 → 插入 image 节点(只接 image/*,文本返回 false) |
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

**单实例 + 文件关联**: 冷启动走 `PendingCliArgs` + `get_cli_args`;二次启动走 `tauri-plugin-single-instance` → `cli-args` 事件。

**崩溃恢复**: 脏盘每 30s 写草稿到 `appDataDir/drafts/`;启动时 `loadRecoverableDrafts` 必须在 `openPath` *之后*调,排除当前文档草稿。

**持久化**: `appDataDir/{velo-settings.json, velo-outline-state.json, drafts/}`,失败降级不阻塞 UI。

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
- **源代码模式**: `SourceModeEditor` 独立 CodeMirror 6 `EditorView`,与 `ProseMirrorEditor` 经 `v-if` 互斥;`documentStore.sourceMode` 唯一开关。extensions: 持久行号 + 软换行 + drawSelection + highlightSpecialChars + history + 自定义 keymap(Tab 插 2 空格覆盖 `indentWithTab`;Escape → `toggleSourceMode`)+ `forbidFileDropPaste`(源码模式禁拖入/粘贴图片,防 webview `dragDropEnabled:false` 下把文件当"打开"导航掉整页;PM 模式由 `imageUploadPlugin.handleDOMEvents.drop` 兜这个 preventDefault,源码模式无等价 PM 插件)+ shiki 高亮 ViewPlugin(`shikiCmPlugin.ts`,token.offset 即 CM6 doc pos)+ updateListener(docChanged → emit)。**主题名镜像在 StateField**,build 只读镜像不读 store(防 ensureTheme 未 resolve 期间全黑);dark/light 纯 CSS,切主题才 rebuild
- **跨模式光标 + 浏览状态同步**: App.vue 单点 `watch(sourceMode, cb, { flush: 'pre' })` 覆盖全部切换入口(Ctrl+\` / 工具栏 / Esc 都走这一个布尔翻转)。`flush:'pre'` 读**出**方向 view(卸载在 render 阶段,晚于 pre-flush watcher)抓锚点;`await nextTick` 后**入**方向 `onMounted` 已建 view → 应用。`crossModeSync.ts`: 两边各 token 化(剥 markdown 标记字符 `#*~_\`-+[]()!>|`——**`|` 入集关键**,否则无空格表格粘成一个 token),`captureAnchor` 取光标 ±64 个 token 序列 + token 内字符偏移,`applyAnchor` 跑 **LCS** 对齐(链接 URL、表格 `|`/`|---|` 分隔行是 CM6 多出、PM 没有的 token,整窗 indexOf 砍不掉 → 失败跳顶;LCS 当"未对齐"跳过)。光标 token 自身是多余方(如落在 URL 里)→ 退最近对齐邻居边界。最佳努力:空文档/view 未就绪放弃;LCS 矩阵超 4M 格(token > ~31k)退线性首现。滚动:CM6 `scrollIntoView(pos,{y:'center'})`;PM **不用** `tr.scrollIntoView()`(默认"最小滚入视口"= 跳到最底),改 `coordsAtPos`+祖先 `scrollBy` 居中;入方向主动 focus
- **查找替换双后端 (PM / CM6 共用)**: `FindReplace.vue` 经 `FindReplaceBackend` 抽象驱动,`createPmBackend`/`createCmBackend` 两份实现,`v-if/v-else` 互斥同一时刻一份活着。**用户意图(query/选项/替换文/showReplace)上提到 App.vue `provide(findIntentKey)`**,切模式时意图在 App.vue 存活 → query 跨模式保留;`matches`/`currentIndex` 模式相关,新挂载时 recompute。`replaceAll` 编辑器无关化:倒序遍历 matches,每个 `getRangeText` → `replaceInText`(全局正则在 match 子串重跑)→ `replaceRange`,逆序避免位置错位。两后端语义差异各自符合该模式所见文本(PM 走 prose 文本不跨块;CM6 在原始 markdown 全串含 `**`/`|`/`[]()` 可跨行);highlight PM 走 PM plugin setMeta、CM6 走 StateField + effect(镜像 PM 侧)。高亮 CSS `.velo-find-match`/`.velo-find-current` 全局共用
- **导出管线**: `lib/export/htmlRenderer.ts` 复用 `markdownIO.ts` 的同一份 unified pipeline(7 个 remark 插件)parse 出 mdast,自写轻量 walker 转 HTML 字符串,**不走 ProseMirror doc**(省去 PM doc → mdast 二次桥接)。**必须 `processor.runSync(processor.parse(md))` 而非只 `parse`** —— transformer 类插件(remarkAlert/remarkHighlight/remarkEncodeLinkUrls)在 run 阶段才执行(见维护者注意点 #14)。节点逐个 dispatch:code lang='mermaid' 走 mermaidHtml、其他 code 走 shikiHtml(复用 `CodeBlockLangs` 的 getHighlighterSync/getTokensSync,与编辑器 `CodeHighlightWidget` 同套 API 保证配色一致)、math 走 katexHtml(失败降级 `<span class="math-error">`)、html 走 sanitizeHtml(DOMPurify,配置与 `HtmlNodeView.ts` 同步,见维护者注意点 #11)、行内 html 先 `mergeHtmlInlineRunsMdast` 合并再 sanitize(见维护者注意点 #13)、image src 走 `convertFileSrc` 转 `asset://`(外部浏览器不解析——已知限制)、inline marks 嵌套、list 抽首段 paragraph 解包避免 `<li><p>` 割裂、alert → `<div class="velo-alert velo-alert-{variant}">`(对齐 editor schema toDOM,不包 blockquote)、table 标准化、**[TOC] 独占段落 → `<div class="velo-toc">` 嵌套目录**(headings 整篇预扫,链接用 `<a href="#slug">` 走原生锚点跳转)。降级:mermaid/katex/shiki 任一失败 → 原文/`math-error` + 收进 `warnings`,不中断。Dual theme token 仍写双 hex,dark 靠 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)` 接管(同 GitHub README 自适应);`@media print` 强制 light 给 PDF 用。**KaTeX 字体 inline base64**(`katexCss.ts` 走 `import.meta.glob` 把 20 个 woff2 inline,改写 `@font-face` src,否则相对 `url(fonts/...)` 在导出环境解析不到 → 字体回退,见维护者注意点 #20)

- **PDF 路径**: 不走 `iframe + window.print()` 弹系统对话框,改走 Tauri `with_webview` 调平台原生 PrintToPDF,与 Typora / Obsidian 同款静默写盘 UX。链路:前端 `invoke('export_pdf', { outputPath, html })` → Rust `pdf::export_pdf`(`src-tauri/src/pdf.rs`)新建 `visible(false)` 隐藏打印窗口(label `velo-pdf-printer-<n>`,`PRINTER_ID` 自增)→ `with_webview` 拿平台 handle → **Windows(完整实现,`pdf_windows.rs`)** cast `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`(`SetShouldPrintBackgrounds(true)` 必开,默认不打印背景),NavigationCompleted 后发起 PrintToPdf,`oneshot` 桥接 async;**macOS / Linux** 当前返回 `PdfError::Unsupported`。HTML 靠 `navigate("data:text/html;base64,...")`(需 tauri `webview-data-url` feature);`PRINT_LOCK` 全局 `tokio::Mutex` 防并发,30s 超时兜底;打印完 `printer.close()`。**走隐藏窗口而非主 webview**:`Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 所在 JS 上下文,弹不出反馈且回不来(见维护者注意点 #12)

- **store (`stores/export.ts`)**: `exportDocument()` 调 `saveDialog` 多 filter(HTML / PDF),按扩展名 dispatch:`.html` → `buildExportHtml` + `writeTextFile`;`.pdf` → `invoke('export_pdf', { outputPath, html })`。**reentrant 守门**(`exporting.value` 期间第二次调用立刻返回);成功/失败弹原生 `message`(故 Rust 端走隐藏打印窗口保主 webview 活着);**不**改 `currentFilePath`/`lastSavedContent`/`fs:watch` —— 导出是"产出一份静态文件",与"切换到那个文件继续编辑"是不同语义(见 DECISIONS ADR-20260621-001)

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
> - `[TOC]` 回写 toMarkdown 不要用 text 节点 —— 见设计要点「TOC 目录走 Decoration.widget」

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

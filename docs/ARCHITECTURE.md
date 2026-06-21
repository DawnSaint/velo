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

具体版本见 `package.json` / `src-tauri/Cargo.toml`。

---

## 目录结构

```
velo/
├── docs/ARCHITECTURE.md
├── src/
│   ├── App.vue                    顶栏 + 大纲 + 编辑器 + 设置
│   ├── stores/                    editor 设置 / document 文件状态 / outline 折叠 / persistence IO
│   ├── styles/                    Tailwind + Sass partial
│   └── components/
│       ├── EditorOutline.vue
│       ├── EditorSettings.vue
│       ├── DraftRecoveryDialog.vue
│       └── ProseMirrorEditor/
│           ├── index.vue          壳 (CSS 变量)
│           ├── EditorInner.vue    useProseMirror() + 裸 ProseMirror EditorView
│           ├── nodes/             自定义节点 (公式/mermaid/任务列表/脚注/代码块/TOC)
│           │   ├── MathNodeViews.ts
│           │   ├── MermaidSyntax.ts + MermaidDecoration.ts
│           │   ├── TaskListNodeView.ts
│           │   ├── FootnoteNodeViews.ts
│           │   ├── TocDecoration.ts        TOC 目录 Decoration.widget (v0.4.5)
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
| mermaidDecoration | 扫 `code_block { language: 'mermaid' }` 渲染 SVG / 编辑态切换 widget (v0.4.6+,见设计要点) |
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

**源代码模式**: `documentStore.sourceMode` 控制渲染哪个编辑器实例。`true` = `SourceModeEditor.vue`（CodeMirror 6 `EditorView`，软换行 + 持久行号 + shiki 高亮，无 schema / 无 PM plugin，用户输入经 `EditorView.updateListener` → `emit('update:modelValue')` 回写 `documentStore.content`）；`false` = `ProseMirrorEditor`（WYSIWYG）。切换时两个组件通过 `v-if` 互斥挂载，`documentStore.content` 始终是唯一数据源，自动保存 / 失焦保存 / 草稿 / 外部文件监听全部透明穿透，无需额外改动。**代码块主题切换**:SourceModeEditor 自管 `watch(codeLightTheme/codeDarkTheme) → ensureTheme(light) → ensureTheme(dark) 串行 → dispatch setShikiTheme effect → shikiCmPlugin 的 ViewPlugin.update rebuild decorations`。ViewPlugin.build **不**直接读 `editorStore.codeXxxTheme`,只读 `StateField` 里的主题名镜像 —— 因为直接读会让 store mutate 立刻触发 rebuild,而此时 ensureTheme 还没 resolve → shiki 拿到未注册主题 → token.variants.light.color 静默返回 undefined → fallback 到 `:root --shiki-light` 默认 `#24292e` → **整片全黑**(原 v0.4.6 bug 症状)。镜像只在 ensureTheme 完成、effect dispatch 后才更新,等价于 "shiki 已拿到真 hex 再 rebuild",不会出现中间全黑帧。跟 App.vue 第 4.5 段 PM 路径对仗 —— 那里是 dispatch setMeta 让 PM plugin state 拿到新 highlighter/theme 后 rebuild decorations;这里是 await ensureTheme 后 dispatch CM6 state effect 让 ViewPlugin rebuild。dispatch target 不同(PM setMeta vs CM6 StateEffect)但同步语义一致。**echo 哨兵**:`updateListener` 记 `lastSelfEmitted`,外部 `watch(modelValue)` 拿到回写若等于它则跳过,避免编辑时光标被重置(对照 PM 路径的 `lastSelfEmitted` 语义)。

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
- **echo 哨兵** (`lastSelfEmitted`): EditorInner dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch 看到匹配则跳过 echo
- **mermaid 走 Decoration.widget 不走 NodeView**: atom NodeView 的 outer dom `innerHTML` 变更会被 ProseMirror DOMObserver 当外部突变 → 全量 remount + 每字符 loader 闪烁。widget 的 `WidgetViewDesc.ignoreMutation` 默认忽略非 selection 突变。**v0.4.6+**:`mermaid` 节点已废弃,```mermaid 改走 `code_block { language: 'mermaid' }`,由 MermaidDecoration 扫 code_block 渲染 widget。**默认态**:pre 隐藏 (`pre[data-mermaid-source="hidden"] { display: none }`),SVG widget `side: -1` 渲染在 pre 之前(visual: SVG 上 / pre 下)。**点击 SVG 切换态**:派发 `setMeta(toggleEditAt: pos)`,plugin state 翻转 → `Decoration.node` 写 `data-mermaid-source="visible"` 让 pre 显出来 + SVG widget 加 `is-editing` class + 自管 toolbar 显示关闭按钮。**focus/blur**:展开时 `queueMicrotask` 调 `TextSelection.near(blockEnd)` + `view.focus()` 把光标放进 pre 内部;关闭走 toggle(光标随 selection 移出/保留由 prose 接管)。**toolbar**:MermaidDecoration widget 自管(编辑/复制/删除/关闭四按钮),codeHighlight 在 lang='mermaid' 上**不**挂 toolbar(避免同 pos 同 side 多 widget 冲突)。**删除**:`tr.delete(pos, pos + node.nodeSize)` 整段删 code_block + `setMeta(toggleEditAt: -1)` 清掉 editNodePos。**坑**: plugin promise resolve 后不要 dispatch setMeta 触发 rebuild decorations,直接在 widget dom 上写 svg;否则新 Decoration 实例 `WidgetType.eq` 失败 → widget 复用失效 → 死循环
- **mermaid + codeHighlight 双 plugin 分工**(v0.4.6+):codeHighlight 负责所有 code_block 的 toolbar(含 mermaid)+ 语法高亮;mermaid 走 MermaidDecoration 自管 SVG widget + 切换/删除/关闭按钮。`mermaid` 节点删后,`imageKeymap.ts` 的 ATOM_TYPES 也同步移除(不再需要 mermaid 节点级 atom 保护);`markCommands.ts` 黑名单走 code_block 通用分支。
- **mermaid 语法高亮旁路 shiki**(v0.4.6+):诊断发现 shiki bundled mermaid grammar 是"摆设"——`codeToTokens` 输出只有按行切的纯文本 token,**全部 defaultText 默认色,无 scope/explanation**(上游 grammar 本身薄,非集成 bug)。`codeHighlight` 的 `buildDecorations` 对 `lang==='mermaid'` 走旁路分支:不调 `getTokensSync`/shiki,改调自写 `tokenizeMermaid(code)`(`mermaidTokenizer.ts`,粗粒度 6 类 keyword/direction/shape/edge/label/comment,~70 行正则)。**颜色从当前代码块主题动态提取**:`getMermaidColors(hl, light, dark)` 从 `hl.getTheme(theme).settings` 按 TextMate scope 提取代表性 hex(keyword→keyword scope,shape/label→string,edge→keyword.operator,comment→comment),写进 inline `--shiki-light:${hex};--shiki-dark:${hex}` 局部变量 —— 跟 shiki token **完全同形**,SCSS `color: var(--shiki-light)` 接管选色。**两条主题路径自动生效**:代码块主题切换(App.vue watch → dispatch setMeta → rebuild → 新 hex)、dark/light 切换(纯 CSS cascade 零重渲)。hl 未 ready 时 colors 为 null,本次走默认色,ready 后 rebuild 钩子触发重新着色(跟 shiki 懒加载 lang 同范式)。
- **mermaid 主题切换**: widget 工厂直接挂 `velo:theme-change` window listener 自己改 dom;`spec.destroy` 钩子 removeEventListener 防泄漏。不走 plugin setMeta (同上死循环)
- **shiki dual-theme 代码高亮**: `codeToTokensWithThemes(code, { themes: { light, dark } })` 返回 token 级双色。每个 token span inline style 拼局部 CSS 变量 `--shiki-light`/`--shiki-dark`,SCSS 按 `html.dark` 选变量。**darkMode toggle 纯 CSS 切色**(零重渲,不要订阅事件 rebuild);**用户换主题**才 rebuild decoration(hex 变了,App.vue watch 触发)。**首屏零闪烁**: App.vue `setup` 用 `codeBlockReady` 守门 PM mount(等 shiki 主题加载完);PM mount 时 plugin `state.init` 同步拿 cached highlighter
- **shiki 预扫 + 懒加载 lang**:`createHighlighter` 启动时只装 doc 实际用到的 lang(由 App.vue 调 `extractLangsFromDoc` 走 mdast 扫 `code` 节点的 lang 字段),`∪ BASELINE_LANGS`(5 项兜底:js/ts/py/bash/json)→ 5-8 项代替 30 项全表,首屏 grammar 加载从 ~6MB 降到 ~1-1.6MB。**运行时兜底**:`getTokensSync` 用 `hl.getLoadedLanguages()` 探活(不能用 `hl.getLanguage()`,后者 miss 时 throw ShikiError);未装 → `bundledLanguages` gate 拦(未注册 lang 直接 return null,不 warn),否则 `void ensureLanguage(lang)` 异步追加,resolve 后 plugin `view` factory 注册的 `setDecorationRebuildCallback` 走 rAF 节流后 dispatch setMeta 触发 rebuild。**坑**: `getTokensSync` 是 sync 接口,异步加载要 fire-and-forget(不能 await),所以**首次 miss 那一帧的 decoration 是无 token 的**;rebuild 触发后下一帧才出 token,这是有意为之的"先骨架后着色",不是 bug
- **语法实时转换走 appendTransaction + dirty-range**(不走 InputRule 末尾匹配): `syntaxAutoFormat.ts` 从 `tr.mapping.maps` 提取 dirty range → 对包含的 textblock 跑 block 段首检测 + inline 正则扫描。黑名单(code_block/html_block/math_block;mermaid v0.4.6+ 走 code_block 自动覆盖)、code mark、link session 框架统一过滤。新增语法 = 写一个文件 + `syntax/index.ts` 注册一行。**坑**: block detector pattern 带 `^` 不带 `g`;inline 反过来带 `g` 不带 `^/$`;inline 扫描前把段内 atom 用 NBSP 占位防穿透;语法 apply 直接修改框架传入的 `tr`,不要自己 dispatch
- **NodeView 隔离**: `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror
- **粘贴 text/plain 必须注册 `clipboardTextParser`**:ProseMirror 默认 plain-text fallback(`prosemirror-view/dist/index.js:2836-2844`)把整段文本按 `\n+` 拆成多个 `<p>`,再 `normalizeSiblings(:2881, :2901-2930)` 自动找 wrapper(常用 `blockquote`)把这些 `<p>` 包起来,产出 `Fragment([blockquote(p1, p2)])`。Paste 进 paragraph 内时 `Fitter.dropNode(:1402)` 把内容 mix 进原 paragraph,后续 syntaxAutoFormatPlugin 在错位 doc 上跑 heading + strong,字符被搅乱。**注册 `clipboardTextParser` 走 fromMarkdown 直接解析**(`plugins/markdownPastePlugin.ts`),输出封闭 slice `(0, 0)` 而不是 `Slice.maxOpen(...)` —— maxOpen 让两端 open,paragraph 边界 paste block 反而无法 fit;封闭 slice 走 ProseMirror 标准 "join 前后 paragraph" 路径把 blocks merge 进 doc 顶层
- **样式分层**: ProseMirror 基础排版内联 `<style>`,公式/Mermaid/脚注/TOC 走 SCSS partial
- **TOC 目录走 Decoration.widget 不走 NodeView**: 跟 mermaid 同范式——`toc` 节点 atom + defining,toDOM 输出空 div 占位。`TocDecoration.ts` 的 widget 扫描 doc headings 构建嵌套树,渲染为 `<ul>/<li>` 列表 + Back to top 链接。widget key = `toc-widget:${pos}:${headingsHash}`,headings 变化时 hash 变 → ProseMirror 自动重建 widget。**坑**: `[TOC]` 回写 toMarkdown 时必须用 mdast `html` 节点(不是 text 节点)包裹——text 节点里的 `[` 在 start-of-inline 位置会被 remark-stringify escape 成 `\[`
- **源代码模式**: `SourceModeEditor` 是独立的 CodeMirror 6 `EditorView` 组件,与 `ProseMirrorEditor` 通过 `v-if` 互斥挂载。`documentStore.sourceMode` 是唯一开关,`toggleSourceMode()` 翻转。extensions:`lineNumbers()`(持久行号,无开关) + `EditorView.lineWrapping`(软换行) + `drawSelection` + `highlightSpecialChars` + `history` + 自定义 keymap(Tab 插 2 空格,覆盖 `indentWithTab`;Escape → `toggleSourceMode`) + `forbidFileDropPaste`(`EditorView.domEventHandlers`) + shiki 高亮 ViewPlugin(`shikiCmPlugin.ts`) + `updateListener`(docChanged → emit)。**`forbidFileDropPaste`(v0.4.6+,对齐 Typora 源码模式)**:源码模式禁止拖入 / 粘贴图片 —— 文件型 drop 一律 `preventDefault`(否则 webview `dragDropEnabled:false` 下拿到原生 drag,无 preventDefault 会把文件当"打开"导航掉整页跳走;PM 模式由 `imageUploadPlugin.handleDOMEvents.drop` 兜这个 preventDefault,源码模式无等价 PM 插件,这里补),image/* paste 吞掉(CM6 默认不处理 File,但浏览器可能把图片当 `<img data:..>` 塞垃圾文本);非图片纯文本 drop/paste 返回 false 放行给 CM6 默认。外部 `watch(modelValue)` 同步时,用 `lastSelfEmitted` echo 哨兵跳过自身回写,避免抢光标;真外部变化时 dispatch changes 替换 doc 并夹住光标到末尾。`documentStore.content` 始终是唯一数据源。**shiki 高亮走 CM6 ViewPlugin**(`shikiCmPlugin.ts`):每次 doc change / 收到 `setShikiTheme` effect 跑 `getTokensSync(hl, doc.toString(), 'markdown', light, dark)`,逐 token 转 `Decoration.mark({ attributes: { style: '--shiki-light:..;--shiki-dark:..' } })`。**token.offset 即 CM6 doc pos**(shiki offset 是相对输入串的全局偏移,CM6 单文档 pos 也等于字符串偏移,两者同构,同 `CodeHighlightWidget.ts:507` 性质)。SCSS `.velo-cm-source .cm-line span { color: var(--shiki-light) }` 让 token span 在自身解析局部变量(同 WYSIWYG `pre span` 机制)。**dark/light 切换纯 CSS**(零重渲,`<html class="dark">` 翻 `--shiki-light/dark` cascade);**切主题**才 rebuild(effect dispatch,新 hex 不同)。主题名镜像在 `StateField` 里,build 只读镜像不读 store(防 ensureTheme 未 resolve 期间全黑,机制等价于 v0.4.6 旧版的本地 ref 镜像,dispatch target 从 Vue ref 改 CM6 StateEffect)。
- **跨模式光标 + 浏览状态同步**: `toggleSourceMode()` 翻转 `sourceMode` → `v-if` 互换两个编辑器,两边卸载重挂,光标/滚动在 DOM 层丢失。App.vue 单点 `watch(sourceMode, cb, { flush: 'pre' })` 覆盖全部切换入口(Ctrl+\` / 工具栏 / Esc 都走这一个布尔翻转,无需改调用点)。`flush:'pre'` 保证读到**出**方向 view(卸载在 render 阶段,晚于 pre-flush watcher)→ 抓文本锚点;`await nextTick()` 后**入**方向 `onMounted` 已建 view → 应用。锚点机制见 `crossModeSync.ts`:两边各 token 化(剥 markdown 标记字符 `#*~_\`-+[]()!>|`——**`|` 入集是关键**,否则无空格表格 `|cell|cell` 粘成一个 token;标记与空白都作分隔,`**bold**`→`bold`、`well-known`→`well`+`known`,两边对称即可)。`captureAnchor` 取光标所在 token ±64 个 token 的文本序列 + 光标 token 索引 + token 内字符偏移;`applyAnchor` 在入方向全 token 上跑 **LCS 最长公共子序列**对齐,光标 token 映到对端对应 token,迁移 intraOffset,设选区 + 滚动居中。**LCS 而非整窗 indexOf**:链接 `[text](url)` 的 URL、表格 `|` / `|---|---|` 分隔行是 CM6 侧多出、PM 侧没有的 token,会卡在光标窗口中间——整窗子串匹配砍不掉 → 失败跳顶;LCS 把多余 token 当"未对齐"自动跳过。光标 token 自身是多余方(如光标落在 URL 里)→ 退到最近对齐邻居 token 的边界。**最佳努力**:空文档 / view 未就绪 → 静默放弃留默认;LCS 矩阵超 4M 格(token > ~31k 的大文档)→ 退线性首现匹配。滚动:CM6 `EditorView.scrollIntoView(pos,{y:'center'})`;PM **不用** `tr.scrollIntoView()`(默认"最小滚入视口",光标在视口下方只露底边 = 表现成跳到最底下),改手动 `coordsAtPos` + 祖先 `scrollBy` 居中(同 `FindReplace.scrollMatchIntoView` 范式),两边都把光标拉到容器中线。入方向主动 focus(PM 手动滚动依赖 view 已布局)。
- **查找替换双后端 (PM / CM6 共用,v0.4.6)**: `FindReplace.vue` 经 `FindReplaceBackend` 抽象(`findreplace/backend.ts`)驱动,**不直接依赖任一编辑器 API**。`createPmBackend(view)` / `createCmBackend(view)` 两份实现,接口收敛:`getSelectionText` / `getRangeText` / `findMatches` / `setSelection` / `scrollMatchIntoView` / `setHighlight` / `clearHighlight` / `replaceRange` / `focus`。两份 `FindReplace.vue` 分别挂在 `ProseMirrorEditor/index.vue`(PM 后端)与 `SourceModeEditor.vue`(CM6 后端),`v-if/v-else` 互斥同一时刻只有一份活着。**用户意图(query / 选项 / 替换文 / showReplace)上提到 App.vue 经 `provide(findIntentKey)` → FindReplace `inject` 共享**(`findreplace/findIntent.ts`):切模式时 PM 份卸载、CM6 份新挂,意图在 App.vue 存活 → **query 跨模式保留**;`matches` / `currentIndex` 不上提(模式相关,新挂载时用当前后端 `recomputeMatches` 重算)。`findOpen` 仍走 prop/emit(v-model:find-open),`openFind`/`openReplace` 在置 `findOpen=true` 前写好意图(从活跃编辑器选区取初始 query);关闭 → reopen 由 `openFind` 重置意图(干净打开语义)。FindReplace 无 provide 时回退本地 ref(独立挂载/测试自洽)。**两后端语义差异(各自符合该模式用户所见文本)**:`findMatches` PM 走 `findMatchesInDoc`(遍历文本节点搜 prose 文本,不含 markdown 标记,match 不跨块)、CM6 在原始 markdown 全串上跑 `buildPattern`(含 `**`/`|`/`[]()`,match 可跨行);`highlight` PM 走 `findHighlightKey` setMeta(ProseMirror 插件)、CM6 走 `cmFindHighlightField` StateField + `cmFindHighlightEffect`(镜像 PM 侧,`Decoration.mark({class}).range`);`scrollMatchIntoView` PM 手动 `coordsAtPos`+祖先 `scrollBy`(焦点在 find 输入里时 `tr.scrollIntoView` 走 `view.scrollIntoView` 早退只滚当前 selection,必须手动)、CM6 用 `EditorView.scrollIntoView(pos,{y:'center'})` effect(不依赖焦点,直接生效);`replaceRange` PM `tr.replaceWith(..,schema.text)` / CM6 `dispatch({changes:{from,to,insert}})`。**`replaceAll` 编辑器无关化**:倒序遍历 `matches`,每个 match 取 `getRangeText` → `replaceInText`(全局正则在 match 子串上重跑,等价于旧 PM per-text-node)→ `replaceRange`;逆序避免位置错位,PM(不跨节点)/CM6(可跨行)统一成立。高亮 CSS `.velo-find-match`/`.velo-find-current` 提到 `_editor-base.scss` 全局层(两套编辑器共用)。

---

## 维护者注意点

1. **路径别名**: `@/` → `src/`
2. **fs.watch 生命周期 race**: `startWatchOf`/`stopWatch` fire-and-forget,理论可泄漏;`checkExternalChange` 早退故无实际影响
4. **Tauri 权限**: `capabilities/default.json` fs 开 `**`(通用文本编辑器),分发时收紧
5. **脚注 label 是显示文本,无自动编号**: 扩展点是在 `FootnoteNumberPlugin.state` 加 `numbering: Map<label, number>`,**不要**把编号写回 `attrs.label`(丢语义,跟 GFM 不符)
6. **shiki darkMode vs 切主题两条路径正交**: darkMode toggle 纯 CSS 切色(零重渲);切主题(换 one-light→dracula)hex 变了必须 rebuild,由 App.vue watch 触发。两条路径不要混,尤其 darkMode 切换时不要 dispatch setMeta
6.5. **shiki 懒加载 lang vs 预装主题走两条独立路径**: `ensureLanguage` 只 append 语法的 grammar,**不重建 highlighter**;`ensureTheme` 同理只 append 主题 hex。两条路径互不干扰,plugin 端共用一个 `setDecorationRebuildCallback` 钩子,rebuild 时 setMeta 一次性把高亮器 / lightTheme / darkTheme 全 dispatch 过去。**不要在 lazy lang 路径里 await `getHighlighter` 后立刻 dispatch setMeta**,要走 callback 钩子让 plugin 端自己决定 rebuild 时机
7. **clipboard 统一走** `@tauri-apps/plugin-clipboard-manager` 的 `writeText`
8. **code toolbar widget 用真盒子,不能 `display: contents`**: widget `display: block; height: 22px`,`side: -1` 渲染在 `<pre>` 之前,用 `:has(+ pre:hover)` 联动 hover
9. **dev web 端 Tauri API 必须 `isTauri()` 守门**: 纯 vite 调 `@tauri-apps/api/*` 同步 throw。`persistence.ts` 走 `tauriOnly()`;`App.vue` 顶层 `const tauri = isTauri()`,fire-and-forget 异步用 `if (tauri)` 守门,onMounted await 链路整段 `if (tauri) { ... }` 包裹(单行 throw 让 async 整条 reject)
10. **快捷键 declarative registry**(v0.4.4+):所有键位在 `editor/shortcuts/bindings.ts` 集中注册,**不**在 EditorInner.vue 里硬编码。新加快捷键 = 新建 command 文件 + 在 `bindings.ts` 加 1 行 `registerShortcut(...)`,不需要碰 EditorInner 或 registry.ts。
11. **inline syntax regex 边界规约**(v0.4.4+):新加 inline syntax 时 regex **必须自带 word boundary**,不依赖 registry 顺序防误识别。规约:
    - 开口边界 `(?<!\W)` / `(?<!\*)` / `(?<![\w:/])` 等(挡前导 word / 特定分隔符)
    - 闭口边界 `(?!\W)` / `(?!\*)` / `(?![\w|/])` 等
    - inner 不含分隔符(如 strong inner `[^\n*]+?`,不允许 inner 跨过 `**`)
    - 例:`**33**` 必须被 strong 吃掉、`text==hi==` 不应被 highlight 误识别 —— 见 `syntax/inline/strong.ts` / `highlight.ts` 顶部的注释
12. **highlight mark 的 markdown round-trip**(v0.4.4+):`==xxx==` 不在 GFM 范围。`fromMarkdown` 走 `plugins/remarkHighlight.ts`(state machine + in-text regex + word boundary);`toMarkdown` 在 `pmInlineToMdast` 抽 highlight run,用 **mdast html 节点**(不是 text 节点)作 `==` 边界 —— text 节点在 start-of-inline 位置会被 remark-stringify escape 成 `\==`。

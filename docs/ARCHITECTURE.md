# Velo



## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 (`<script setup>`) |
| 状态管理 | Pinia |
| 语言 | TypeScript |
| 构建 | Vite |
| 桌面壳 | Tauri 2.0 |
| 编辑器 | ProseMirror |
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
│           │   └── TextareaEditor.ts  多行 textarea 编辑壳
│           ├── findreplace/       查找替换 (浮层UI + 高亮plugin + 匹配函数)
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
- **mermaid + codeHighlight 双 plugin 分工**(v0.4.6+):codeHighlight 只负责非 mermaid 的普通 fenced code 高亮 + toolbar;mermaid 走 MermaidDecoration 自管 toolbar + SVG。`mermaid` 节点删后,`imageKeymap.ts` 的 ATOM_TYPES 也同步移除(不再需要 mermaid 节点级 atom 保护);`markCommands.ts` 黑名单走 code_block 通用分支。
- **mermaid 主题切换**: widget 工厂直接挂 `velo:theme-change` window listener 自己改 dom;`spec.destroy` 钩子 removeEventListener 防泄漏。不走 plugin setMeta (同上死循环)
- **shiki dual-theme 代码高亮**: `codeToTokensWithThemes(code, { themes: { light, dark } })` 返回 token 级双色。每个 token span inline style 拼局部 CSS 变量 `--shiki-light`/`--shiki-dark`,SCSS 按 `html.dark` 选变量。**darkMode toggle 纯 CSS 切色**(零重渲,不要订阅事件 rebuild);**用户换主题**才 rebuild decoration(hex 变了,App.vue watch 触发)。**首屏零闪烁**: App.vue `setup` 用 `codeBlockReady` 守门 PM mount(等 shiki 主题加载完);PM mount 时 plugin `state.init` 同步拿 cached highlighter
- **shiki 预扫 + 懒加载 lang**:`createHighlighter` 启动时只装 doc 实际用到的 lang(由 App.vue 调 `extractLangsFromDoc` 走 mdast 扫 `code` 节点的 lang 字段),`∪ BASELINE_LANGS`(5 项兜底:js/ts/py/bash/json)→ 5-8 项代替 30 项全表,首屏 grammar 加载从 ~6MB 降到 ~1-1.6MB。**运行时兜底**:`getTokensSync` 用 `hl.getLoadedLanguages()` 探活(不能用 `hl.getLanguage()`,后者 miss 时 throw ShikiError);未装 → `bundledLanguages` gate 拦(未注册 lang 直接 return null,不 warn),否则 `void ensureLanguage(lang)` 异步追加,resolve 后 plugin `view` factory 注册的 `setDecorationRebuildCallback` 走 rAF 节流后 dispatch setMeta 触发 rebuild。**坑**: `getTokensSync` 是 sync 接口,异步加载要 fire-and-forget(不能 await),所以**首次 miss 那一帧的 decoration 是无 token 的**;rebuild 触发后下一帧才出 token,这是有意为之的"先骨架后着色",不是 bug
- **语法实时转换走 appendTransaction + dirty-range**(不走 InputRule 末尾匹配): `syntaxAutoFormat.ts` 从 `tr.mapping.maps` 提取 dirty range → 对包含的 textblock 跑 block 段首检测 + inline 正则扫描。黑名单(code_block/html_block/math_block;mermaid v0.4.6+ 走 code_block 自动覆盖)、code mark、link session 框架统一过滤。新增语法 = 写一个文件 + `syntax/index.ts` 注册一行。**坑**: block detector pattern 带 `^` 不带 `g`;inline 反过来带 `g` 不带 `^/$`;inline 扫描前把段内 atom 用 NBSP 占位防穿透;语法 apply 直接修改框架传入的 `tr`,不要自己 dispatch
- **NodeView 隔离**: `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror
- **粘贴 text/plain 必须注册 `clipboardTextParser`**:ProseMirror 默认 plain-text fallback(`prosemirror-view/dist/index.js:2836-2844`)把整段文本按 `\n+` 拆成多个 `<p>`,再 `normalizeSiblings(:2881, :2901-2930)` 自动找 wrapper(常用 `blockquote`)把这些 `<p>` 包起来,产出 `Fragment([blockquote(p1, p2)])`。Paste 进 paragraph 内时 `Fitter.dropNode(:1402)` 把内容 mix 进原 paragraph,后续 syntaxAutoFormatPlugin 在错位 doc 上跑 heading + strong,字符被搅乱。**注册 `clipboardTextParser` 走 fromMarkdown 直接解析**(`plugins/markdownPastePlugin.ts`),输出封闭 slice `(0, 0)` 而不是 `Slice.maxOpen(...)` —— maxOpen 让两端 open,paragraph 边界 paste block 反而无法 fit;封闭 slice 走 ProseMirror 标准 "join 前后 paragraph" 路径把 blocks merge 进 doc 顶层
- **样式分层**: ProseMirror 基础排版内联 `<style>`,公式/Mermaid/脚注/TOC 走 SCSS partial
- **TOC 目录走 Decoration.widget 不走 NodeView**: 跟 mermaid 同范式——`toc` 节点 atom + defining,toDOM 输出空 div 占位。`TocDecoration.ts` 的 widget 扫描 doc headings 构建嵌套树,渲染为 `<ul>/<li>` 列表 + Back to top 链接。widget key = `toc-widget:${pos}:${headingsHash}`,headings 变化时 hash 变 → ProseMirror 自动重建 widget。**坑**: `[TOC]` 回写 toMarkdown 时必须用 mdast `html` 节点(不是 text 节点)包裹——text 节点里的 `[` 在 start-of-inline 位置会被 remark-stringify escape 成 `\[`

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

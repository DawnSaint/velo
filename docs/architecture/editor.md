# Editor Architecture

> **本文件负责**：ProseMirror / CodeMirror 6 编辑器栈、markdownIO 双向转换、语法实时转换、NodeView / Decoration、shiki 代码高亮、源码模式与跨模式同步。
>
> **何时阅读**：改 schema、markdownIO、插件链、NodeView / Decoration、代码高亮、源码模式、快捷键，或新增 markdown 语法时。
>
> **代码入口**：`src/components/ProseMirrorEditor/` — `EditorInner.vue`（装配与 keymap）、`editor/`（schema / markdownIO / blockSerializer / shortcuts / session 辅助）、`plugins/`、`nodes/`、`syntax/`、`findreplace/`、`image/`、`composables/`；源码模式 `src/components/SourceModeEditor.vue`；跨模式同步 `src/components/crossModeSync.ts` + `src/composables/useCrossModeSync.ts`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [查找替换](./find-replace.md) · [导出](./export.md) · [样式](./styles.md)

## 红线

- **插件顺序以 `plugins/order.ts` 为唯一真相**：`CANONICAL_PLUGIN_ORDER` 定义顺序，`resolvePlugins` 校验集合并按序排列。新增 / 删除 / 重命名插件必须同步该列表，否则抛错。`EditorInner.vue` 的 `pluginEntries` 物理顺序无关。
- **`foldDecoration` 必须前置**：折叠状态是 module-level mutable set，在 apply 阶段刷新；读它的装饰插件（`codeHighlight` / `codeLineNumber` / `mermaidDecoration` / `tocDecoration`）必须排在其后。
- **装饰选型**：mermaid / TOC 走 `Decoration.widget`，不要做 NodeView；不要 dispatch setMeta 触发 mermaid / shiki 重建。
- **shiki 探活**用 `getLoadedLanguages()`，不要用 `getLanguage()`（miss 时 throw）；不要清理 `getTokensCached` 的 LRU。
- **脚注编号不写回 label**：编号放插件 state，改 `attrs.label` / label 文本会丢语义且不符 GFM。
- **快捷键只在 `editor/shortcuts/bindings.ts` 注册**，不在 `EditorInner.vue` 硬编码。
- **`[TOC]` 回写**用 mdast `html` 节点，不用 text 节点。
- **`char_ref` 源码态**的实体字面量不是真实内容：进入 / 还原事务挂 `SKIP_CONTENT_EMIT`，算 matches 前先 flush session。
- **echo 哨兵**：不要在 self-emit 判定前 `cancelPendingEmit()`；切标签先 flush 再切（见 [document-io](./document-io.md)）。
- **markdownIO 双向改动必须补 / 跑 round-trip 测试**。

## 架构

### 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 装配 | `EditorInner.vue` | 建 `pluginEntries` → `resolvePlugins` → `allPlugins`；`composables/useProseMirror.ts` 是唯一状态变更入口 |
| schema | `editor/schema.ts` | 节点 / mark / attrs；自定义节点的 `parseDOM` / `toDOM` 多为占位，真渲染走 NodeView / Decoration |
| 双向转换 | `editor/markdownIO.ts` + `editor/parseProcessor.ts` | unified 管线 md ↔ PM doc |
| 增量序列化 | `editor/blockSerializer.ts` | 编辑回写的快路径 |
| 语法实时转换 | `syntax/` + `plugins/syntaxAutoFormat.ts` | 键入即转语法 |
| 源码编辑 | `plugins/*SourceEdit*.ts` + `editor/sourceEditSession.ts` | 六个 session 共享范式 |
| 视图 | `nodes/` | NodeView、Decoration、widget |
| 模式 | `src/components/SourceModeEditor.vue` | CM6 源码模式 |

### 插件顺序

`CANONICAL_PLUGIN_ORDER` 分段（id 与 `EditorInner.vue` 注册 id 一致）：

| 段 | 插件 |
| --- | --- |
| Suggest | `codeBlockLangSuggest`、`emojiSuggest` |
| Keymap | `keymap.backspaceDeleteSelectAll`、`keymap.undoRedo`、`keymap.enter`、`keymap.base`、`tabIndent`、`dollarEnterToMathBlock`、`imageKeymap` |
| Cursor & History | `dropCursor`、`gapCursor`、`history` |
| Table | `tableColumnResizing`、`tableCellInputGuard`、`tableEditing`、`tableResizeCursor`、`tableInsertHandle`、`tableContextMenu` |
| Paste & Upload | `imageUpload`、`markdownPaste` |
| Link & Image Edit | `linkClick`、`linkEditEscape`、`imageEdit`、`imageEditEscape` |
| Source Edit | `markSourceEdit`、`markSourceEditEscape`、`htmlSourceEdit`、`htmlSourceEditEscape`、`emojiSourceEdit`、`emojiSourceEditEscape`、`charRefSourceEdit` |
| Syntax & Input | `syntaxAutoFormat` |
| Viewport | `viewport` |
| Code Decorations | `foldDecoration`、`codeHighlight`、`codeWrap`、`codeLineNumber` |
| NodeView | `imageInlineView`、`hrNodeView`、`emojiNodeView`、`frontmatterNodeView`、`htmlNodeView` |
| Math & Mermaid | `mathEdit`、`mermaidDecoration` |
| Misc Decorations | `taskList`、`footnoteEdit`、`tocDecoration`、`findHighlight` |
| Mode | `customCaret`、`focusMode`、`typewriterMode` |
| CJK | `cjkLetterSpacing`、`cjkAutoFormat`、`autoPair` |
| Tail | `inputRules`、`shortcutKeymap` |

段内有硬依赖：`tableColumnResizing` / `tableCellInputGuard` 在 `tableEditing` 之前；Source Edit 段在 `syntaxAutoFormat` 之前；`viewport` 在所有读视口的装饰插件之前。

### 解析管线

`createParseProcessor()`（`editor/parseProcessor.ts`）是主线程与 Worker 共用的 parse 配置：

```
remarkParse → preserveEmptyLine → encodeLinkUrls → remarkSupSub
→ remarkGfm(singleTilde:false) → strictMath → alert → highlight
→ underline → cjkEmphasis → emoji → frontmatter(['yaml','toml'])
```

`preprocessSource(md)`（同文件）先跑两个改写源文本的 wrapper（URL 空格 → `%20`、多空行 → `<br />`）。**mdast 的 `position.offset` 相对改写后的字符串**，凡用 offset 回查源文本的地方都要喂这份字符串。

大文档 parse 走 Worker：`markdownWorker.ts` 只做 `processor.parse` + `runSync`，主线程拿 mdast 后执行 `annotateMathDelimiterCount` / `mdastBlockToPM`；Worker 不可用或超时降级同步 `fromMarkdown`。

### Enter / Backspace 链

定义在 `EditorInner.vue`，链内顺序即优先级，**改前先读该文件上方的逐条注释**（含每个命令的插入理由与"必须排在 X 之前"）：

- Enter：`foldEnter → codeBlockEnter → mathBlockEnter → cmdTableCellEnter → dollarEnterCmd → codeBlockEnterCommand → frontmatterEnterCommand → hrEnterCommand → splitListItem → splitInListItemNestedBlock → liftListItem → liftEmptyBlock → splitBlock`
- Shift-Enter：`codeBlockExit → cmdTableCellHardBreak → shiftEnterExitBlock → shiftEnterListItem → splitBlock`
- Backspace：`foldDelete → frontmatterBackspace → codeBlockBackspace → headingToParagraph → emptyParaBeforeListBackspace → baseKeymap`

### 源码编辑 session 六件套

`imageEdit` / `linkClick` / `markSourceEdit` / `htmlSourceEdit` / `emojiSourceEdit` / `charRefSourceEdit` 共享同一状态机：进入 = 把渲染节点临时替换成源码纯文本；用户键入 = 普通事务（state 随位置平移）；移出 / Escape = commit 或还原。共用辅助在 `editor/sourceEditSession.ts`（`getSourceEditRanges` 供 `toMarkdown` 用占位符绕开转义）；瞬时视图切换事务挂 `editor/transactionMeta.ts` 的 `SKIP_CONTENT_EMIT`。

## 关键取舍

### 序列化与解析

- **块级增量序列化是快路径，不是第二套序列化器**：`blockSerializer.ts` 用 PM 结构共享判净（transaction 后 `newDoc.child(i)` 与缓存引用相等即净块），只重序列化脏块再 `\n\n` 拼回，字节级等于全量 `toMarkdown`（测试守护）。文档级后处理复用 `markdownIO.finalizeMarkdown`。
- **空文档 canonical 必须是 `''`**：尾部空行补偿会命中"整篇只有 schema 强制占位 paragraph"的空文档，产出 `'\n\n\n'` —— 源码模式渲染成 4 行、WYSIWYG 只有 1 行。补偿前判 `k === doc.childCount` 直接返回 `''`；`documentStore` 只认 `''` 为空文档基线。
- **行内 mark 按「连续共享外层 mark」建容器树**：`pmInlineToMdast` → `processSpans` → `buildMarkTree`，分隔符只在整段两端各出现一次；underline / highlight / sup / sub 无 GFM 原生容器，用 html 边界节点输出。
- **marker 保真**：自定义 strong / emphasis handler 读 `mark.attrs.marker`；`buildMarkSource` 自己按 marker 拼源码（`toMarkdown` 恒输出 `_` / `**`，会丢原始分隔符）。
- **字符实体靠 `char_ref` mark 保真**：`remark-parse` 把 `&#x20;` / `&nbsp;` 解码进 mdast，实体字面量不进 PM doc —— 这就是"搜得到、定位不到"的根因。`editor/charRef.ts` 在 parse 阶段用 mdast position 回查，把"哪几个解码字符来自哪个实体"记进 mark 的 `segments`；`toMarkdown` 原样写回，查找后端在解码字符上搜字面量。
- **strictMath 替代 remark-math**：remark-math 撞 EOF 即判定围栏闭合、内容含空行合法，未闭合 `$$` 会贪婪吞掉中间内容。自写 `plugins/strictMath/` 要求块级围栏独占一行闭合，token 类型复用 `mdast-util-math`，序列化剔除 `$` 的 unsafe 转义。
- **CJK 标点**：CommonMark 把 CJK 标点当 Unicode punctuation，`**数据排序：**正文` 的闭合 `**` 不满足 right-flanking。`remarkCjkEmphasis` + 自定义 strong handler 修正。
- **上下标走 Obsidian / Pandoc 风格**：`^x^` / `~x~`，单 `~` 作下标；`remarkGfm` 配 `singleTilde:false`，让单 `~` 在 parse 阶段保持文本交给 `remarkSupSub`，双 `~~` 仍走 gfm 删除线。

### 插件与事务

- **语法实时转换走 `appendTransaction` + dirty-range**（`plugins/syntaxAutoFormat.ts`），不走 InputRule 末尾匹配：从 `tr.mapping.maps` 提 dirty range，只扫被波及的 textblock；黑名单容器（code_block / html_block / math_block）整段不钻；与源码 session 重叠的范围退避。新增语法 = 写一个 `syntax/{block,inline}/*.ts` + `syntax/index.ts` 注册一行。
- **mark session 触发用 appendTransaction 而非 handleClick**：仅 batch 含 `selectionChanged && !docChanged` 的 tr 才进，键入 tr 不触发，保住 Ctrl+B 连续输入。commit 不调 `setSelection`，靠 `tr.mapping` 把光标重映射到还原 mark 之外（否则会立即重进 session）。
- **`toMarkdown` 转义污染**：session 活跃期间 `toMarkdown` 会把源码里的 `![` / `[` / `(` / `<` 转义，与渲染态序列化不同 → 误判 dirty。`getSourceEditRanges` 在 onChange 用占位符绕开；`SKIP_CONTENT_EMIT` 只用于瞬时视图切换事务，commit / Escape 必须回写。
- **折叠是纯视觉、不改 doc**：折叠点（contentStart）写入 plugin state 的 `Set<number>`，`tr.mapping.map(pos, -1)` 跟住 doc 变化；区段挂 `velo-folded` → `display:none`，round-trip 不受污染。持久化走 stable key（`makeStableKey`），恢复用 `initCollapsedKeys` meta。
- **多 session 并存必须全退避**：`getActiveEditRanges` 返回所有活跃 session 范围，`tryInlineSyntaxes` 用 `rangesIntersect` 任一相交即跳过；表格整表 `replaceWith` 会把 session 区间压翻，是必须一并守住的防线。

### 渲染层

- **NodeView vs Decoration 判据**：atom NodeView 内改 `innerHTML` 会被 PM DOMObserver 当外部突变 → 全量 remount + 闪烁。mermaid / TOC 走 `Decoration.widget`（`ignoreMutation` 默认忽略非 selection 突变）。
- **需逐字符编辑的 inline 节点不要做 atom + contentEditable**：PM 的 `view.dom` 是唯一 contentEditable，嵌套子元素拿不到独立 focus，Backspace 按外层 selection 处理 → 删错位置。`math_inline` / `footnote_reference` / `footnote_label` 用 `content:'text*'` + `contentDOM`，让 PM 接管文本。
- **math_inline 走 Obsidian Live Preview 双模**：`atom:false` + contentDOM；selectionchange 判 `display`（光标在节点外，仅渲染层可见）/ `edit`（源码与 `$` 可见，`update()` 实时重渲染 katex）。source 由 PM 经 `tr.insertText` 直接维护；空节点走占位不调 katex。
- **块级 HTML 源码切换走 `code_block` 替换**：HTML 源码常含换行，纯文本在 paragraph 里会被 Enter 拆段；`code_block{code:true}` 保留换行。行内 HTML 走"替换成纯文本"（同 imageEdit 范式）。
- **atom 节点选中态共用 `nodes/selectionSync.ts`**：三通道判断（DOM 选区纵向重叠、PM state 重叠、鼠标触碰）；拖蓝期间只用 DOM selection（PM 的 DOM 同步是异步 rAF），松开时扩展 PM 选区把节点纳入，否则删除只删文字不删节点。
- **图片段落尾随空行**：image 是 inline atom 但 `display:block`，作为段落末子时 PM 补 `<br class="ProseMirror-trailingBreak">` 撑出空行，用 scoped 兄弟选择器隐藏（`_editor-image.scss`）。
- **HTML img 两级分流**：独立 `<img>` → `image({htmlSource:true, htmlAttrs})`；嵌套 `<img>` → `html_block` 渲染层代理（`nodes/HtmlNodeView.ts` 用 DOMPurify sanitize 后 innerHTML）。
- **`math_block` 同样去 atom**：改 `content:'text*'` + contentDOM，`renderKatex` 只写 display 层（`contenteditable=false`），await 后判 `isConnected` 再写入。

### 代码块与 shiki

- **dual-theme 走 CSS 翻面**：`codeToTokensWithThemes` 出 token 级 `--shiki-light/dark` 局部变量，`html.dark` 选色，**零重渲**。只有换主题（hex 变）才 rebuild。pre 背景写死，与主题色解耦。
- **两条正交 rebuild 路径**：darkMode 纯 CSS；懒加载 lang 经 `setDecorationRebuildCallback` 让 plugin 自己 rAF 节流 rebuild（一次粘贴 10 个 lang 合并成一帧一次 dispatch）；换主题由 `App.vue` watch 触发。
- **`getTokensCached` 是 per-keystroke 关键路径**：`props.decorations(state)` 无脏区间钩子，每次 transaction 全量重跑；token LRU（cap 200）命中可跳过同步分词。缓存 token 而非 Decoration（token.offset 是块首相对偏移，与 doc 位置无关）。
- **预扫 + 懒加载 lang**：启动只装 doc 实际 lang ∪ 5 项 `BASELINE_LANGS`；运行时 miss 用 `getLoadedLanguages()` 探活，异步 `ensureLanguage` 追加（不重建 highlighter）。主题同理，`ensureTheme` 只追加主题。
- **mermaid 高亮旁路 shiki**：shiki 的 mermaid grammar 只出按行纯文本，改用自写 `tokenizeMermaid`（6 类），颜色从当前主题的 TextMate scope 提 hex 写进 `--shiki-light/dark`，随主题切换。
- **code header 是 `Decoration.widget(pos, side:-1)`**：整块删除后 PM 不会自动删它，靠 plugin 缓存 `decoSet` + `prev.decoSet.map(tr.mapping, tr.doc)` 增量平移。mermaid 展开态传 `hideFoldBtn`，避免与自带 toolbar 打斗。
- **wrap / 行号是 per-block 运行时视图态**：`codeWrapPlugin`（默认开启，跟踪的是"已关闭"集合）与 `codeLineNumberPlugin`（默认关闭）都用 `Set<number>` 挂 pos，不持久化、不进 schema / markdownIO。

### 性能

- **viewport 感知 + 增量 DecorationSet + 粘性**：`nodes/viewportPlugin.ts` 跟踪可见 doc pos 范围，滚动时 dispatch meta 通知下游；装饰只构建视口内 + buffer 或"已装饰过"（seenSet）的块，规避 widget 高度跳变引发的闪烁。
- **NodeView 延迟创建**：`nodes/lazyRender.ts` 用共享 IntersectionObserver 把 katex 渲染推到进视口（rootMargin 1000px），滚出销毁 DOM 并缓存 innerHTML；无 IO 环境同步立即渲染。
- **共享遍历**：`nodes/docScanCache.ts` 按 doc 对象身份缓存单次 `descendants()`，供各装饰插件共用（codeBlocks / frontmatters / headings / listItems / tocs / foldPlaceholders / footnoteReferences）。

### 表格

- **表操作一律整表 `replaceWith`**（`editor/shortcuts/commands/tableCommands.ts`）：splice 出新表再整体替换 + 光标定位补丁（用 `tmpDoc` 解析目标 cell 绝对 pos）。`to` 必须 = `tablePos + oldTableSize`（range end 是 exclusive）。
- **绕开 prosemirror-tables 的 `findTable`**：Velo 定制了 table 节点（`isolating:true`），官方 helper 按默认结构查找会失配。
- **`tableCellInputGuard` 必须在 `tableEditing` 之前**：CellSelection 下 PM 内置 keydown 的 `forceFlush()` 会把 CellSelection 覆盖成 TextSelection，守卫在 `handleDOMEvents.keydown` 阶段 preventDefault 跳过它。剪贴板键（Mod-c/v/x）不能 preventDefault，改在 forceFlush 前调 `domObserver.setCurSelection()`。
- **含表格的粘贴三种来源要分开**（`image/imageUploadPlugin.ts`）：Velo 自身复制（HTML 带 `data-pm-slice`）→ 放行给 PM 原生 round-trip；外部 markdown 文档（text/plain 有 markdown 特征）→ `fromMarkdown`；Excel / Sheets TSV → `parseTableFromHTML`。不能用"HTML 里有 `<table>`"一刀切判来源。
- **text/plain 粘贴必须注册 `clipboardTextParser`**：PM 默认 fallback 拆 `<p>` 后 `normalizeSiblings` 自动包 blockquote，再被 Fitter dropNode → 字符错位。`plugins/markdownPastePlugin.ts` 接管走 `fromMarkdown`。

### 输入、光标与模式

- **非文本位置自绘 caret**（`plugins/customCaret.ts`）：`view.coordsAtPos` 在非文本位置返回的 rect 不等于 Blink 实际 caret 高（文本位 = em-square，非文本位 = line box）。接管条件：collapsed、非 NodeSelection、非 composing、有焦点、落点 DOM 非文本节点；按 H≈F / H≈strutH / 其余三档决策。overlay 挂 `view.dom.parentNode`，不进 contentDOM 子树。
- **打字机居中 defer 到 rAF**：PM 的 `update()` 之后还会跑 `scrollToSelection` / `resetScrollPos`，同步 `scrollBy` 会被覆盖。
- **切标签滚动保留**：在 `tabSwitchToken` 的 `flush:'sync'` watch 里同步捕获旧标签 state 并 `view.updateState(cachedState)`；PM 侧滚动容器必须 `overflow-anchor: none`（`styles/index.scss`），否则浏览器 scroll-anchoring 回拉。
- **跨模式同步**（`components/crossModeSync.ts`）：切换前抓"文本锚点"，切换后用 token 序列 + LCS 对齐恢复光标与滚动，最佳努力。用 LCS 而非整窗子串：链接 URL、表格 `|`、分隔行等 token 只在一侧存在。
- **源码模式输入路径零全文高亮**（`nodes/shikiCmPlugin.ts`）：docChanged 只做 `decorations.map(u.changes)` 平移；真正 tokenize 延迟到停止输入 / 滚动停下，且只算 visibleRanges + buffer。
- **缩放走 Webview `setZoom`**（`composables/useZoom.ts`），区别于 `editorStore.fontSize`（只改正文字号）。
- **只读模式**：`view.editable=false` 只挡用户输入，不挡 `appendTransaction` / NodeView 事件 —— 各交互入口（源码编辑、展开源码按钮）需自行 `if (view.editable)` 守卫。

### diff

- **WYSIWYG diff 独立于 `EditorInner`**：`WysiwygDiffView.vue` 是只读 PM 渲染，单独挂 `plugins/diffDecorationPlugin`，不复用 `allPlugins`。
- **整框 overlay 不进 `view.dom`**（`plugins/diffGroupFrames.ts`）：左右取版心，上下取组内所有顶层 DOM rect 并集（含 widget），挂到 `.velo-diff-editor`；CSS 没有"给一组兄弟套共同边框"的原语。
- **字符级新增下划线由 overlay 画**（`plugins/diffInlineUnderlines.ts`）：一条 `Decoration.inline` 会被 PM 在 code mark 边界拆段，`text-decoration` 在 code 胶囊 padding 处留缝；overlay 按同行连续区间画 2px 空 div。
- **跨视图单一真相源**：图片 src 解析 `utils/imageSrc.ts`、加载失败占位 `editor/imageErrorPlaceholder.ts`，主编辑器与 diff 预览共用。

### 其他

- **快捷键 declarative registry**（`editor/shortcuts/registry.ts` + `bindings.ts`）：新键位 = 写一个 command 文件 + bindings 加一行，不碰 `EditorInner.vue`；跨平台一律 `Mod-`。
- **新增暗色规则两处同步**：editor 走 `_editor-dark.scss` 的 `:is(.dark .velo-editor, .velo-editor.dark)`，导出走 `lib/export/exportStyles.scss`。
- **clipboard 统一走 `utils/clipboard.ts` 的 `writeClipboardText`**（Tauri clipboard-manager，失败回退 `navigator.clipboard`）。

## 附录：新增语法 checklist

一条新语法落地需要 check 涉及哪些层，避免遗漏。checklist 不是规约，多数简单语法只碰其中 2–3 个文件。

| # | 涉及层 | 文件 | 何时需要动 |
| --- | --- | --- | --- |
| 1 | schema | `editor/schema.ts` | 新增节点类型 / mark / attrs |
| 2 | NodeView / widget | `nodes/*.ts`、`image/imageNodeView.ts` | 需要特殊视觉（数学渲染 / mermaid SVG / checkbox / 链接源编辑） |
| 3 | remark 插件 | `plugins/remark*.ts` + `editor/markdownIO.ts` 的 `.use()` | mdast 树需重写或补缺 |
| 4 | markdownIO 双向 | `editor/markdownIO.ts` | 新节点进 `fromMarkdown` / `toMarkdown`；新 mark 在 `pmInlineToMdast` 加分支 |
| 5 | syntax registry | `syntax/{block,inline}/*.ts` + `syntax/index.ts` | 用户键入也要转 |
| 6 | ProseMirror 插件 | `EditorInner.vue` 的 `pluginEntries` + `plugins/order.ts` | 新装饰 / 行为插件；新增插件须同时在 `order.ts` 加 id |
| 7 | keymap | `EditorInner.vue` | 新快捷键（如 `$$` + Enter） |
| 8 | 测试 | `__tests__/*.ts` | 每条语法至少 1 happy + 1 反例；markdownIO 改动必加 round-trip |
| 9 | RELEASE_NOTES | `docs/RELEASE_NOTES.md` | 发版时把该语法的 feat / fix 按分组写入 |
| 10 | ARCHITECTURE | 本文件（必要时联动 `docs/ARCHITECTURE.md` 路由） | 跨节点依赖 / 触发时机反直觉 / 新黑名单维度 / 非显然取舍；纯模板化不需要改 |
| 11 | DECISIONS | `docs/DECISIONS.md` | 候选方案 ≥ 2 的"为什么走 X 不走 Y"，走 ADR 格式；普通语法不进 |

容易遗漏：第 5 列注册漏了等于静默失效且无警告；第 4 列只加 `fromMarkdown` 不加 `toMarkdown` 会在保存再加载后丢数据；第 10 列别过度——简单语法也写架构说明会稀释信号。

## 附录：TS class → SCSS 映射

ProseMirror 的 NodeView / Decoration / Plugin 在 TS 中命令式创建 DOM 并设 class，对应规则在 SCSS partial 中。class 名以 TS 为准，本表用于定位样式文件。

| TS 文件 | class 前缀 | SCSS partial |
| --- | --- | --- |
| `nodes/CodeHighlightWidget.ts` | `velo-code-*`（header / fold / wrap / lang / copy） | `_editor-code.scss` |
| `nodes/CodeLineNumberWidget.ts` | `velo-code-lineno*` | `_editor-code.scss` |
| `nodes/MermaidDecoration.ts` | `mermaid-*` | `_mermaid.scss` |
| `nodes/MathNodeViews.ts` | `math-*` | `_math.scss` |
| `nodes/FootnoteNodeViews.ts` | `footnote-*` | `_footnote.scss` |
| `nodes/TaskListNodeView.ts` | `task-*` | `_editor-lists.scss` |
| `nodes/TocDecoration.ts` | `velo-toc-*` | `_editor-toc.scss` |
| `nodes/FoldDecoration.ts` | `velo-fold-*` / `velo-folded` | `_editor-fold.scss` |
| `nodes/HtmlNodeView.ts`、`plugins/htmlSourceEdit.ts` | `velo-html-*` / `html-source-toggle-btn` | `_editor-html-blocks.scss` |
| `image/imageEditPlugin.ts`、`image/imageNodeView.ts` | `velo-image-*` | `_editor-image.scss` |
| `nodes/HrNodeView.ts` | `velo-hr` | `_editor-hr.scss` |
| `nodes/EmojiNodeView.ts`、`plugins/emojiSourceEdit.ts`、`plugins/emojiSuggest.ts` | `velo-emoji*` | `_editor-emoji.scss` |
| `plugins/linkClick.ts`、`plugins/markSourceEdit.ts`、`plugins/charRefSourceEdit.ts`、`findreplace/findHighlight.ts`、`plugins/focusMode.ts` | `velo-*-source-edit` / `velo-char-ref-*` / `velo-find-*` / `velo-focus-active` | `_editor-base.scss`、`_editor-html-blocks.scss` |
| `plugins/tableInsertHandle.ts` | `velo-t-pick-handle` / `velo-t-insert-*` | `_editor-tables.scss` |
| `nodes/CodeWrapPlugin.ts` | `data-velo-wrap`（属性） | `_editor-code.scss` |

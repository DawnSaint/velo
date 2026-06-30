# Editor Architecture

> **本文件负责**: ProseMirror / CodeMirror 编辑器栈、markdownIO、语法实时转换、NodeView/Decoration、mermaid、shiki 与跨模式同步。
>
> **何时阅读**: 改 schema、markdownIO、ProseMirror 插件链、NodeView/Decoration、代码高亮、源代码模式、快捷键或新增 markdown 语法时。
>
> **先记住**:
> - `EditorInner.vue` 的 `allPlugins` 顺序是行为契约，改动需同步本文件。
> - mermaid / TOC 走 Decoration.widget，不走 NodeView；不要 dispatch setMeta 触发 mermaid widget rebuild。
> - shiki dark/light 翻面走 CSS；换主题 / 懒加载 lang 才触发受控 rebuild。
> - syntaxAutoFormat 的 apply 直接改框架传入的 `tr`，不要自己 dispatch。
> - markdownIO 双向改动必须补/跑 round-trip。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [查找替换](./find-replace.md) / [导出](./export.md)


## 禁令速查

- 不要 `dispatch setMeta` 触发 mermaid / shiki 重建；mermaid 直接写 widget DOM，shiki darkMode 纯 CSS。
- 不要用 `getLanguage()` 探活 shiki miss；用 `getLoadedLanguages()`。
- 不要把脚注编号写回 `attrs.label`。
- 快捷键不要在 `EditorInner.vue` 硬编码，走 `editor/shortcuts/bindings.ts`。
- `[TOC]` 回写 toMarkdown 不要用 text 节点。
- 不要清理 `getTokensCached` 这层 LRU。

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

**markdown 解析**走 `editor/markdownIO.ts` 的 unified pipeline (remark-parse + remark-gfm + 公式围栏守卫 + remark-math + preserveEmptyLine)。`fromMarkdown(md)` → EditorState,`toMarkdown(doc)` 回写。**键入触发**走 syntaxAutoFormat,不走 unified。

---

---

## 设计要点

- **mermaid 走 Decoration.widget 不走 NodeView**: atom NodeView 的 outer dom `innerHTML` 变更会被 ProseMirror DOMObserver 当外部突变 → 全量 remount + 每字符 loader 闪烁;widget 的 `ignoreMutation` 默认忽略非 selection 突变。当前 `mermaid` 节点已废弃,```` ```mermaid ```` 改走 `code_block { language: 'mermaid' }`,由 `MermaidDecoration` 扫 code_block 渲染 SVG widget + 自管切换/删除/关闭按钮(默认 pre 隐藏,SVG `side:-1` 渲染在其前;点击 SVG 派发 setMeta 翻转 editNodePos,展开时 `queueMicrotask` 把光标放进 pre)。**坑**: plugin promise resolve 后不要 dispatch setMeta rebuild decorations,直接在 widget dom 上写 svg,否则 `WidgetType.eq` 失效 → 死循环;主题切换同理走 window listener 自改 dom + `spec.destroy` removeEventListener 防泄漏。PM 搜索命中隐藏的 mermaid 源码时,必须先走幂等展开 helper 再做 `TextSelection` / `coordsAtPos` / 滚动;不要直接 blind toggle,否则已展开块会被收起,或 Mermaid 自带 pending focus 抢走搜索选区
- **mermaid + codeHighlight 双 plugin 分工**: codeHighlight 负责所有 code_block 的 toolbar + 语法高亮;mermaid 走 MermaidDecoration 自管 SVG widget + 切换/删除/关闭按钮(codeHighlight 在 lang='mermaid' 上不挂 toolbar,避免同 pos 同 side 多 widget 冲突)
- **mermaid 语法高亮旁路 shiki**: shiki bundled mermaid grammar 薄(只输出按行纯文本 token),`codeHighlight` 对 `lang==='mermaid'` 走自写 `tokenizeMermaid`(6 类:keyword/direction/shape/edge/label/comment),颜色从当前代码块主题按 TextMate scope 提取 hex 写进 `--shiki-light/dark` 局部变量(同 shiki token 形态);主题切换/dark 切换两条路径同 shiki
- **shiki dual-theme 代码高亮**: `codeToTokensWithThemes` 返回 token 级双色,每 token inline `--shiki-light/dark` 变量,SCSS 按 `html.dark` 选。**darkMode toggle 纯 CSS 切色(零重渲);换主题(换 hex)才 rebuild**,由 App.vue watch 触发。首屏零闪烁:App.vue `codeBlockReady` 守门 PM mount;`state.init` 同步拿 cached highlighter
- **shiki 预扫 + 懒加载 lang**: 启动只装 doc 实际 lang ∪ 5 项 BASELINE(js/ts/py/bash/json);运行时 miss 用 `hl.getLoadedLanguages()` 探活(不能用 `getLanguage()`,miss 时 throw),异步追加 grammar 后**不直接 rebuild highlighter**,经 plugin 端 `setDecorationRebuildCallback` 钩子让 plugin 自己 rAF 节流 rebuild decorations(见下方“shiki 两条正交路径”)。**首次 miss 那帧无 token 是有意为之的"先骨架后着色"**
- **语法实时转换走 appendTransaction + dirty-range**(不走 InputRule 末尾匹配): `syntaxAutoFormat.ts` 从 `tr.mapping.maps` 提 dirty range → textblock 段首检测 + inline 正则扫描,黑名单(code_block/html_block/math_block)、code mark、link session 框架统一过滤。新增语法 = 写一个文件 + `syntax/index.ts` 注册一行。**坑**: block detector pattern 带 `^` 不带 `g`;inline 带带 `g` 不带 `^/$`;inline 扫描前 atom 用 NBSP 占位防穿透;语法 apply 直接改框架传入的 `tr`,不要自己 dispatch。**inline 扫描的 blockText 不能用 `doc.textBetween`**:它对"有 content 的非 text inline 节点"(footnote_reference `content:'text*'` / math_inline `content:'text*'`)会递进取 text content,输出的字符数 < 节点占的 doc 位置数(差 open+close tag 开销),match.index 映射回 doc 位置偏前 → replaceRangeWith 删错位置 / 删进节点边界。框架用自写的 `buildBlockText` 替代:text 节点追加 text content;inline 非 text 节点用 `\u0000` 占位(长度 = nodeSize,不递进 content);block 容器(doc/paragraph)下钻。黑名单检查从 `includes(' ')` 改成 `includes('\u0000')`
- **公式围栏守卫在 remark-math 前做文本预处理**: Velo 约定块级公式开头行必须只有 `$$`,同一行 `$$...$$` 继续按行内公式解析。`remark-math` 默认接受 `$$meta` 作为 flow math 开头,且 EOF 也能闭合,用户少写行尾 `$$` 时会把后续段落吞成一个 `math_block`;因此 pipeline 在 `remark-math` 前把“行首 `$$` 后有正文但本行没有闭合 `$$`”转义成普通文本。导出 HTML 复用同一守卫,避免编辑器与导出语义分叉
- **NodeView 隔离**: `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror。**坑**:PM 的 `view.dom` 是 contentEditable 容器,所有 selection 统一由 PM 管理;在 NodeView 里嵌套 `contentEditable=true` 的子元素(sup / labelSpan)拿不到独立 focus —— 浏览器把 focus 给了子元素但 PM 的 selection 仍停在外层,Backspace/Delete 按 PM 的 selection(子元素外)处理 → "删错位置"。需要"光标进入、逐字符编辑"的 inline 节点(如 `footnote_reference`)不要走 atom + contentEditable,改成 `content: 'text*'` 的非 atom 节点 + `contentDOM = dom`,让 PM 直接接管 text 编辑(selection 自然进入)。label 作为 text content 而非 `attrs.label`,markdownIO 双向适配。`footnote_definition` 的 label(v0.5.8 起)同样拆成 `footnote_label` block 节点(`content: 'text*'`,作为 `footnote_definition` 的强制首子)而非 `attrs.label`,NodeView 不再自管 `labelSpan` 的 input/keydown:之前版本(<= v0.5.7)的 `<div class="footnote-label">` 是 NodeView 自造的、不在 contentDOM 子树内的元素,PM 看不到 → 点击 label 时 PM 默认把 selection 推进到最近的 content 子树 = 描述段 `<dd>` 前,Backspace/Delete 删错位置。改后与 `footnote_reference` 完全同范式,PM 接管 label 文本,光标自然进入 `<dt>` 内编辑。`FootnoteNodeViews.ts` 的 `currentLabel` 从 `node.firstChild.textContent` 读 label,`defs` 映射同步从 `firstChild.textContent` 算;`computeNumbering` 一处统一两份来源
- **NodeView 必须实现 `stopEvent`(math 块踩坑)**:`isolateInputFromProseMirror` 的 `stopPropagation` 只能拦"事件从 textarea 冒泡"这一条路径,PM 的 `eventBelongsToView` 还会从 `event.target` 沿祖先链对每个有 `pmViewDesc` 的节点问 `stopEvent` —— 这是 PM 隔离 NodeView 子元素(嵌套 textarea / input)的**主要**机制。math_inline / math_block 编辑态挂 textarea + preview,`stopEvent` 不实现 → 用户敲字符时 PM 走默认 `tr.insertText(text, from, to)`,math 节点当 NodeSelection 被替换 → "math 节点消失 / 输入框消失 / 光标消失"(`$$`+Enter 那条路径尤其明显,atom + NodeSelection 选中是默认 selection 形态)。**两道闸都要有**:inner 一侧 `isolateInputFromProseMirror` `stopPropagation`(目标在 textarea 时的快速路径)+ outer 一侧 NodeView `stopEvent` 返回 `true` 对 `beforeinput / input / keydown / paste / composition*` 等输入事件族,两闸互不依赖,任一就够拦住 PM。
- **NodeView async render 的 stale-check 分工**:katex / mermaid 之类异步渲染(v0.4.6 mermaid / v0.5.8+ katex 改懒加载后)首屏首次 import 是真异步 I/O,与 NodeView 工厂的同步 `showDisplay()` 排队 + `setTimeout(startEdit, 0)` 之间有 race:showDisplay 同步 `dom.innerHTML=''` + `void renderKatex(...)` 起 await → setTimeout macrotask 跑 startEdit 同步挂上 editor(`is-editing` class)→ 异步包加载完 renderKatex 继续往下 `katex.render(source, el, ...)` 写到 dom,**覆盖刚挂好的 editor**。`renderKatex` 在 `await getKatex()` 前后各判一次,**但分工不同**:入口闸只判 `is-editing`(`$$`+Enter 自动进 edit 这条路径需要);await 后的闸额外判 `!isConnected`(PM 已销毁 dom 的话放弃写入)。**坑**:入口闸不要判 `!isConnected` —— NodeView 工厂同步跑 showDisplay 时 PM 还没把 dom 挂到 view.dom,`isConnected === false` 是常态,入口闸 return 后整个 NodeView 寿命里 katex 都不再 render,用户感知"math 节点消失 / 切到源码模式再切回后空了"
- **粘贴 text/plain 必须注册 `clipboardTextParser`**: ProseMirror 默认 plain-text fallback 把整段按 `\n+` 拆 `<p>` 再 `normalizeSiblings` 自动包 blockquote,产出错位 doc。`markdownPastePlugin` 走 fromMarkdown 输出**封闭 slice `(0,0)`**(非 `maxOpen`)走标准 "join 前后 paragraph" 路径把 blocks merge 进 doc 顶层
- **样式分层**: ProseMirror 基础排版内联 `<style>`,公式/Mermaid/脚注/TOC 走 SCSS partial
- **TOC 目录走 Decoration.widget 不走 NodeView**: 跟 mermaid 同范式;widget key 含 headingsHash,变化自动重建。**坑**: `[TOC]` 回写 toMarkdown 必须用 mdast `html` 节点(非 text)包裹,text 节点里的 `[` 会被 escape 成 `\[`
- **源代码模式**: `SourceModeEditor` 独立 CodeMirror 6 `EditorView`,与 `ProseMirrorEditor` 经 `v-if` 互斥;`documentStore.sourceMode` 唯一开关。extensions: 持久行号 + 软换行 + drawSelection + highlightSpecialChars + history + 自定义 keymap(Tab 插 2 空格覆盖 `indentWithTab`;Escape → `toggleSourceMode`)+ `forbidFileDropPaste`(v0.5.1 起分叉:文件树拖入路径(自定义 MIME `application/x-velo-tree-path`) → .md 打开 / 图片落盘插图;OS 文件型 drop 图片同样落盘插 markdown 语法,与富文本行为镜像;非图片文件 drop preventDefault 防 webview 导航;paste 仍保持吞 image/*——源码模式 paste 无"树路径"概念。共享逻辑见 `image/treeDrop.ts`)+ shiki 高亮 ViewPlugin(`shikiCmPlugin.ts`,token.offset 即 CM6 doc pos)+ updateListener(docChanged → emit content,docChanged/selectionSet → emit raw markdown cursor)。**主题名镜像在 StateField**,build 只读镜像不读 store(防 ensureTheme 未 resolve 期间全黑);dark/light 纯 CSS,切主题才 rebuild
- **编辑器光标上报**: 状态栏所需行列由当前挂载编辑器向 `App.vue` 上报,不写进 `documentStore`。CM6 源码模式用 raw markdown 坐标;ProseMirror 模式用 `doc.textBetween` 的可见文本投影坐标,不做 raw markdown 反向映射,避免把状态栏耦合到跨模式同步算法
- **跨模式光标 + 浏览状态同步**: App.vue 单点 `watch(sourceMode, cb, { flush: 'pre' })` 覆盖全部切换入口(Ctrl+\` / 工具栏 / Esc 都走这一个布尔翻转)。`flush:'pre'` 读**出**方向 view(卸载在 render 阶段,晚于 pre-flush watcher)抓锚点;`await nextTick` 后**入**方向 `onMounted` 已建 view → 应用。`crossModeSync.ts`: 两边各 token 化(剥 markdown 标记字符 `#*~_\`-+[]()!>|`——**`|` 入集关键**,否则无空格表格粘成一个 token),`captureAnchor` 取光标 ±64 个 token 序列 + token 内字符偏移,`applyAnchor` 跑 **LCS** 对齐(链接 URL、表格 `|`/`|---|` 分隔行是 CM6 多出、PM 没有的 token,整窗 indexOf 砍不掉 → 失败跳顶;LCS 当"未对齐"跳过)。光标 token 自身是多余方(如落在 URL 里)→ 退最近对齐邻居边界。最佳努力:空文档/view 未就绪放弃;LCS 矩阵超 4M 格(token > ~31k)退线性首现。滚动:CM6 `scrollIntoView(pos,{y:'center'})`;PM **不用** `tr.scrollIntoView()`(默认"最小滚入视口"= 跳到最底),改 `coordsAtPos`+祖先 `scrollBy` 居中;入方向主动 focus
- **katex/mermaid 懒加载拆 chunk**: `MermaidDecoration.ts` / `MathNodeViews.ts` 顶部不走静态 `import mermaid/katex`,改模块级 lazy getter(`getMermaid()`/`getKatex()`),首次渲染时才 `await import(...)`,Vite/rolldown 据此拆出独立 chunk,首屏不加载。`vite.config.ts` 不能加 `codeSplitting:false`(会把所有 JS 合回主 chunk,懒加载失效);`cssCodeSplit:false` 保留(单 CSS 有意),代价是 katex CSS(~23KB)仍合并进主 CSS,可接受。导出路径(`lib/export/{katexHtml,mermaidHtml}.ts`)同范式 lazy getter,`htmlRenderer.ts` 调用点加 `await`。doc 含 mermaid/$$ 时 plugin/NodeView 第一次扫描到节点自动触发懒加载,加载期间 mermaid 显示"渲染中..."占位、math 显示空占位,加载完渲染。**坑**:dev 模式下懒加载几乎无收益甚至轻微回退(Vite 预构建缓存 + 首屏 doc 为空不触发渲染),production 才有真实收益(主 chunk 14MB→1.5MB,WebView2 解析编译开销骤降)——**性能指标必须用 `tauri build` 出包后在 WebView2 测,不能看 `npm run dev`**

---

## 维护者注意点

- **脚注 label 是显示文本,无自动编号**: 扩展点是在 `FootnoteNumberPlugin.state` 加 `numbering: Map<label, number>`,**不要**把编号写回 label(丢语义,跟 GFM 不符)。`footnote_reference` 的 label 是 text content(schema `content: 'text*'`),`footnote_definition` 的 label 是 `attrs.label`
- **空 math 节点走占位不调 katex**:`MathNodeViews.ts` 的 `showDisplay` 在 `attrs.value`(block)/ `textContent`(inline)为空时改渲染 `.math-empty-placeholder`(虚线框 + 提示文字),不走 `renderKatex('' → ' ')` —— katex 输出高度趋近 0 的 `.katex-display`,WYSIWYG 里节点看起来"消失",源码模式却仍然能看到 `$$\n$$` 两行。占位 `pointer-events:none`,点击事件透传到 `.math-node` 上的 click listener → 重新进 `startEdit`。`startEdit` 里 `setPreviewHtml(renderedHtml)` 也要按此短路:空节点捕获到的 `renderedHtml` 是占位 DOM,塞回 preview 会让 `querySelector('.math-empty-placeholder')` 重新命中 → 必须 `if (renderedHtml && node.attrs.value) editor.setPreviewHtml(renderedHtml)` 守卫。
- **shiki 两条正交路径**: darkMode toggle 纯 CSS 切色(零重渲,不要 dispatch setMeta);换主题 hex 变了才 rebuild,由 App.vue watch 触发。懒加载 lang(`ensureLanguage`)/主题(`ensureTheme`)只 append grammar/hex **不重建 highlighter**,走 plugin 端 `setDecorationRebuildCallback` 钩子让 plugin 自己决定 rebuild 时机;**不要 await getHighlighter 后立刻 dispatch setMeta**。CM6 源码模式同理:主题名镜像在 StateField,build 只读镜像(防 ensureTheme 未 resolve 期间全黑)
- **clipboard 统一走** `@tauri-apps/plugin-clipboard-manager` 的 `writeText`
- **code toolbar widget 用真盒子**,不能 `display:contents`: `display:block; height:22px`,`side:-1` 渲染在 `<pre>` 之前,用 `:has(+ pre:hover)` 联动 hover
- **快捷键 declarative registry**: 所有键位在 `editor/shortcuts/bindings.ts` 集中注册,**不**在 EditorInner.vue 硬编码。新加快捷键 = 新建 command 文件 + `bindings.ts` 加 1 行 `registerShortcut(...)`,不碰 EditorInner / registry.ts
- **inline syntax regex 必须自带 word boundary**,不依赖 registry 顺序防误识别: 开口 `(?<!\W)` / 闭口 `(?!\W)` 等挡前后导;inner 不含分隔符(如 strong inner `[^\n*]+?`)。例:`**33**` 必须被 strong 吃掉、`text==hi==` 不应被 highlight 误识别 —— 见 `syntax/inline/strong.ts` / `highlight.ts` 顶部注释
- **新增暗色规则要两处同步**: editor 走 `_editor-dark.scss` 的 `:is(.dark .velo-editor, .velo-editor.dark)`(Vue 控制 `<html class="dark">`),export 走 `exportStyles.scss` 的 `@media (prefers-color-scheme: dark)`(**自写副本,不 forward `_editor-dark.scss`**,导出 HTML 无 `.velo-editor.dark` 依赖)。两套语义不等价:导出只跟系统暗色偏好走,不能跟应用内 toggle 走。新增暗色规则必须两边写
- **shiki token 必须缓存,`getTokensCached` 是 per-keystroke 关键路径**: `props.decorations(state)` 契约无脏区间钩子,每次 transaction 全量重跑;1000 行文档对所有 code_block 同步跑 `codeToTokensWithThemes` 累计 ~100ms 卡顿,实测占输入路径总耗时 90%+。`CodeBlockLangs.ts` 走 LRU(cap 200)按 `(lang + lightTheme + darkTheme + content-hash)` 缓存 token 数组,普通段落键入 ~99% 命中,单次 deco build 从 ~100ms 降到 ~5ms。**不要清理这层 cache,删了立刻退步 20x**。缓存值是 token 而非 Decoration —— `token.offset` 是块首相对偏移,与 doc 位置无关,`buildDecorations` 仍走 `blockStart + offset` 重算绝对 pos;直接缓存 Decoration 会脏(`Decoration.inline` from/to 是绝对位置,块在 doc 里移动就过时)。theme 名进 key 自然处理"切代码块主题"路径,rebuild 触发由"shiki 两条正交路径"那条 `setDecorationRebuildCallback` 钩子统一管。
- **htmlTag 实时转 html_inline 必须注册**(v0.5.7): 用户键入完整 HTML 行内标签(如 `<kbd>Mod</kbd>`)想 PM 立即渲染 kbd 视觉,核心就是一条:
  1. **必须注册**:`syntax/index.ts` 缺 `registerInlineSyntax(htmlTagSyntax)` 等于整条语法静默失效 —— 不报任何错,用户敲完整段都不转(已踩坑:v0.5.7 之前的 syntax/index.ts 漏注册,文档里有 htmlTag 但实际不生效)。注册位置放 inline 队列最后(`highlight` 之后),不影响其他 syntax 抢匹配
  - **只匹配完整闭合**:regex 是 `PAIRED | SELF_CLOSE`,`<TAG>content</TAG>` 或 `<TAG/>` 才转。**不**做"敲到一半就转开标签"的优化 —— 用户期望边敲边编辑,过早转 atom 反而把光标锁在 atom 之后,backspace 删不掉刚敲的 `<kbd>`,体验更差
  - **`<` 在 prose text 里的反斜杠转义是正常行为**:敲到一半的 `<kbd>` 留 plain text,`toMarkdown` 走 `mdast-util-to-markdown` 的 `safe()` 加 `\<` 反斜杠转义(prose text 里的 `<` 后接字母或 `/` 属于 unsafe 模式,CommonMark 规范要求)。完整闭合转 atom 后这条转义路径自动消失。**不要**在编辑器层去对抗 round-trip 完整性(`safe` 是为重 parse 时 `<` 不被误当 HTML 起始)

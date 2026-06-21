# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 重大架构决策的取舍记录见 [`DECISIONS.md`](./DECISIONS.md)；当前设计状态与踩坑记录见
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的"设计要点 / 维护者注意点"。本文件只记
> **用户可见**的版本变更；普通 feat / fix 的 source of truth 是 `git log`。

## [Unreleased]

### Added
- **导出功能 (HTML / PDF)**：顶栏新增"导出"按钮（位于"另存为"与"搜索"之间），快捷键 `Ctrl/Cmd+Shift+E`。点击弹原生 saveDialog，filter 列出 HTML / PDF：
  - **HTML**：自包含 HTML 文档，mermaid SVG / KaTeX 公式 / shiki 代码高亮 / 任务列表 / 警告框 / GFM 表格 / 脚注 / kbd / mark 等全部 inline CSS 内嵌；图片走 `asset://` 协议在 Tauri webview 内可显示；自适应浏览器 / 打印机的 `prefers-color-scheme` 暗色；导出失败有 warnings 收集而非中断。
  - **PDF**：经 Tauri command `export_pdf` 调平台原生 PrintToPDF API（Windows WebView2 `ICoreWebView2_7::PrintToPdf`，通过 `with_webview` escape hatch），静默写到 `saveDialog` 拿到的目标路径，**不弹任何系统对话框**（与 Typora / Obsidian 同款 UX）。macOS / Linux 当前返回 `PdfError::Unsupported`，前端展示 "not supported on this platform yet" 错误。
  - 复用现有 shiki / KaTeX / mermaid / DOMPurify，零前端新依赖。Rust 端新增 `webview2-com` / `windows`（仅 Windows target）调 WebView2 COM API。

### Changed
- 阶段 3 测试组件引入：`htmlRenderer` 端到端 18 例（语法覆盖 + 降级路径）+ `export store` 合约 7 例（saveDialog / writeTextFile / `invoke('export_pdf')` 路径 / 错误反馈 / reentrant 守门）。

## [0.4.6] — 2026-06-21

### Added
- **Mermaid 图表升级为代码块一体化**：`​```mermaid` 节点废弃，改走标准 `code_block { language: 'mermaid' }` 管线，shiki 语法高亮 + SVG 预览 + 语言切换 / 复制工具条一体化。用户输入即所得，无需磁盘往返"激活"。
- **Mermaid 自带主题感知配色**：新增轻量 `mermaidTokenizer`（6 类：keyword / direction / shape / edge / label / comment）旁路 shiki 薄弱的 mermaid grammar，颜色跟随当前代码块主题与 dark / light 切换。
- **源代码模式迁移到 CodeMirror 6**：替换旧 `pre + textarea overlay`。软换行、持久行号、shiki 双主题高亮、撤销栈、特殊字符高亮全部由 CM6 提供；主题切换走 StateEffect + ViewPlugin rebuild。
- **跨模式光标与浏览状态同步**：切换 WYSIWYG ↔ 源码模式时，光标与滚动位置走 token 序列 + LCS 对齐，落在视觉对应处而非跳回文档顶（最佳努力，超大文档退线性首现匹配）。
- **源代码模式查找替换**：经 `FindReplaceBackend` 抽象共用 `FindReplace` 面板（`createPmBackend` / `createCmBackend`），跨模式 query 保留（意图上提 App.vue `provide/inject`），CM6 高亮 StateField 镜像 PM 侧插件。
- **`code_block` Backspace 隔离**：在 code_block 起点按 Backspace 吞掉事件（有内容）或转 paragraph（空块），覆盖 base keymap 的 `joinBackward` 误拆 defining code_block。
- **任务列表两阶段升级**：在已有 `-` list_item 内键入 `[ ] ` / `[x] ` 升级 attrs.checked，PM 重建 NodeView 切换 task DOM。
- **完整 CommonMark 主题分隔线**：`-` / `_` / `*`（≤3 前导空格、≥3 标记符、单一标记符贯穿、可选内部空白），段末 Enter 提交，无需尾随空格。
- 源码模式禁止拖入文件 / 粘贴图片（对齐 Typora，防 webview 把文件当"打开"导航掉）。

### Changed
- Mermaid 不再是 atom 节点：选区 / 键盘 navigation 从"整块选中"变为"逐字符编辑"，空块 Backspace 转 paragraph。

### Fixed
- **Mermaid 删除按钮范围错位**：`tr.delete` 误用 `absolutePos`（= descendant pos + 1）而非 block 边界，残留 code_block open token 并把下一段并进来。
- **Mermaid pre 首次插入后自动隐藏**：`tr.mapping.map(pos)` 默认 `assoc=+1` 把 content 起点映到插入文本末尾，丢失 `editNodeSet` 条目；统一改 `assoc=-1` 保留"变更之前"语义。
- **查找替换切模式后找不到匹配**：入方向 view 未就绪时 recompute 出空；入方向 `onMounted` + `nextTick` 补一次重算。

### Removed
- Mermaid 旧 textarea / commit / cancel / autoHeight 实时预览路径（约 250 行）。
- `MERMAID_REFACTOR_EVAL.md`（决策已沉淀为 ADR-20260620-001）。

### Dependencies
- 新增 `@codemirror/commands@^6.10.3`、`@codemirror/state@^6.6.0`、`@codemirror/view@^6.43.1`。


## [0.4.5] — 2026-06-19

### Added
- **`[TOC]` 目录支持**：`[TOC]` 独占段落自动渲染为动态目录（点击跳转 + 闪烁反馈），实时键入自动转换（syntaxAutoFormat 驱动）；hover 显示垃圾桶图标，点击还原为 `[TOC]` 段落（保留撤销）。

### Fixed
- **多段 Markdown 粘贴错位**：新增 `markdownPastePlugin` 持有 `clipboardTextParser`，粘贴的 `text/plain` 走 `fromMarkdown` 解析返回封闭 slice（0/0），绕开 ProseMirror 默认 plain-text fallback 的 `normalizeSiblings` + `Fitter.dropNode` 错误合并（典型症状：`## TL;DR` 与 `**结论**` 粘贴后 heading 与 strong 错位）。code 容器内粘贴保留源代码语义；空 / 空白 / 解析失败回退默认 fallback。


## [0.4.4] — 2026-06-18

### Added
- **声明式快捷键注册表**：`registerShortcut({ key, command, label, group })` API + `bindings.ts` 集中注册，内置 17 个键位（文本 mark 5 + 段落 1 + 标题 6 + 列表 2 + 引用 1 + 代码块 1 + 表格 1）。`label` / `group` 字段为后续命令面板 / 速查 overlay 预留接口。改键位改一处即可。
- **`==highlight==` 高亮 mark**：schema + remark 插件 + markdownIO 双向 + 实时键入全链路打通。
- **`**bold**` / `__bold__` / `*italic*` 实时键入**：strong 与 emphasis 实时转换。

### Deprecated
- 水平线快捷键（`Mod-Shift-h`）验收未生效，延期后续版本；`insertHr` 函数保留待启用。


## [0.4.3] — 2026-06-18

### Added
- **shiki 双主题代码高亮**：替换 CDN 加载的 highlight.js。每个 token 内联 `--shiki-light` / `--shiki-dark` 局部 CSS 变量，`<html class="dark">` 切换走级联翻色（零重渲，ProseMirror / shiki 不参与）。
- **代码块工具条 + 语言选择**：`codeHighlightPlugin` 在 code_block 节点挂工具条（复制 + 语言选择浮层，Teleport-to-body），含 20+ 常用语言清单，全部本地打包无 CDN。
- **主题设置**：支持 66 个 shiki 主题下拉选择，启动仅懒加载当前主题对。
- **首屏零闪烁守门**：`codeBlockReady` 等 highlighter 就绪再挂载 PM，`state.init` 同步拿 cached highlighter，消除首屏黑屏闪烁。
- **崩溃恢复草稿**：脏盘期间每 30s 自动保存草稿到 `appDataDir/drafts/`，启动时通过弹窗展示可恢复文档。
- **代码块启动期预扫 + 懒加载语言**：`extractLangsFromDoc` 走 mdast 扫 doc 的 fenced code lang ∪ 5 项 BASELINE 兜底，首屏 grammar 从 ~6MB 降到 ~1-1.6MB；运行时 miss 走 `ensureLanguage` 异步追加，resolve 后 rAF 节流 dispatch setMeta rebuild。
- **工具条几何同步**：`ResizeObserver` + scroll / resize 监听修复侧边栏开合导致的工具条漂位。
- **`isTauri()` 守门**：dev web 端 Tauri API 同步 throw 不再阻断 async 链。

### Changed
- 代码块主题弃用跟随 darkMode（`codeBlockTheme` 字段在 `PersistedSettings` 类型里保留作 shape 锚点，不再读写，旧 settings 文件残留字段被忽略）。
- 升级示例 markdown（Vite `?raw` 引入），覆盖全语法演示。

### Fixed
- `code_block` 内 Enter 误拆：新增 `codeBlockEnter` keymap 拦住 base keymap 的 `splitBlock`，光标在 code_block 内按 Enter 只插换行不拆段。
- WASM 在 Tauri build 中失效：CSP 加 `'wasm-unsafe-eval'`。

### Dependencies
- 新增 `shiki@^4.2.0`、`@shikijs/langs`、`@shikijs/themes`、`@tauri-apps/plugin-clipboard-manager@^2.3.2`、`tauri-plugin-clipboard-manager`。
- Tauri 加 `devtools` feature + `open_devtools` command。


## [0.4.2] — 2026-06-15

### Changed
- **CSS 分层**：`ProseMirrorEditor/index.vue` 660 行 `<style>` 拆到 `src/styles/_editor-{base,typography,lists,code,tables,image,html-blocks,alerts,dark}.scss` 9 个 partial，SCSS 嵌套。
- **命名清理**：`.milkdown-editor` / `.milkdown-image-inline` / `.milkdown-icon` / `milkdownRef` 全部改 `velo-` 前缀（11 文件、100+ 选择器）。
- **编辑器重建路径简化**：删 `innerKey` + `rebuildRequest` + `focus-on-create` prop，`EditorInner` 内部 `watch modelValue` 改用 `view.updateState` 替换内部 state（view 实例稳定，plugin state 因 init 归零）。

### Fixed
- `velo-drop-cursor` 不显示：SCSS 嵌套选择器匹配不上 `document.body` 上的元素，改全局选择器。
- 链接 `[text](url 含内部空格)` 解析失败：实时路径放宽正则，解析路径经 `remarkEncodeLinkUrls` 预处理让 remark-parse 接受，doc 里 href 保持用户友好形态（已 decode）。
- 锚点跳转不匹配：`scrollToAnchor` 加 slug 化降级匹配，`# Markdown Syntax` 这类带空格链接能正确跳到 `#markdown-syntax` heading。

### Removed
- 删 `paragraph.attrs.empty` 死属性（0 处使用；空段落改用 `childCount === 0` 检测）。
- 删 `prosemirror-caret-hidden` 老 bug 代码（3 文件；旧 CSS 选择器从未匹配）。


## [0.4.1] — 2026-06-15

### Added
- **链接渲染**：Cmd / Ctrl+click 跳转外部链接，`[text](url)` 自动补全，选中内容自动格式化。
- **GitHub 风格警告框**：5 种变体（note / tip / important / warning / caution），完整双向 markdown 映射 + round-trip。
- **HTML 透传**：通过 DOMPurify 安全渲染标签（如 `<kbd>`、`<details>`），合并行内 HTML 防渲染错位。
- **语法实时转换框架**：`syntax/*` registry + `syntaxAutoFormat.ts`，dirty-range 局部扫描；新增语法只需写一个文件并在 `syntax/index.ts` 注册一行。
- **键入即转化的块级语法**：heading / blockquote / bullet_list（含 task）/ ordered_list / code_block / hr / alert（blockquote 内）共 7 类。
- **行内语法反向输入修复**：footnote / link / math / emphasis / strike 修复"先 `]` 再补 `[^xxx`"反向输入不触发的问题（框架用 `g` 正则统一覆盖）。

### Changed
- **InputRule 收敛**：5 个 InputRule + `linkAutoFormatPlugin` 合并进 `syntax/*` registry；`EditorInner` 的 `inputRulesPlugin` 仅保留 `ellipsis` / `emDash` 纯文本快速路径。

### Fixed
- **list_item Enter 行为错误**：v0.4.0 迁移漏挂 `splitListItem`；Enter 链补齐为 `chainCommands(dollarEnterCmd, splitListItem, liftListItem, splitBlock)`，空 list_item 按 Enter 正确退化为普通段落。
- **空行保留**：调整注入公式并用文本占位符处理空段落，修复显示与 round-trip 翻倍问题。
- **CRLF / CR 文件**：`preprocessBlankLines` 加行尾规范化（CRLF / CR → LF），`\r` 不再破坏正则；`Math.ceil` 显式化消除隐性不变量。修复 Windows 文件多空行识别。

### Dependencies
- 新增 `dompurify`、`@tauri-apps/plugin-shell`。


## [0.4.0] — 2026-06-13

### Added
- **编辑器从 Milkdown 迁移到裸 ProseMirror + remark/unified**：Milkdown 抽象层对每条自定义语法（math / mermaid / footnote / image）都是纯开销，upstream `markRule` 正则 bug 还要写补丁绕开。迁移后净减 96 个传递依赖。
- 自建 schema（22 节点 / 5 mark，对齐 Milkdown preset 默认）+ unified pipeline（remark-parse + remark-gfm + remark-math）+ 自写 mdast ↔ PM 转换。

### Changed
- 迁移 11 个 nodes / + findreplace / + image / + plugins 文件（仅 `import` + 解包 `$prose` / `$inputRule` / `$remark` 包装）。

### Removed
- 删 `src/components/MilkdownEditor/`（18 文件）。
- 卸载 `@milkdown/kit` / `@milkdown/plugin-clipboard` / `@milkdown/plugin-math` / `@milkdown/vue`（净 -96 传递依赖）。
- 删 `VITE_USE_PM` feature flag，硬切到 ProseMirrorEditor。

### Fixed
- 迁移期回归（均补回归测试）：
  - Enter 不换行：`keymap(baseKeymap)` 缺失，`splitBlock` 需显式 `chainCommands` 串接。
  - Backspace 选整段：`imageKeymap` 误用 `isAtom`（ProseMirror 陷阱：`$pos.nodeBefore` 在 text 内返回 atom-ized text slice），改 `type.name` 检查。
  - `$x$` 不转 math_inline：remark-math 只管外部 markdown 解析，实时键入需显式 InputRule。
  - Shift-Tab 非列表上下文失焦：返回 `false` 让浏览器抢走 contentEditable 焦点，改返回 `true` 消费。


## [0.3.3] — 2026-06-13

### Changed
- **Mermaid 改用 `Decoration.widget`**：渲染 SVG 时改写 atom 节点 outer dom 的 `innerHTML` 会被 ProseMirror `DOMObserver` 当外部突变，触发整块 destroy + recreate，用户每敲一字符 mermaid 全闪 loader。改走 `Decoration.widget`（`WidgetViewDesc.ignoreMutation` 默认忽略非 selection 突变），NodeView 整层移除。
- **编辑器目录拆分**：`MilkdownEditor/` 拆为 `nodes/` + `findreplace/` + `image/` + `plugins/` 子目录，根目录仅留 `index.vue` 与 `EditorInner.vue`。

### Removed
- 删 `MermaidNodeView.ts`（改走 widget 方案）。


## [0.3.2] — 2026-06-12

### Added
- **图片粘贴 / 拖拽落盘**：保存到 `<fileDir>/assets/`（已保存文档）或 `<appDataDir>/assets/`（未命名文档），markdown 使用相对路径便于文档迁移。
- **SHA-256 内容级去重**：重复导入同一张图时复用已有文件，不重复写盘。
- **image-inline NodeView** + Tauri `asset://` 协议代理，本地图片经 `proxyDomURL` 转 asset URL 渲染。
- **Atom 节点删除保护**：Backspace / Delete 紧贴 atom 节点（图片 / mermaid / 公式块）时先选中再删。
- **图片上传插件**：通过 `handleDOMEvents` 拦截粘贴与拖拽，落盘后插入图片节点。
- **图片路径工具链**：落点决策、markdown src → 物理路径、MIME / 扩展名双向转换。
- **Tauri asset 协议**：`protocol-asset` Cargo feature、CSP 增 `asset:` 规则、`assetProtocol` 作用域、二进制 I/O 所需 fs 权限。

### Fixed
- **tauri-plugin-fs watch feature 门控**：`Cargo.toml` 显式启用 `watch` feature，修复 Tauri 2.5 默认不含 watch 导致的 `Command watch not found` 错误。


## [0.3.1] — 2026-06-09

### Added
- **编辑器内查找 / 替换**（Ctrl+F / Ctrl+H）：支持大小写 / 全词 / 正则匹配、命中高亮、计数、导航与替换。
- 工具栏搜索按钮（带激活高亮与切换关闭），全局 Ctrl+F / Ctrl+H 快捷键拦截。
- **行首 `$$` + Enter** 快速插入空数学公式块并进入编辑态。
- 查找匹配与空行保留单元测试。

### Fixed
- 行内公式编辑后不显示。
- Mermaid 主题检测错误，以及切换主题时的渲染闪烁与高度坍缩。
- 大纲 scroll-spy 在文档顶部未高亮首个标题。
- 大纲当前标题高亮样式未正确应用主题色。
- 脚注输入规则在段落开头误触发。
- 移除孤儿脚注的波浪下划线（避免与拼写检查标记混淆）。
- 隐藏 ProseMirror 自动追加的末尾不可见元素。


## [0.3.0] — 2026-06-08

### Added
- **设置持久化**：字号 / 主色 / 字体 / 暗色 / 代码块主题 / 自动保存等全部持久化到 `app_data_dir`。
- **大纲折叠状态持久化**，按文件路径区分。
- **崩溃恢复**：脏盘期间每 30s 落盘草稿，启动时检测并提示恢复。
- **任务列表**：`[ ]` / `[x]` 编辑器内点选切换。
- **脚注语法**：渲染、Ctrl / Cmd+点击跳转 def、def 末尾回链 ref。
- **状态栏**：字数 / 词数 / 行数。

### Changed
- **编辑器生命周期交给 `@milkdown/vue`**：删手写的 `createEditor` / `onMounted` / `onUnmounted` / `watch(modelValue)` / `isInternalChange` / 220ms `setTimeout` 守卫，改用 `EditorInner.vue` + `useEditor()` + `<Milkdown />` 自管挂载；外部 modelValue 变化用 `lastSelfEmitted` 值对比探测，emit `rebuildRequest` 让外层 bump `innerKey` 触发整体重挂。
- 抽 `src/utils/outline.ts` 共享大纲解析；抽 `plugin-common.ts` 共享 input 隔离。

### Fixed
- 左侧大纲超长无滚动条。
- 大纲标题里 `_` `*` 等符号被多余反斜杠显示。
- 粘贴 markdown 源码（`**bold**` 等）不被识别为富文本（集成 `@milkdown/plugin-clipboard`）。
- Mermaid / math textarea 粘贴内容被外层 ProseMirror 抢走（抽出 `plugin-common.ts` 统一隔离）。
- `save` / `saveAs` / `openPath` 失败时缺反馈，改为弹原生 message。
- 行内公式编辑态键入抛 `ReferenceError: autoHeight is not defined`。
- `recoverDraft` 后被 focus / fs:watch 静默用磁盘旧版本覆盖。
- 切文件后编辑器不自动获取焦点。
- `syncTitle` 在非 Tauri 浏览器环境同步抛 `TypeError` 致白屏。

### Test
- 引入 Vitest + jsdom + Tauri mock（`src/test/setup.ts`）。
- 纯函数测试：大纲解析（`stripFormatting` / `unescapeMarkdown` / `parseHeadings`）。
- Pinia store 测试：document store 完整状态机 + editor 默认值。
- ProseMirror 插件集成测试：Footnote NodeView 编号 / Ctrl+click 跳转 / 回链。
- 共 101 个测试。

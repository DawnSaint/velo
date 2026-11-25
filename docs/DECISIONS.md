# Velo Architecture Decision Records

> 重大架构取舍的 ADR（Architecture Decision Records）。
>
> **维护规范**:
> - 走 Context / Decision / Consequences 三段（精简版 MADR）
> - 编号 `ADR-YYYYMMDD-NNN`，按写入顺序递增。改 ADR（修正事实 / 补充后果）直接在原条目改，不要新开条目覆盖
> - 每个 ADR 控制在 5-12 行。Consequences 超过 3 条实现细节的，移到对应 `architecture/*.md`，只保留架构级后果
> - 如果 ADR 里出现函数名、DOM 事件名、CSS class 名、配置字段名，几乎一定写得太细了——这些归 architecture docs

---

## v0.4.0 — Milkdown 重构

### ADR-20260613-002: 编辑器从 Milkdown 迁到 ProseMirror + remark/unified

- **Context**: Milkdown 抽象层（`$prose` / `$inputRule` / `$remark`）遮蔽 ProseMirror 原生行为，传递依赖 96 个包冗余，`@milkdown/vue` 生命周期不够灵活。
- **Decision**: 迁到裸 ProseMirror + `remark-parse` / `remark-stringify` + 自写 mdast↔PM 转换。
- **Consequences**: 可直接用 ProseMirror 原生能力（`Decoration.widget` / `appendTransaction` / NodeView API）。失去 Milkdown 插件生态但本项目不需要。

---

## v0.4.1 — 语法实时转换

### ADR-20260615-001: 语法实时转换走 `appendTransaction` 框架

- **Context**: 旧方案每条语法各自 `InputRule`（末尾紧贴 `$` 锚），死角：反向输入不触发、粘贴不响应、块级语法（`### ` / `> ` / `- ` 等）无人接管。
- **Decision**: 单 `appendTransaction`，从 `tr.mapping.maps` 提 dirty range → 扩展到 textblock → 对每段跑 block 段首检测 + inline g 正则检测。黑名单（`code_block` / `mermaid` / `math_block` / `linkClickPluginKey.session`）由框架统一过滤。
- **Consequences**: 敲一字符 = 扫一段；新增语法 = 写一个文件 + 注册一行。`InputRule` 仅保留纯文本→纯文本快速路径。

---

## v0.4.3 — 代码块升级

### ADR-20260616-001: shiki 走 `codeToTokensWithThemes` + CSS cascade

- **Context**: highlight.js 不支持 token 级主题切换；shiki `createCssVariablesTheme` 与 VS Code 真实主题有色差。
- **Decision**: `codeToTokensWithThemes(code, { themes: { light, dark } })` → 每个 token span 写 `--shiki-light/dark` 局部 CSS 变量，`<html class="dark">` CSS cascade 翻面（零重渲）。切主题需 rebuild（hex 变了），与 darkMode toggle **正交**。
- **Consequences**: shiki 66 个主题可选，启动只装当前 2 个。

### ADR-20260616-004: dev web 端 Tauri API 统一 `isTauri()` 守门

- **Context**: `npm run dev` 调 Tauri API 同步 throw，单行 throw 让 onMounted async 链整条 reject → 后续 watch 挂不上 → 切代码主题失灵。
- **Decision**: 顶层 `const tauri = isTauri()` 同步算一次；fire-and-forget 异步走 `if (tauri)` 守门；onMounted await 链路整段包裹。persistence 模块加 `tauriOnly()`：web 端 load=null / save=noop。
- **Consequences**: 业务代码不再担心 web dev 端 Tauri API throw 阻断渲染链路。

---

## v0.4.4 — 快捷键

### ADR-20260618-002: 快捷键走 declarative registry

- **Context**: 旧方案 keymap 散落各处、命令与键位耦合、无法枚举当前键位。
- **Decision**: `editor/shortcuts/registry.ts` 单例 + `registerShortcut({ key, command, label, group })` API，命令与键位解耦。`EditorInner.vue` 仅 `import` 触发注册 + `buildShortcutKeymap()` 进 allPlugins。
- **Consequences**: 新加/改键位不碰 `EditorInner.vue`；`getShortcuts()` 一处可见所有键位。

---

## v0.4.6 — mermaid 重构 + 源代码模式 (CodeMirror 6)

### ADR-20260620-001: mermaid 迁移到 `code_block { language: 'mermaid' }`

- **Context**: 旧 `mermaid` 节点（独立 schema + textarea 编辑器）与 shiki 代码块管线是两条平行宇宙：编辑器输入 ```mermaid + Enter 产生的 `code_block` 永不渲染 SVG。A（修旧路径）已经是坏的，B（改走 code_block + SVG widget）已实现一半。
- **Decision**: 选 B。废弃 mermaid 节点，```mermaid 走 code_block 管线，由 `Decoration.widget` 扫 code_block 渲染 SVG + 自管 toolbar。
- **Consequences**: shiki mermaid 语法高亮白送；复制/查找替换/Backspace 行为与普通代码块统一；不再 atom（选区从"整块选中"变为"逐字符编辑"）。

### ADR-20260621-001: 源代码模式从 pre+textarea overlay 换成 CodeMirror 6

- **Context**: 旧 textarea overlay 需手搓行号、折行像素测量、无语法高亮。CM6 的 `lineNumbers()` + `lineWrapping` 免费覆盖，且 shiki 高亮可跨模式复用。
- **Decision**: `SourceModeEditor.vue` 独立 CM6 `EditorView`，与 PM 经 `v-if` 互斥挂载。`documentStore.content` 仍是唯一数据源，CM6 `updateListener` → emit → store → 外部 `watch` 通过 `lastSelfEmitted` echo 哨兵跳过回写。
- **Consequences**: 删旧 pre+textarea overlay + 像素测量层；源码模式获得 shiki 语法高亮（与 WYSIWYG 代码块同配色）。

### ADR-20260621-002: 跨模式光标同步走 token 序列 + LCS 对齐

- **Context**: `toggleSourceMode()` → `v-if` 互换编辑器，光标/滚动丢失。整窗 `indexOf` 子串匹配会被 CM6 侧多余的 URL/表格分隔 token 卡住。
- **Decision**: 两边 token 化（剥 markdown 标记，`|` 入集防粘），LCS 映射光标 token 到对端位置。`watch(sourceMode, cb, { flush: 'pre' })` 在卸载前抓锚点，`nextTick` 后应用。
- **Consequences**: 最佳努力语义，空文档/LCS 矩阵过大时退线性匹配。单点 watch 覆盖全部切模式入口。

### ADR-20260621-003: 查找替换走 PM/CM6 双后端抽象 + 意图上提

- **Context**: 旧版 FindReplace 写死绑 PM，源码模式整个卸载。A（提到 App.vue 跨编辑器取 view）vs B（各编辑器一份 + 后端抽象）vs C（组件内条件分支）。
- **Decision**: 选 B。`FindReplaceBackend` 接口 + `createPmBackend` / `createCmBackend` 两份实现，`v-if/v-else` 互斥。用户意图（query/选项/替换文）上提到 App.vue `provide`/`inject` 跨模式保留。
- **Consequences**: `replaceAll` 编辑器无关化（倒序遍历 matches）；两后端语义各符合所见文本（PM 搜 prose 不跨块，CM6 搜原始 markdown 可跨行）。

### ADR-20260621-004: 导出走 HTML 自包含 + 平台原生 PrintToPDF

- **Context**: 四条 PDF 路径：html2pdf.js（新依赖 + CJK 字体配置）、iframe + `window.print()`（UX 差）、Tauri `printToPdf` API（不存在）、平台原生 PrintToPDF（Typora/Obsidian 同款方案）。
- **Decision**: HTML 走 mdast walker 复用 shiki/KaTeX/mermaid/DOMPurify 渲染管线；PDF 走 Tauri `with_webview` 调平台原生 PrintToPDF（Windows `ICoreWebView2_7::PrintToPdf`，macOS/Linux 待补）。
- **Consequences**: 前端零新依赖；PDF 静默写盘无对话框，与 Typora 同款 UX。HTML image 走 `asset://`，外部浏览器打开破图（已知限制）。
- **后续更新**: 需求方放宽「必须与编辑器 / DOC / HTML 完全一致」的约束，改为「允许细微差异 + 不依赖 WebView2 + 三平台 + 体积可控」，因此**新增一条并行的** `pdf-preview` 链路：前端轻量布局器产出共享 Display List，预览直接画 DOM、导出直接序列化 PDF（`src/lib/export/pdfPreview/`），不经过 Rust / PrintToPdf。**本 ADR 的 PrintToPdf 路径继续作为默认 `PDF` 导出保留**，两者互不替代 —— 旧路径版式与编辑器最一致（Windows），新路径快、跨平台、可实时调参。选型见 ADR-20261119-001，实现见 `docs/architecture/export.md`；macOS / Linux 的默认 PDF 导出仍是 `PdfError::Unsupported`，但可从「PDF 预览」面板导出。

---

## v0.5.0 — 工作区与文件树

### ADR-20260623-001: 工作区根走 recursive 单 watch 句柄

- **Context**: A（recursive 单 watch）vs B（逐目录懒 watch，`Map<dir, UnwatchFn>`）。B 的多句柄生命周期放大 race 风险，需 per-dir 串行化队列。
- **Decision**: 选 A。工作区根单 `watch(root, { recursive: true })`，事件回调取 dirname 入脏目录集，120ms debounce flush 后按目录重拉。activeRoot 变化时先 stop 后 start。
- **Consequences**: 生命周期简单，与 documentStore 单文件 watch 同形。网络盘漏报在目录级比文件级更严重，v0.5.0 接受。

### ADR-20260623-002: 新建 `src/tauri/` 薄封装层

- **Context**: 业务代码直 import `@tauri-apps/*`，测试 mock 散落各处。v0.5.x 起 fs 调用点成倍增长。
- **Decision**: `src/tauri/{fs,dialog,path}.ts` 薄封装（re-export + `tauriOnly()` 守门），业务侧只 import 封装。封装层**不**统一错误形态——调用方各自降级（persistence 走默认值 / document.save 弹 message / imageStorage throw 透传）。
- **Consequences**: 业务代码不再出现 `@tauri-apps/*` import；测试 mock 可收敛到单一入口。

### ADR-20260623-003: capability fs scope 保持 `**`

- **Context**: "是否收紧到工作区根内"的直觉反复冒出来。A 保持 `**` vs B 自写 Rust command 校验 vs C 动态 scope（Tauri 2 fs scope 是静态 glob，技术上不可行）。
- **Decision**: 选 A。Velo 是本地单用户桌面编辑器，威胁模型是"用户主动打开的文件"，`**` 不 worsen。安全靠 UI 层 destructive op 二次确认。
- **Consequences**: 显式 ADR 留痕，避免日后"应该收紧 scope"的直觉再次被翻出来。

---

## v0.5.2 — 搜索

### ADR-20260625-001: Ctrl+P 快速打开走 JS 端 per-root 临时索引

- **Context**: 文件树 `dirIndex` 不是全量索引。A 复用 dirIndex（语义错）vs B 持久索引文件（复杂度高）vs C 内存索引。
- **Decision**: 选 C。首次打开 Ctrl+P 时 BFS `readDir` 收集 `.md`；工作区 watch 只标记 stale，不局部 patch；切工作区清缓存。
- **Consequences**: 覆盖完整工作区不受文件树展开态影响。大型工作区首次有扫描成本，后续可替换为 Rust 后端不改变 UI 契约。

### ADR-20260625-002: 全文搜索 MVP 走 JS 端实时遍历

- **Context**: A JS 端实时遍历 vs B Rust ripgrep vs C 持久全文索引。MVP 阶段选零新增依赖。
- **Decision**: 选 A。搜索面板每次 query debounce 后递归扫描 `.md`，逐文件逐行 RegExp 匹配 + 进度反馈；取消通过 run token 丢弃旧结果。
- **Consequences**: 零新增 native 依赖，发布风险低。后续性能不足可在同 UI 后替换为 Rust 后端。

---

## v0.5.5 — 侧栏

### ADR-20260626-001: 侧栏宽度持久化粒度（已被 v0.7.13 全局粒度覆盖）

- **Context**: A 全局单一宽度 vs B per-workspace vs C per-document。
- **Decision**: v0.5.5 选 B（per-workspace，READ 语义）。改为 A（全局粒度，走 `PersistedSettings.editor.sidebarWidth`），所有工作区/窗口共享一个值。
- **Consequences**: 旧 v1-v4 JSON 的 `WorkspaceState.sidebarWidth` 由启动期 `migrateWorkspacesIfNeeded` 迁移到 `velo-settings.json`（全局值优先，settings 已有 `sidebarWidth` 时不覆盖），迁移后从 workspaces JSON 中删除该字段。`WORKSPACES_VERSION` bump 到 5，`WorkspaceState.sidebarWidth` 字段从接口删除。`loadWorkspaces` / `loadFrom` 不再内联兼容逻辑，只处理当前版本格式。

### ADR-20260626-002: 侧栏双阈值 + 死区 snap

- **Context**: 单一阈值会在 collapse 边界和视觉下限之间留出瞬时值地带，导致再拖拽时 `dragStartWidth` 漂移（"线不跟手"）。
- **Decision**: A=80（collapse 阈值）+ B=200（视觉下限），[A, B] 死区不可见。`onCommit` 写 `Math.max(raw, B)`，store 永远 ≥ B；`composable` 的 `dragCollapseBelow: 80` 触发收起。
- **Consequences**: 用户看到的最小侧栏宽 = 200px。mousedown 包装层在调 `startDrag` 前先同步 store 值防 async flush 漂移。

### ADR-20260626-003: splitter 拖拽走 mousedown + window listener

- **Context**: HTML5 `draggable` 会被 Tauri webview 层截获 drag 事件，可能误触 ImageUploadPlugin。
- **Decision**: 原生 mousedown + window-level mousemove/mouseup，rAF 节流，drag 期间 body `cursor: col-resize` + `user-select: none`。
- **Consequences**: 不被 Tauri 干扰，跨平台一致。

---

## v0.5.6 — 多窗口

### ADR-20260626-004: 多窗口采用同进程多 WebView window

- **Context**: A 同进程多 WebView vs B 单窗口多标签 vs C 多进程实例。B 需要拆 `documentStore` 为多文档集合、重做 dirty close/文件树联动/标签持久化，范围远超需求；C 在文件关联/appData 写入/系统资源占用上更难控。
- **Decision**: 选 A。保留 single-instance 插件，二次启动在现有进程创建新 `velo-window-{n}` app window。主窗口 label 显式为 `main`，capability 授权 `main` + `velo-window-*`。
- **Consequences**: `documentStore`/`workspaceStore` 自然成为 per-window runtime 状态。workspace 保存改为 active root patch merge 防跨窗口覆盖；草稿 ID 带 window label scope。

---

## v0.5.10 — 源码编辑态

### ADR-20260702-001: 编辑器框架维持 ProseMirror

- **Context**: 开发反复撞到 PM 原生复杂度（atom + 内嵌 contentEditable 的 selection 不进 atom、`NodeView` 隔离与异步渲染 stale-check、`text*` inline 节点的 `textBetween` 塌缩、跨模式光标 LCS 对齐）。评估 `Tiptap` / `Lexical` / `EditorJS` 能否消除这些痛点。
- **Decision**: 留在 PM。`Tiptap` 是 PM 之上的薄包装层，5 类痛点只消化 1 类（schema 写法），且"约定优于配置"会反过来藏住其余 4 类；`Lexical` 是不同文档模型，迁移等价于重写且 Vue 集成弱于 React；`EditorJS` 是块编辑器范式，与"源码可读 WYSIWYG"目标错位。
- **Consequences**: 继续在 PM 上投入 in-house 抽象层而非换框架；`NodeView` 踩坑经验沉淀为团队资产，不随框架漂移；保留 markdown 双向管线 + 源码模式独立栈的完整控制权；后续协作编辑等强需求出现时再局部评估框架补充（非基础替换）。

---

## v0.6.0 — 编辑器多标签 + 文件菜单合并

### ADR-20260706-001: `documentStore` 从单例改为 `documents: Map<id, DocState>` 多实例化

- **Context**: Chrome 风格"单窗口多 .md 标签"需要同时打开 N 份文档，每份独立 undo / 滚动 / 光标 / dirty / lastSavedContent。A 单例 ref + 切换丢状态；B `documents: Map<id, DocState>` 多实例化（per-doc echo / autosave / view lifecycle）；C 历史栈（forward/back）只能串行浏览，并排多文件不达标。0.5.6 ADR-004 选多窗口方案时曾因"B 单窗口多标签范围远超需求"暂搁，0.6.0 重新打开。
- **Decision**: 选 B。`documentStore` 改为 `documents: Map<id, DocState>` + `activeId`，文件路径 / 内容 / lastSavedContent / lastSelfEmitted / 各种 dirty 标志全部下沉到 DocState。`currentFilePath` / `content` 等顶层 ref 改成从 activeId 取值的 getter 镜像，保外部 API 形状稳定。
- **Consequences**: 外部 component 仍按"当前文档"语义访问，顶层 getter 屏蔽多实例切换；per-doc 哨兵 / autosave / view lifecycle 实现细节沉淀到对应 architecture 模块；为后续"每窗口独立 documentStore"（与 0.5.6 ADR-004 多窗口叠加）铺路；新 API（`openPathInTab` / `openPathInNewTab` / `switchTab` / `closeTab`）取代单文档时代的"开 / 关文件"。

---

## v0.6.2 — 统一命令面板

### ADR-20260706-002: Ctrl+P / Ctrl+Shift+P 合并为前缀分发单一面板

- **Context**: v0.5.7 起 Ctrl+P（查文件）与 Ctrl+Shift+P（命令）是两个独立浮层。VSCode / Sublime / Obsidian 都用一个输入框 + 首字符前缀分发模式。A 保持两个独立面板 vs B 合并为前缀分发单一面板 vs C 单一面板但用顶部 tab 按钮切模式。
- **Decision**: 选 B。一个输入框，首字符决定模式（无前缀=文件、`>`=命令、`@`=符号、`:`=行号），剥前缀后喂给各模式自己的过滤函数；Ctrl+P / Ctrl+Shift+P 打开同一面板，仅预填前缀不同。
- **Consequences**: 新模式只需加一个前缀字符 + 一条分发分支，无需新浮层；`@` / `:` 等新模式靠前缀介绍行天然可发现。代价是首字符被前缀占用（文件名以 `>` / `@` / `:` 开头极少，可接受）；`#` workspace-symbol 同架构接入，本版暂缓。

---

## v0.7.0 — 收尾 per-user 安装体验

### ADR-20260711-001: 移除安装器残留强制默认 + 补全 Markdown 扩展名 + 加运行时控件

- **Context**: 此前已完成 MSI→NSIS 切换(per-user only,不弹 UAC)。但安装器仍有一个"将 .md 设为默认使用 Velo 打开"checkbox —— 用户不勾选也会在后台改写默认关联,与 per-user 定位不符;右键菜单仅覆盖 3 个扩展名(.md/.markdown/.mdown),无法惠及 .mkd/.mdtext 等常见 Markdown 变体用户;且安装时没勾选右键菜单的用户之后也无法在运行时重新开启。需要一个既能收掉残留强制默认、又能让用户在装好之后仍可自选的方案。候选:A 保留"设默认"checkbox(简单但残留强制);B 移除 checkbox 并禁止安装时改写默认,改为运行时在主设置面板提供三个控件 + 补全 8 个扩展名;C 仅移除 checkbox,不加运行时控件(用户装完就定型)。
- **Decision**: 选 B。安装器 sandbox 再收紧 —— 删除"设默认"checkbox,禁止安装阶段改写 .md 默认关联(不强拆已有,也不强加于人);ProgID `Velo.md` 仍注册进"打开方式"列表,但默认权交给用户自己在 Windows 设置里点;设置面板新增"Windows 集成"分组,提供"设为 Markdown 默认程序 / 文件夹右键 / .md 右键"三个运行时控件,装完还能改;右键覆盖扩展名从 3 个扩到 8 个(.md .markdown .mdown .mkd .mkdown .mdwn .mdtxt .mdtext),与 GitHub Linguist 公认全集对齐。
- **Consequences**: 安装器彻底 opt-in —— 不再强改默认、不再强加右键;运行时控件让装时没勾的用户后来也能随时调整,不再"一装定终身";扩展名覆盖与主流 Markdown 生态对齐(用户用 .mkd/.mdtext 等变体也不再漏挂右键)。代价:用户若真想把 Velo 设默认,需要自己在 Windows 设置里多点一下(这是取舍本身,不是缺陷)。

---

## v0.7.1 — 表格编辑

### ADR-20260717-001: 表格操作统一走整表 `replaceWith`

- **Context**: 表操作(增删行列 / 列对齐 / 行/列移动)需要把新 doc 写回。A 逐 cell `setNodeMarkup` / 局部 step；B 整表 clone + splice + `replaceWith(tablePos, tablePos + oldTableSize, newTable)`。`prosemirror-tables` 官方推荐 A，但我们的 schema 定制过（`table_header_row table_row*` + `isolating: true`），A 路径在 GFM 对齐列时会让 `toMarkdown` 从首行推导 `align[]`，列内值不一致就 round-trip 跳变；B 路径整表一次性替换，`markdownIO` 把新表整体序列化，天然闭合。
- **Decision**: 选 B。所有表操作命令统一签名 `cmd(schema, anchorPos?) => ShortcutCommand`，splice 后整表 replaceWith + 光标定位补丁（`dispatchReplaceWithCursor`）。矩形批量语义（rect.top/rect.bottom/rect.left/rect.right 锚外边界）沿用同套路。
- **Consequences**: 表操作 undo 粒度 = 整笔替换（非逐 cell），可接受；markdownIO round-trip 闭合，列对齐 / 增删行列 / 移动全部零额外适配。**后续表功能（列宽持久化 / 表头行开关等）强制复用此范式**，新增命令 = 写一个文件 + 注册一行，不引入第二条写回路径。

### ADR-20260717-002: CellSelection 剪贴板走 tab 分隔文本 + HTML 路径 TSV 重建

- **Context**: CellSelection 复制 / 粘贴需要"矩形块"语义(列对齐 / 整块填充),但 PM 默认 `clipboardTextSerializer` 用 `textBetween` 把 cell 文本用 `\n\n` 连接 —— 粘贴到 Excel 时所有 cell 挤成一列,行列结构丢失。候选:A 沿用 PM 默认(简单但行列错位);B 自定义 `clipboardTextSerializer` 输出 tab 分隔列 + 换行分隔行(对齐 Excel/Sheets 粘贴格式),`clipboardTextParser` 在表格内把 tab 文本解析回 `table_row` slice 走 `pastedCells` 整块填充。
- **Decision**: 选 B。`clipboardTextSerializer` 仅对 CellSelection 的 rows slice(openStart=1/openEnd=1 + 首子节点 `tableRole='row'`)生效,其他选区返回 undefined 走 PM 默认;`clipboardTextParser` 仅在 tab/换行存在且光标位于 `table_row` 内时重建 slice,纯单行 / 非表格上下文返回 null 走默认。含表头列粘贴时按目标行类型选 `table_header` / `table_cell`,避免破坏 schema 结构。
- **Consequences**: Excel / Sheets / 浏览器跨应用拷贝表格保持行列结构。HTML 路径粘贴存在 DOMParser context 剥离坑（`table_cell` context 下 `<tr>`/`<td>` 被剥离 → `pastedCells` 返回 null → 1×1 fallback 错乱），需 `tableCellInputGuardPlugin` 在 `tableEditing` 之前注册拦截并走 TSV 重建修复。实现细节见 `architecture/editor.md`。

---

## v0.7.2 — 编辑器语法增强

### ADR-20260717-003: 折叠占位符从 Decoration.widget 改为真实 inline atom 节点

- **Context**: 折叠后的 `...` 占位符原为 `Decoration.widget`，widget 的 `side` 属性只能让光标停在一侧（`side:0` 停前 / `side:1` 停后），无法实现"光标自然停在两侧"；widget 不参与 PM selection model，鼠标划选无法覆盖 `...`（浏览器选区绕过 widget），导致选中后删除只能删到占位符边界而非整块折叠内容。候选:A 保持 widget（接受光标 / 选区限制）；B 改为真实 `fold_placeholder` inline atom 节点（光标 / 选区 / 删除全部走 PM 原生语义）。
- **Decision**: 选 B。schema 新增 `fold_placeholder` 节点（`inline` / `atom` / `selectable:false`），折叠 / 展开时由 `appendTransaction` 插入 / 删除节点到折叠点末尾 inline 位（`addToHistory:false` 不进 undo），`toMarkdown` 跳过（不污染 markdown round-trip）。`appendTransaction` 用 `nodeSync` meta 防无限循环，逆序扫描保持位置稳定。点击 `...` → `handleClickOn` 展开（选区为空时触发，拖选后不误触发）；划选覆盖 → `Decoration.node` 挂 `is-selected` 高亮；Backspace / Delete → `foldDeleteCommand`（排在 keymap 链首）把删除范围扩展到折叠节点起点 ~ range[1]（整块删除）+ 从 collapsedSet 移除。
- **Consequences**: 光标可自然停在 `...` 两侧、鼠标划选可覆盖、选中后删除连同折叠内容整块删除——三项交互全部走 PM 原生语义，无 widget 限制。代价:`appendTransaction` 必须严格防循环（nodeSync meta + 扫描逻辑幂等）；`fold_placeholder` 节点不计入 markdown round-trip（`pmInlineToMdast` 跳过），测试中的位置查找需考虑节点插入导致的偏移。后续折叠相关交互（如拖拽折叠块）基于真实节点实现，不再受 widget 约束。

### ADR-20260717-004: 块级 HTML 源码编辑走 code_block 替换（非 NodeView textarea）

- **Context**: html_block 是 atom 节点（`contentEditable=false`），编辑其源码需要一个文本编辑面。候选:A NodeView 内嵌 textarea（math_block 范式）vs B 点击按钮把 html_block 替换成 `code_block { language:'html' }`（有 contentDOM 的普通可编辑节点）。A 的致命坑:PM 对 atom 节点自动设 `contentEditable=false`，dom 嵌在 `view.dom`（`contentEditable=true`）内；用户点击 textarea 时 mousedown 冒泡到 `view.dom`，虽然 `stopEvent:()=>true` 让 PM JS handler 提前返回，但**浏览器原生 contenteditable 行为仍被触发**（尝试在 view.dom 放光标）→ textarea 失焦 → blur → 误退出编辑 session。`stopEvent` / `stopPropagation` 都不防浏览器原生 contenteditable 焦点抢夺。
- **Decision**: 选 B。点击按钮 dispatch 把 html_block 替换成 code_block（有 contentDOM），用户在 code_block 内编辑是 PM 原生行为，点击 / 拖选 / IME 全部正常，彻底绕开 `contentEditable=false` 问题。session 由 `htmlSourceEditPlugin` 管理（同 html_inline / imageEdit 范式：光标移出 commit / Escape 还原）。code_block `{ code:true }` 天然保留换行，Enter 只换行不拆段。
- **Consequences**: 无 textarea 焦点问题，编辑体验与普通代码块一致。代价:html_block ↔ code_block 替换是整节点替换（非原地编辑），视觉上有一次"闪烁"切换。**后续任何"atom 节点需要源码编辑"场景优先评估 code_block / 纯文本替换方案，不走 NodeView textarea**（除非节点内容不含换行且可安全替换为 inline 文本，如 html_inline）。

---

## v0.7.6 — 大文档性能优化

### ADR-20260729-001: ProseMirror 装饰管线从全量重建改为增量 + 视口感知

- **Context**: WYSIWYG 模式在 5000+ 行文档下卡顿，根因是 6+ 个 decoration 插件每次 transaction 都全量 `doc.descendants()` 遍历 + 全量重建 DecorationSet。候选:A 保持全量重建但加 debounce（治标不治本，大文档单次遍历仍慢）；B 增量更新 DecorationSet（从 `tr.steps` 提取 dirty range，只对变动区域重建）+ 视口感知（只为可见区域构建装饰）；C 移入 Web Worker（架构改动大，echo 哨兵需异步化）。
- **Decision**: 选 B。三层组合：① `docScanCache.ts` 单次遍历收集所有装饰目标节点（doc 对象身份做缓存键，零开销命中），从 7 次全量遍历降到 1 次；② `incrementalDeco.ts` 从 `tr.steps` 提取 dirty range，plugin state 缓存 DecorationSet，docChanged 时 map 旧 set 平移 pos + 只对 dirty range 重建 add/remove，selection-only 返回同引用让 PM 跳过 diff；③ `viewportPlugin` 跟踪可见 doc pos 范围，装饰构建时只为视口内节点创建，滚动时增量补充。KaTeX NodeView 用共享 `IntersectionObserver` 延迟渲染。fold 的 `velo-folded` node decoration 始终全量（折叠状态需全局一致）。
- **Consequences**: 大文档浏览 / 编辑性能显著改善，主线程开销大幅降低。代价:增量更新逻辑复杂（`StepMap.forEach` 提取 dirty range、fold 特殊回退全量重建），后续新增 decoration 插件需遵循增量范式。C1（Web Worker）已在 v0.7.8 实现（见 ADR-20260806-002）。

---

## v0.7.8 — 大文档打开性能 + 文件树性能

### ADR-20260806-001: 大文档打开链路优化（pendingPmDoc + canonical skip + 延迟 parse + loading 遮罩）

- **Context**: 5000+ 行文档打开延迟数秒。打开链路 3 次同步 markdownIO 调用（`fromMarkdown` × 2 + `toMarkdown` × 1）阻塞主线程 ~0.8–2s，加 `EditorState.create` ~200–500ms。候选:A 仅优化同步 parse（治标不治本，大文档单次 parse 仍阻塞）；B 消除冗余 parse + 跳过 canonical + 延迟 parse + loading 遮罩（分步减负 + 感知改善）；C 全部移入 Worker（C1 另独立 ADR，此 ADR 不含）。
- **Decision**: 选 B。`pendingPmDoc` 字段让 `fromMarkdown` 结果跨组件共享，消除第二次 parse（3→2 次）；> 2000 行跳过 `toMarkdown(fromMarkdown(c))` 规范化（2→1 次，非 canonical 文件 dirty 不归零——可接受边缘）；> 2000 行延迟 `fromMarkdown` 到双 rAF 后执行，先 paint loading 遮罩再阻塞；`foldDecoration` 的 `collectFoldableKeys` 延迟到 fold dispatch 时。
- **Consequences**: 大文档打开 markdownIO 3→1 次；loading 遮罩让用户立即看到反馈而非冻结。canonical skip 的代价（CRLF/多余空行文件 type+delete dirty 不归零）是可接受的边缘问题，`checkExternalChange` 的 canonical fallback 不受影响。后续 C1 Worker 在此基础上进一步将剩余 1 次 parse 移出主线程。

## v0.7.9 — Emoji 短码 + 应用自动更新

### ADR-20260808-001: 应用自动更新走 Tauri Updater plugin + Ed25519 自签名

- **Context**: 桌面应用需要自动更新通道让用户及时获取新版本。候选:A Tauri Updater plugin(内置,支持签名验证 + NSIS 静默安装 + relaunch);B 手动检查 GitHub Release API + 下载提示(无需签名,但无安装自动化 + 无完整性校验);C 第三方更新框架(electron-updater 等,不适用 Tauri)。
- **Decision**: 选 A。Tauri 2 Updater plugin(`tauri-plugin-updater`) + Process plugin(`tauri-plugin-process`,relaunch 用)。签名密钥用 Ed25519 自签名(`tauri signer generate`),免费;私钥存 CI GitHub Secret,公钥写 `tauri.conf.json`。CI 中 `tauri-action` 自动签名更新包 + 生成 `latest.json` 上传到 Release,`updaterJsonPreferNsis: true` 让 Windows 走 NSIS。前端走 `useUpdater` composable:启动后 10s 静默检查,有更新走 Toast 提示用户去设置页手动下载(不自动下载,避免打断编辑);设置页提供「检查更新」按钮 + 下载进度条 + 一键安装重启。网络错误在静默模式下静默处理(中国大陆直连 GitHub 不稳定),15s 超时快速失败。
- **Consequences**: 免费获得完整的自动更新通道(签名验证 + 静默安装 + 重启),发版流程零额外手动步骤(CI 自动签名 + 生成 latest.json)。Ed25519 签名与 Windows 代码签名证书是两回事——updater 不依赖后者,代码签名证书消除 SmartScreen 警告需另购(见 ROADMAP `#code-signing`)。网络不可达时静默降级,不影响正常使用。

---

## v0.7.8 — 大文档打开性能 + 文件树性能

### ADR-20260806-002: Markdown 解析移入 Web Worker（parse-only 方案）

- **Context**: C0–C3 优化后，大文档打开仍有 1 次 `fromMarkdown` 同步阻塞 ~2.8s（217KB / 6967 行）。候选:A 全移入 Worker（parse + serialize），mdast JSON 序列化开销大且 echo 哨兵需全异步化；B parse-only Worker（remark-parse + runSync 在 Worker，mdast→PM Node 转换留主线程），序列化开销小且转换无正则/解析；C 不用 Worker，继续优化同步（已无显著空间）。
- **Decision**: 选 B。remark-parse + runSync 在 Worker 里执行，mdast→PM Node 转换（纯树遍历，无正则）留主线程。`parseToken` 带 AbortSignal + 10s 超时降级到同步 parse；viewport hint 预设首屏范围，`updateState` 只为首屏节点构建 decoration。竞态防护：parseToken 在分支前 bump + 冷启动 state 引用守卫。
- **Consequences**: 主线程阻塞从 ~2800ms 降至 ~458ms（6x 提速），Tauri 生产构建 Windows WebView2 验证通过。Worker 通信为小文档增加微延迟（冷启动同步 fallback 覆盖）。echo 哨兵机制需适配异步 parseToken（bump + 引用守卫），后续若 serialize 也成瓶颈可按同范式加 Worker。

---

## v0.8.0 — 不实现 Git 集成，远期转向 Coherence Layer

### ADR-20260810-001: 放弃用户面向的 Git 集成面板，远期转向 Coherence Layer

- **Context**: 引入传统 Git 面板。候选:A 保留 Git 面板（服务程序员用户，但多数 Markdown 写作者不用 git，且 git commit 粒度适合代码不适合写作）；B 引入 Coherence Layer（内容寻址版本追踪 + DAG + 人类/AI/外部溯源，解决"共编同一文档"的溯源与并发问题）；C 两者并行。
- **Decision**: 选 B。移除 Git 面板。`#local-timeline`（本地版本时间线）保留为非 AI 场景的版本历史方案。`#ai-assist`（P3）排期时评估 Coherence Layer 作为基础设施层。
- **Consequences**: ROADMAP `#git-integration` 标记为不再实现；`#local-timeline` / `#recent-locations` 解除对 `#git-integration` 的依赖；需要 git 的用户可使用外部工具（git CLI / GitKraken / GitHub Desktop）。Coherence Layer 是重型基础设施，在 AI 集成落地前不提前投入。

---

## v0.7.10 — 工程门禁 + 插件解析器

### ADR-20260813-001: 依赖分层约束走 dependency-cruiser

- **Context**: Velo 已增长到 10 store / 27+ 插件文件 / 82+ 测试文件，无分层约束迟早出循环依赖（已踩 useProseMirror ↔ viewportPlugin 循环引用）。候选:A eslint-plugin-import（模式匹配有限，无法做拓扑分析）；B dependency-cruiser（专为依赖图分析设计，支持自定义规则 + 拓扑排序）；C 纯人工 review（不可持续）。
- **Decision**: 选 B。`.dependency-cruiser.cjs` 定义 5 条规则（no-circular / leaf-no-upper / stores-no-ui / tauri-no-upper / no-orphans），分层覆盖 `src/lib`(L0 纯叶) ← `src/tauri`(L1) ← `src/stores`(L2) ← `src/components`/`composables`/`directives`/`utils`(L3)。白名单 4 项豁免（htmlRenderer/shikiHtml 复用编辑器 remark 插件链、document/editor store 依赖 markdownIO/schema），每项带 TODO 注释重构方向。
- **Consequences**: 所有新代码必须遵守分层边界，循环依赖在 CI 阶段被拦截。白名单项是已知技术债，后续重构时逐项消除。

### ADR-20260813-002: 插件加载顺序从隐式数组改为规范列表 + 解析器校验

- **Context**: `allPlugins` 数组顺序是隐式契约——"数组位置即加载顺序"，27+ 插件下越来越脆：增删插件时依赖关系（如 tableEditing 需在 columnResizing 之后）无校验，数组物理顺序与逻辑顺序耦合。候选:A 保持数组顺序（无校验，漂移无感知）；B 显式声明（PluginEntry 含 id + requires）+ 规范列表 + 解析器校验；C 自动发现（扫目录推断依赖，太隐式难调试）。
- **Decision**: 选 B。`plugins/order.ts`（CANONICAL_PLUGIN_ORDER 规范列表，按功能分组注释）是加载顺序唯一真相源。`resolvePlugins` 做 4 道校验（重复 id / 集合相等 / requires 存在 / requires 满足）后按 canonical index 排序。`EditorInner.vue` 的 `pluginEntries` 物理顺序无关，仅供代码组织。
- **Consequences**: 新增 / 删除插件必须同时更新 `order.ts`，否则解析器抛集合不匹配错误（fail-fast）。插件依赖关系显式化（`requires` 字段），物理数组顺序与逻辑加载顺序解耦。

---

## v0.7.11 — 更新卡片日志来源 + 签名模式切换

### ADR-20260817-001: 更新卡片日志来源从 GitHub Release body 改为 fetch RELEASE_NOTES.md

- **Context**: 更新卡片展示的变更日志原取自 GitHub Release body（release-please 自动生成的英文 commit 流水账），与面向用户的中文版本日志 `docs/RELEASE_NOTES.md` 内容割裂。候选:A 保持 release.body（零额外请求，但内容是英文 commit 摘要，用户难读）；B fetch GitHub raw `docs/RELEASE_NOTES.md` 全文 + 正则提取目标版本段落（中文、面向用户，但需额外网络请求 + 降级 fallback）；C 在 release.body 中手动写中文日志（发版时双写，维护成本高且容易忘）。
- **Decision**: 选 B。`useUpdater` 中 `fetchReleaseNotes` 从 GitHub raw 抓取 `RELEASE_NOTES.md` 全文，正则提取 `## [X.Y.Z]` 到下一个版本标题之间的段落；fetch 失败或找不到对应版本时降级回 `release.body`。dev 环境走 Vite proxy `/github-raw` 避免 CSP 跨域拦截。渲染走轻量 `lib/renderMarkdown.ts`（`createParseProcessor()` parse → 极简同步 walker → `sanitizeHtml` DOMPurify 洗），不走 `htmlRenderer.ts` 那套重管线。
- **Consequences**: 更新卡片始终展示中文用户面向日志，与 `RELEASE_NOTES.md` 单一真相源对齐。代价：多一次网络请求（15s 超时 + 降级 fallback 兜底）；`RELEASE_NOTES.md` 的版本标题格式 `## [X.Y.Z]` 成为隐式契约，正则提取依赖此格式。

### ADR-20260817-002: 更新包签名模式从 v1Compatible 切换为 direct signing

- **Context**: Tauri updater 的 `createUpdaterArtifacts` 有两种签名模式。v1Compatible 模式生成 `.nsis.zip` + `.nsis.zip.sig`（先压缩再签名）；direct 模式（`"createUpdaterArtifacts": true`）直接签名 `.exe` 产出 `.exe.sig`，不再生成 `.nsis.zip` 中间产物。候选:A 保持 v1Compatible（兼容旧路径，但多一层 zip 包装，签名验证对象是 zip 而非 exe）；B 改为 direct signing（直接签名 exe，tauri-action 自动适配 `unzippedSigs=true` 优先读 `.exe.sig`）。
- **Decision**: 选 B。`tauri.conf.json` 中 `createUpdaterArtifacts` 从 `"v1Compatible"` 改为 `true`。Tauri 直接签名 `.exe` 产出 `.exe.sig`，tauri-action 检测到 `unzippedSigs=true` 后自动优先使用 `.exe.sig` 生成 `latest.json`。
- **Consequences**: 不再生成 `.nsis.zip` 中间产物，签名链路更简单（签名对象 = 最终安装文件本身）。tauri-action 自动适配，无需额外配置。后续版本更新流程不变。

---

## v0.7.12 — 版本历史 Git 集成 + Hot Exit

### ADR-20260823-001: Git 历史作为版本历史面板数据源融入，不做独立 Git 面板

- **Context**: ADR-20260810-001 放弃了用户面向的 Git 面板。但写作用户在 Git 仓库中的文件仍缺少 commit 级别的历史浏览能力。候选:A 独立 Git 面板（commit list / diff / branch 视图，功能重且多数写作者不用 git）；B 把 Git commit 历史作为版本历史面板的额外数据源融入（本地快照 + Git commit 混合时间线，轻量，复用已有 diff UI）；C 不做（用户自行用外部 git 工具）。
- **Decision**: 选 B。Rust 后端 `git.rs` 提供 `git_repo_root` / `git_file_history` / `git_show_file` 三命令（`std::process::Command` 调系统 git），前端 `src/tauri/git.ts` 封装。`versionHistory` store 将 Git commit 与本地快照合并为统一 `TimelineEntry[]` 按时间排序，`VersionHistoryPanel` 用视觉标识区分来源。Git 条目仅支持查看 diff，不支持「恢复此版本」。非 Git 仓库静默降级为纯本地快照。用户可开关 Git 历史加载。
- **Consequences**: 用户在版本历史面板统一浏览本地快照 + Git commit，无需独立面板。ADR-20260810-001 的"不做 Git 面板"结论不变——本方案是版本历史的数据源扩展而非 Git 管理工具。Git 条目的 diff 语义与本地快照一致（与前一版本对比）。缓存 key 含文件路径防跨文件污染。后续若需完整 Git 管理功能（branch / commit / push）仍走外部工具。

### ADR-20260823-002: Hot Exit 走 per-workspace 草稿 + 静默恢复

- **Context**: 编辑器异常退出后用户未保存内容丢失。候选:A per-doc 草稿（每文档独立草稿文件，恢复时逐文档匹配）；B per-workspace 草稿（按工作区目录隔离，启动恢复在该工作区的标签集内静默完成）；C Dialog 提示恢复（用户选择是否恢复）。
- **Decision**: 选 B。脏盘每 30s 写草稿到 `appDataDir/drafts/{workspaceKey}/{id}.json`，workspaceKey = `encodePathAsId(workspaceRoot)`。启动时 `loadContentIntoTabs` 并发查草稿，有草稿则用草稿内容装载 + 设磁盘基线让 `dirty=true`，并删除已消费草稿。无 Dialog，无中断（同 VSCode Hot Exit 语义）。无 workspace 时用 `_no_workspace` fallback key 覆盖"只打开文件没开工作区"的场景。`pagehide` 同步落盘防 debounce 未触发。
- **Consequences**: 用户异常退出后重启自动恢复未保存内容，零交互成本。草稿按工作区隔离，A 工作区的草稿不在 B 工作区恢复。草稿 ID 简化为 `file-{encodePathAsId(path)}` / `untitled-{docId}`，无 window scope——多窗口隔离由 per-workspace 目录天然保证。草稿与版本快照分工明确：草稿是 dirty 期间定时落盘的崩溃恢复手段（写盘成功后清除），版本快照是保存点的只读归档。

## v0.7.13 — 持久化迁移

### ADR-20260901-001: 启动期一次性迁移替代内联兼容代码

- **Context**: 随着版本迭代，`loadWorkspaces` / `loadSettings` / `loadFrom` / `hydrateSettings` 中堆积了越来越多的旧版本兼容逻辑（接受 v1-v4 JSON、`darkMode` → `themeMode` 迁移、`'system'` 字体值转换、`fontFamily` 废弃字段处理等）。每次新增字段或迁移时都在 load/hydrate 路径加 `if/else`，代码膨胀且难以维护。候选:A 继续在 load 函数中内联兼容（现状，兼容逻辑只增不减）；B 启动期一次性迁移旧配置文件到当前版本并写回磁盘，之后 load 函数只认当前版本；C 安装新版本时跑迁移脚本（不适用于 Tauri 免安装更新）。
- **Decision**: 选 B。App.vue `initSettings()` 在 `loadSettings()` / `loadWorkspaces()` 之前调 `migrateSettingsIfNeeded()` + `migrateWorkspacesIfNeeded()`，逐级迁移链（v1→v2→…→vN）把旧版本配置文件升级到当前版本并写回磁盘。之后 `loadSettings` / `loadWorkspaces` / `loadDraft` 只认当前版本号，不兼容旧版本。`hydrateSettings` 删除 `darkMode` / `fontFamily` / `'system'` 字体值的内联迁移逻辑。`migrateWorkspacesIfNeeded` 的 v4→v5 迁移做跨文件操作：从 active workspace 提取 `sidebarWidth` 写入 `velo-settings.json`（全局值优先），然后从 workspaces JSON 中删除该字段。
- **Consequences**: load / hydrate 路径干净，只处理当前格式；旧版本兼容逻辑集中在一处（migration 函数），后续新增版本只需加一级迁移步骤；用户无感知（启动时静默完成）。迁移失败不阻塞，load 走默认值继续。代价:每次启动多一次文件读 + 可能一次写（已迁移后 no-op，只读一次确认版本号）。

### ADR-20260905-001: 数学公式解析从 remark-math 迁移到自写 strictMath 插件

- **Context**: 旧方案用 `remark-math` + `remarkMathFenceGuard`（预处理 `$$` 行首后跟正文的情况），配合 `TextareaEditor` 管理 math_block 的 textarea 编辑壳。三层问题：① remark-math 对围栏 `$$` 的解析过于宽松（接受 `$$meta` 作 flow math 开头、EOF 自动闭合），围栏守卫只能做文本预处理拦截部分边界情况，无法覆盖所有残缺模式；② 数学内容含换行时 PM 与 mdast 的文本基准不一致，emphasis/marker 注解从首个改写点起整体错位。候选:A 保持 remark-math + 围栏守卫 + 修补边界 case（治标不治本，围栏守卫永远追不上 remark-math 的宽松解析）；B 自写 strictMath 插件（`mathFlow` + `mathText`）替代 remark-math，严格匹配 `$$\n...\n$$` 围栏与 `$...$` 行内，删除围栏守卫，同时 math_block 从 atom+textarea 改为 `content:'text*'` + contentDOM 让 PM 接管编辑；C 走 micromark 插件替代 remark-math（生态小，调试困难）。
- **Decision**: 选 B。strictMath 的 `mathFlow` 插件在 remark-parse 的 flow 阶段用严格围栏正则匹配 `$$` 独占行，`mathText` 在 inline 阶段匹配 `$...$`，不再依赖 remark-math 的宽松规则。`remarkMathFenceGuard.ts` 删除（其职责由 strictMath 的严格匹配自然覆盖）。math_block schema 从 atom+textarea 改为 `content:'text*'` + contentDOM，`TextareaEditor.ts` 删除。markdownIO 按 `\n` 拆分 mdast text 节点为 PM text + hardbreak 序列，hardbreak 节点新增 `hard` 属性区分软/硬换行。
- **Consequences**: 数学公式解析管线从三层（remark-math + 围栏守卫 + textarea 编辑壳）简化为一层（strictMath + PM 原生编辑），围栏守卫的边界 case 永久消除。strictMath 的严格匹配意味着不符合围栏规则的 `$$` 不会被解析为数学块（如 `$$meta`），用户需写规范围栏。hardbreak `hard` 属性为未来区分软/硬换行提供扩展点。实现细节（strictMath 两阶段匹配、math_block 降级光标 clamp、block 语法实时转换 mathBlockSyntax、mathBlockEnter 命令）见 `architecture/editor.md`。

---

## v0.7.14 — Diff 功能升级

### ADR-20261107-001: 双模式 diff 各自独立比对，不共用同一份结果

- **Context**: 源码 diff 以 markdown 行序列对齐，预览 diff 以富文本顶层 block 序列对齐（block 的 key 含节点类型 / attrs / 文本 / 格式 / 容器结构）。初版规划让两种模式共用一份比对结果，切换时零重算。候选:A 共用同一份结果；B 各按自己的粒度独立比对，切回预览时重建只读编辑器视图并重新解析比对。
- **Decision**: 选 B。两个序列不同构，共用只能把一方结果摊到另一方，会丢掉格式变更 / 节点类型变更 / 非文本节点删除等结构化语义。代价是切回预览需重建只读视图并重解析两版 markdown（2000 段约 300ms，绝大部分耗在解析）。
- **Consequences**: 两种模式可独立演化（源码加字符级高亮、预览加语义化渲染互不牵制）；切换预览有可感知开销，后续若保留视图实例即可消除，无需改动比对层。

### ADR-20261107-002: 结构化 diff 走事后文档树比对，不引入操作日志

- **Context**: 本地快照只存每版 markdown 全文，没有操作日志与 per-block 作者数据。候选:A 把两版文档拍平成纯文本做行级 diff（初版做法）；B 事后解析出两份富文本文档树，按顶层 block 序列结构化比对并分类变更；C 引入 OT/CRDT 操作日志或按作者着色。
- **Decision**: 选 B。A 让格式 / 节点类型 / 图片等非文本节点变更不可见，段落拆分误报为删行加行、表格结构变更乱码；C 要为单用户本地编辑器引入操作日志与作者数据，投入产出比极低。B 的语义分类覆盖文本修改 / 纯增删 / 同文异 key / 段落拆分合并，表格另按二维网格对齐让被删行列独立成幽灵单元。
- **Consequences**: diff 能表达富文本语义变更，但依赖两次全文解析，大文档必须配合视口感知的装饰构建；任何新节点类型要能被看见，前提是它的结构进入了 block key。

### ADR-20261107-003: diff 标记走线条语义而非底色 / 左竖条

- **Context**: 预览 diff 要在既有富文本排版流上叠加增删标记。候选:A 纯背景色；B 左侧竖条 + 背景；C 线条语义（新增绿色整框 / 下划线、删除删除线 + 灰度、格式 / 类型琥珀点线）。
- **Decision**: 选 C。底色会切碎排版流、被代码块 / 表头自身背景盖掉；左竖条与引用块 / 警告框自带彩条撞脸；删除线只作用于删除片段，不与正文的删除线语法混淆。连续新增块改由容器级 overlay 画一个整框，而非逐块边框拼接——插入的删除片段会打断兄弟链，视口增量构建也会让 CSS 推断的「组首」随滚动漂移。
- **Consequences**: 亮 / 暗两套各自维护线条色值，标记与 markdown 自身视觉语义不冲突。代价:琥珀点线只能提示「这里有变更」，看不出具体改了什么，补强列入后续体验项。

### ADR-20261107-004: 自动保存快照合并下沉到磁盘持久化层

- **Context**: 5 分钟滑动合并窗口原在 store 判断，依据的内存缓存只在用户打开版本历史面板时才填充；面板未打开 / 重启 / 换文件期间合并静默失效、磁盘堆积碎片快照。候选:A 在 store 预热缓存 / 每次保存读盘填缓存；B 把判断下沉到持久化层，一次读盘内完成判断 / 删旧 / 写新 / 修剪，store 只传触发条件；C 在 UI 层再引入 2 分钟分组把碎片折叠展示。
- **Decision**: 选 B。A 只是把「内存与磁盘两份状态」的问题挪个位置；C 与磁盘层合并语义重叠，且「累计 +/-」与逐条 diff 基准不可加（有删改时逐条相加 ≠ 组内首尾一次性比对）。B 让合并与写盘落在同一临界区，不依赖任何 UI 状态。
- **Consequences**: 合并不再受面板是否打开影响，快照生命周期由持久化层单独负责，store 与 UI 只传触发条件。原先规划的「短时间 diff 条目合并展示」由缺陷修复替代，不再实现。

---

## v0.7.15 — 首屏零闪烁

### ADR-20261110-001: 首屏主题同步定色 + 窗口延迟显示，不走「先显示再纠正」

- **Context**: 大目录打开卡顿修掉后启动变快，首屏反而显出两次「白→深→浅」闪烁：窗口在 WebView 首帧之前就可见，露出导航期默认白底；主题偏好要等异步读盘才生效，期间整页深浅色翻面。候选：A 保持立即显示、加一层过渡遮罩；B 主题偏好走同步轻量镜像定色，窗口隐藏到首帧再显示；C 把设置读盘改成同步 IPC。
- **Decision**: 选 B。磁盘配置仍是权威数据源，镜像只用于让首帧与最终主题一致、并在读盘成功后回写；窗口由 Rust 隐藏创建，前端首帧渲染完请求显示，Rust 侧兜底防前端异常导致窗口不出现。
- **Consequences**: 首帧即最终颜色，白底帧被窗口隐藏吃掉，异步读盘不再翻面。代价是多一份需与磁盘同步的镜像（外部改动以读盘结果为准），窗口显示多等一次设置读盘；内容守门期仍是纯色空容器，骨架占位留作后续体验项。

---

## 未发版 — 工作区索引选型（#workspace-index 未实现）

### ADR-20261113-001: 索引层 extractor 选 pulldown-cmark + rayon 下沉 Rust，不选 markdown-rs

- **Context**: `#workspace-index` 索引层选型实测（2026-07-22，i5-1135G7 4C8T，release+LTO；JS 侧经 tsx 直 import 真实 `createParseProcessor()`；三方提取计数完全一致）。5k 文件全量扫描：JS 完整管线 24.5s / markdown-rs 串行 5.3s / markdown-rs+rayon 1.2s / pulldown-cmark+rayon **0.18s**；3KB 单文件增量：JS 3.7ms / markdown-rs 0.7ms / pulldown 0.013ms。markdown-rs 与 micromark 同源同算法，Rust 只带来常数级收益（2–4×），中文重度语料超线性劣化：1MB 单文件 parse 2.2s 与 JS 持平（`to_html`≈`to_mdast`，瓶颈在解析器而非 AST 构建）；pulldown 事件流（无 AST、零拷贝借用原文）1MB 6.5ms，是数量级差异的来源。
- **Decision**: 索引层用 pulldown-cmark + rayon 下沉 Rust（全量 scan + 单文件增量 extract 两 command，walker 复用已落地的 `workspace.rs`），JS 只消费索引结果；markdown-rs 不进索引层，仅将来出现「Rust 侧完整 mdast」真实需求（导出 / lint）时重评并复跑大文件基准；编辑器 parse/serialize 保持 unified 不动（往返保真是正确性问题，不是性能问题）。
- **Consequences**: 5k 文件索引就绪 <0.2s，「保存即索引」无需 debounce 兜底性能；代价是语法双源（索引 pulldown vs 编辑器 unified）需共享对齐测试集，pulldown 无 frontmatter/wikilink 原生支持需自写。实现期第一优先验证 IPC 序列化成本（5k 索引明细几 MB 可能反超解析：先回传摘要 / 增量 diff / 明细按需查询）。本 ADR 即「不选 markdown-rs」的实测证据留痕（原调研文档已删，结论与数据以本条为准）。

---

## v0.7.16 — DOCX 导出选型

### ADR-20261114-001: DOCX 导出走 docx.js `htmlToContent`，不引入 pandoc / mdast2docx

- **Context**: Velo 需要 DOCX 导出（`#export-more`）。候选实测：pandoc CLI（约 150MB × 三平台，与轻量定位冲突）、mdast2docx（mdast 直出、架构纯粹，但丢失全部 CSS 样式）、docx.js `htmlToContent`（复用现有 HTML，保真最高）、ferrodoc（公式与 Velo 自定义语法缺失）、knit-md-docx（功能全但需进 `src-tauri` 且依赖 fork）。
- **Decision**: 用 `docx` + `htmlToContent`，复用 `htmlRenderer` 的 HTML + 内联 CSS，新增「自包含」模式（图片读成 data URI、mermaid SVG 用 canvas 光栅化成 PNG）；store 增加 Word filter 与写盘分支。
- **Consequences**: 零外接二进制，保真度最高（CSS / 语法高亮 / alert / 公式 / 脚注 / 内部锚点都保留）。代价：DOCX 质量与导出 HTML 强耦合，样式回归要两类导出一起看；docx 包体积大需懒加载；docx 对 SVG 的 PNG fallback 是 1×1 透明占位且自身不光栅化，故 WPS 场景必须自光栅化。mdast2docx 作为 HTML 路线遇阻时的次选保留；Rust 系仅当 DOCX 下沉为 Tauri command 时重评。

---

## v0.7.16 — 导出类型选择

### ADR-20261114-002: 导出类型选择走内置面板，系统框只负责路径

- **Context**: 导出类型（PDF / Word / HTML）原先只能靠系统保存框的 filter 切换，用户必须先打开系统框才能选类型；当时在规划中的 `#pdf-preview` 也需要页边距 / 字号 / 页眉页脚参数与分页预览入口，系统框承载不了。
- **Decision**: 新增内置 `ExportPanel`（Teleport 弹层），先选类型 + 文件名，确认后按类型锁死 `saveDialog` filter 再选路径；文件菜单、命令面板、快捷键三处统一走面板。
- **Consequences**: 类型选择可见、可预期，系统框回归单一职责；程序化导出保留 `exportDocument(type)` 直连路径，测试与脚本不受影响。代价是多一个全局弹层及其键盘 / 焦点管理。
- **后续更新**: 面板从三项扩为四项，新增「PDF 预览」。它是**入口而非格式**：确认后不打 `saveDialog`，改为打开 `PdfPreviewPanel`，页边距 / 字号 / 行距 / 页眉页脚参数放在预览面板自己的侧栏；用户调完再点「导出 PDF」才走 `saveDialog` + 前端 `writeFile`。这样既保留面板「先选类型 + 文件名」的语义，又不必把参数区塞进系统框或原本的小卡片。见 `docs/architecture/export.md`「store 与内置导出面板」。

---

## v0.7.16 — 表格列宽自适应

### ADR-20261115-001: 列宽走 view-only 的「auto 测量 → 同帧锁定」，不写回 markdown

- **Context**: GFM 无列宽语义，`markdownIO` 建表时 cell 的 `colwidth` 全为 null，`columnResizing` 的 `TableView` 因而把 `<colgroup>` 写成空宽度；CSS 又是 `table-layout: fixed + width: 100%`，浏览器只能按列数均分 —— 内容为单个 `#` 的列与长文本列等宽。候选：A 纯 `table-layout: auto`（3 行 CSS，但列宽随每次击键变化、拖拽 px 不精确）；B 按文本估宽写百分比（无需测量，但 KaTeX / 图片 / 行内代码估不准）；C 浏览器 auto 布局实测 → 实测宽度写回 colgroup → 切 fixed 锁定。C 若沿用「默认 fixed、rAF 里才切 auto 测量」会产生「先均分再跳变」的一帧。
- **Decision**: 选 C，并把默认 CSS 直接改成 `auto`，让**首个可见态就是内容自适应**，从源头删掉「均分」这个状态。测量、写 `<colgroup>`、切 `locked` 全部在**同一个 rAF 回调**（paint 之前）完成，浏览器该帧只 paint 最终态；写回的是刚读到的同一组 auto 宽度（1px 量化，列宽之和恰等于测得的表格宽度），且切换发生在首次 paint 之前，用户只看到一次自适应布局 → 零跳变。列宽**一律用 px**：`columnResizing` 的拖拽预览只写 px，锁定态 `table { width: max-content }` 让表格总宽由列宽之和决定（Chromium 实测 `width: auto` 仍会把表格钳在容器宽度内、按比例缩放列宽，只有 `max-content` 能让 px override 精确跟手；超出部分由 `.tableWrapper` 横向滚动）；若自适应列用百分比，`%` 列与 px override 列混合、表格宽度又被 100% 锁死时，fixed 布局会重新平衡列宽吃掉 override 增量（首次拖拽不跟手）。新增 `editor/tableAutoWidth.ts` 的 `AutoWidthTableView extends TableView`，经 `columnResizing({ View, defaultCellMinWidth: 48 })` 注入，不改 `allPlugins` 顺序。多表同帧「统一切 auto → 统一读 → 统一锁」批处理，避免读写交错触发多次强制 layout。
- **Consequences**: 全程不 dispatch transaction、不写 `colwidth`、不动 `markdownIO`，列宽是纯视图态，markdown round-trip 字节不变、undo 栈干净。锁定后普通打字不重测（结构签名 = 行数 + colspan 展开列数），只在增删行列 / 字体加载 / 容器宽度变化时重算；容器变化由 ResizeObserver 同步按缓存比例重算 px（等比例缩放、无闪烁），手动列宽变化只需同步重算一次。手动 `colwidth` 优先：保留用户设定的 px，**其余自动列保持「无手动列时的基准宽度」（`available × 内容比例`），不按 `available - manualSum` 重新分配**。原因是官方 `updateColumnWidth` 在 mouseup 时只给被拖的那一列写 `colwidth`，其余列仍是 0；若按剩余空间重算，拖宽一列就会把其它列压到 `MIN_COL_PX`（截图里的文字竖排、行高暴涨），且拖拽预览宽度与 mouseup 后宽度对不上。总宽允许大于 `available`，由 `.tableWrapper` 横向滚动。1px 量化误差只在**无手动列**时补给最大的自动列以铺满容器；有手动列时不做校正，避免改动自动列造成二次跳变。`columnWidthBudget()` 另把容器宽度扣掉 1px：`border-collapse: collapse` 下表格边框盒 = 列宽之和 + 1px 外框，`width: max-content` 按边框盒计算，若不扣这 1px，每个锁定表格都会比容器宽 1px、常驻一条横向滚动条（Chromium 实测 930 容器 → 表格 931 → 10px 滚动条；扣后表格 930、无滚动条，拖宽到 1556 时滚动条按需出现）。**锁定态全程保持 fixed，绝不因 hover / 拖拽切回 auto**：`columnResizing` 的 hover 判定基于 cell 边界 5px 命中区，布局一变边界就位移，随即触发「切 auto → hover 失效 → 切回 fixed → 又命中」的自激闪烁，列分割线也会跟着跳。为了让 fixed 下仍能拖拽，自适应宽度除 inline width 外另存一份到 `<col>` 的 `--velo-col-width`，由 `col { width: var(--velo-col-width, auto) }` 兜底 —— 官方 `updateColumnsOnResize` 每次（含 PM 的 `view.update`、拖拽预览）都会把无 `colwidth` 列的 inline width 清成 `''`，但不会动自定义属性；拖拽 override 列写的 inline px 优先级更高，自然覆盖兜底值。**列宽统一 px + 锁定态 `width: max-content`** 解决首次拖拽不跟手：此前自适应列是百分比、override 列是 px，表格宽度又被 100% 锁死（后来改成 `auto` 仍被 Chromium 钳在容器宽度内按比例缩放），fixed 布局把 override 增量重新平衡掉；mouseup 写入 `colwidth` 后才切成全 px，所以表现为「第一次拖拽没反应、松开才变、之后才跟手」。导出 HTML 无 NodeView，天然停在 auto 态，静态文档按内容自适应，docx 继承同一份 HTML。代价：多一个 NodeView + ResizeObserver；视口外 / colspan 不规则的表格会退化到 auto 态（仍是自适应，只是不锁定）。已知遗留：手动拖拽的列宽依旧会话级、重载即丢，后续若做「会话内记忆」应沿用本 ADR 的 view-only 路线。

---

## v0.7.16 — PDF 预览选型

### ADR-20261119-001: PDF 预览走纯 TS 共享 Display List 双后端，不引入 Typst / 排版引擎

- **Context**: 旧约束「预览必须与编辑器逐页 WYSIWYG 一致」在 ~1s 验收线下无解 —— PrintToPDF 是批处理原语，每次调用完整跑「加载 HTML → 全文档分页 → 光栅化」（~5s），改页眉与重写整篇无差别，且被全局打印锁串行。约束放宽为「允许细微差异 + 不依赖 WebView2 + 三平台 + 体积可控」后候选实测：复用 PrintToPdf（~5s、Windows-only）；Typst native 嵌入（安装包 +10–20MB、首次 ~1.4s、增量 150–270ms 但分页与 Chromium 不一致，预热消灭冷启动无效）；Typst WASM（+3–8MB、性能未验证）；非 Chromium HTML→PDF 引擎（WeasyPrint / jhtmltopdf / ironpress / xhtml2pdf 等实测保真度全部不达标 —— 快的不保真、保真的不快，Velo 导出 HTML 是为 Chromium 量身定制的；WeasyPrint 理论最优但 Windows 缺 GTK runtime 无法桌面分发）；纯 TS 轻量布局器（体积增量在懒加载 chunk 内、参数重排毫秒级）。
- **Decision**: 自研纯 TS 布局器，预览与导出共享同一份 Display List（预览画 DOM 绝对定位、导出序列化 PDF），一致性由「同一棵布局树」而非「同一个慢引擎」保证；文本测量查子集字体字形宽度表（纯计算、三平台一致），字体走运行时 wasm 子集化（零新增字体文件）；富片段复用既有 JS 产物（mermaid 矢量、shiki 按 token 出文本算子、KaTeX / raw HTML 采样位图）。旧 PrintToPdf 路径保留为默认 `PDF` 导出，两者并列互不替代。
- **Consequences**: 调参同步重排（毫秒级）、三平台行为一致、PDF 文本可选中 / 搜索；代价是分页 / 行盒与 Chromium 导出有细微差异（放宽约束的定价）、版式令牌与编辑器 SCSS 双源手工对齐（改主题须手动同步，漂移风险）、raw HTML 位图不可选中 / 放大失真等已知限制（公式位图已在 ADR-20261125-001 改为矢量，详见 `docs/architecture/export.md`）。Typst 保留为技术储备：若将来接受更大体积、需要更高质量数学 / 表格排版再重评，但不做「按平台分引擎」（三平台输出互不相同比现状更糟）。（原调研文档已删，选型结论以本条为准）

---

## v0.7.16 — 公式矢量

### ADR-20261125-001: KaTeX 公式矢量走「真实 DOM 实测提取」，不在 JS 里复刻 CSS 排版语义

- **Context**: pdfPreview 落地时公式走 A 档 foreignObject 位图（不可选 / 不可搜 / 放大失真）。要抹平差异有两条候选：① 拿 KaTeX `__renderToDomTree()` 虚拟树纯 JS 直译成 PDF 算子 —— 虚拟树自带精确度量，但视觉位置由浏览器 CSS 决定（vlist / 字号级联 / spacing / `overflow:hidden` / svgGeometry），需在 JS 重写一套 CSS 排版语义，估算 ~600–900 行且长尾命令持续补；② 让真实浏览器把 `katex.renderToString` 的 DOM 排好，用 `Range.getBoundingClientRect()` + `getComputedStyle` 逐字形 / 逐 SVG / 逐边框取坐标，直接翻译三类图元。②的验证由开发期临时 spike 完成（gitignored 临时目录，落地后已清理，复现方式见 `katexVector.ts` 头注释与回归测试）：`\frac \sqrt \sum \int 上下标 aligned` 与手写转换器像素差 ≤0.03%，另外 `\left(\right)`、accent、`\overbrace`、`\xrightarrow`、`\cancel`、`\binom`、`\mathcal/\mathbb`、`\text{中文}` 零模板覆盖。
- **Decision**: 选 ②，产品化落到 `src/lib/export/pdfPreview/katexVector.ts`：10× 字号离屏测量后折算 pt（规避 1× 下 `min-height:1px` 取整），公式内容存 `RichFragment.formula`，预览直接画同一份算子、导出在 `pdfWriter` 发真 text/path/rect 算子；KaTeX 字体按文档公式实际用到的族运行时子集（复用既有 wawoff2 → hb-subset → opentype.js 链路），资源名从 `/F4` 起。转换失败（缺字 / 含未适配 SVG 形状）回退 A 档位图，与 mermaid 双编码器同策略。放弃 ①：把「CSS 排版求解器」外包给已在运行的 WebView 引擎，避免逐命令模板与 KaTeX 内部实现漂移。
- **Consequences**: 公式文字重新可选中 / 可搜索，路径矢量无损；预览与导出共享同一份几何数据，不再有「位图按首次主题烘焙」的公式侧限制。代价：①依赖真实 DOM 布局（提取只在一端测量一次，预览 / 导出都用缓存算子，不会各排一次）；② `\text{中文}` 这类 KaTeX_Main 无字形的字符改为回退正文 sans（浏览器侧原本是系统 serif，属可接受的近似）；③ `.katex` 盒不含 SVG 溢出（`\overbrace` 等），片段盒高可能低估，预览不能裁 overflow；④ PDF 路径算子没有相对形式（小写也绝对），而 SVG path 小写是相对，预览侧转换必须翻大写命令。不做「按平台分别实现提取」：同一份 DOM API（Range / getComputedStyle）三平台都有，差异只在字体回退链。


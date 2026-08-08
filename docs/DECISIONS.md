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

---

## v0.5.0 — 工作区与文件树

### ADR-20260623-001: 工作区根走 recursive 单 watch 句柄

- **Context**: A（recursive 单 watch）vs B（逐目录懒 watch，`Map<dir, UnwatchFn>`）。B 的多句柄生命周期放大 race 风险，需 per-dir 串行化队列。
- **Decision**: 选 A。工作区根单 `watch(root, { recursive: true })`，事件回调取 dirname 入脏目录集，120ms debounce flush 后按目录重拉。activeRoot 变化时先 stop 后 start。
- **Consequences**: 生命周期简单，与 documentStore 单文件 watch 同形。网络盘漏报在目录级比文件级更严重，v0.5.0 接受。

### ADR-20260623-002: 新建 `src/tauri/` 薄封装层

- **Context**: 业务代码直 import `@tauri-apps/*`，测试 mock 散落各处。v0.5.x 起 fs 调用点成倍增长。
- **Decision**: `src/tauri/{fs,dialog,path}.ts` 薄封装（re-export + `tauriOnly()` 守门），业务侧只 import 封装。封装层**不**统一错误形态——调用方各自降级（persistence 走默认值 / document.save 弹 message / imageStorage throw 透传）。
- **Consequences**: 业务代码不再出现 `@tauri-apps/*` import；测试 mock 可收敛到单一入口；E2E 接入时横切关心集中加在 `src/tauri/*`。

### ADR-20260623-003: capability fs scope 保持 `**`

- **Context**: "是否收紧到工作区根内"的直觉反复冒出来。A 保持 `**` vs B 自写 Rust command 校验 vs C 动态 scope（Tauri 2 fs scope 是静态 glob，技术上不可行）。
- **Decision**: 选 A。Velo 是本地单用户桌面编辑器，威胁模型是"用户主动打开的文件"，`**` 不 worsen。安全靠 UI 层 destructive op 二次确认。
- **Consequences**: 显式 ADR 留痕，避免日后"应该收紧 scope"的直觉再次被翻出来。

---

## v0.5.1 — E2E 启动

### ADR-20260624-001: E2E 走 WebdriverIO + tauri-driver

- **Context**: Playwright 只支持 CDP/BiDi，tauri-driver 是 WebDriver Classic 代理 → 协议层不兼容。跳过 E2E 无法覆盖 CLI→工作区→写盘跨进程链路。
- **Decision**: WebdriverIO 9 + tauri-driver + msedgedriver（Tauri 官方同款），Windows-only。
- **Consequences**: 后续 spec 复用现有 helper，不再对 WebView2 工具链做二次研究。

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

### ADR-20260626-001: 侧栏宽度 per-workspace 持久化（READ 语义）

- **Context**: A 全局单一宽度 vs B per-workspace vs C per-document。不同工作区应有不同的宽度偏好。
- **Decision**: 选 B。`WorkspaceState` 加 `sidebarWidth`。`setActiveRoot` 走 **READ** 语义（切出时**读**目标工作区的宽度），与 `sidebarTab` 的 WRITE 语义相反——因为 per-workspace 持久化要求"切回 /a 后宽度还是 /a 的"。
- **Consequences**: 旧 JSON 缺字段回退 256 无需手动迁移。后续若想"新工作区继承当前宽度"，改 READ→WRITE 即可。

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

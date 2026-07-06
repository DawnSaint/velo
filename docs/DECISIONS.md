# Velo Architecture Decision Records

> 重大架构取舍的 ADR（Architecture Decision Records）。
>
> **写入标准**: 候选方案 ≥ 2、对未来 1+ 个版本有持续影响、踩坑点非显然。
> **不写入**: 纯 bug fix、Cargo.toml 一行配置、已被后续 ADR 覆盖的旧方案、实现细节（已沉淀到 `docs/architecture/*.md`）。
>
> 用户可见版本变更见 [`CHANGELOG.md`](./CHANGELOG.md)；设计状态见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) → `docs/architecture/*.md`。

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

### ADR-20260624-002: CLI argv 容忍单层 `--` 前缀

- **Context**: WebDriver 把 `tauri:options.args` 强加 `--` 前缀，velo.exe 收到 `--C:\path` → `is_file()=false` / `is_dir()=false` → 空 payload。
- **Decision**: `strip_prefix("--").unwrap_or(s)` 一行修改。真实 CLI 用户不会传 `--path` 命名参数，不受影响。
- **Consequences**: 给 E2E/WebDriver 工具链留统一入口，不再绕路。

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

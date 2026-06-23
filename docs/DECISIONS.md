# Velo Architecture Decision Records

> 重大架构决策与重大重构的 ADR（Architecture Decision Records）。
>
> 本文件记录"为什么这样设计"的取舍（候选方案 ≥ 2、对未来有持续影响、踩坑点非显然）。
> 用户可见的版本变更见 [`CHANGELOG.md`](./CHANGELOG.md)；
> 当下的设计状态与踩坑记录见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的"设计要点 / 维护者注意点"。

---

## v0.3.2 — 图片  (2026-06-12)

### ADR-20260612-001: Tauri 2.5 `plugin-fs` 必须显式开 `watch` feature

- **Context**: JS 端 `invoke('plugin:fs|watch')` 报 `Command watch not found`；upstream `@tauri-apps/plugin-fs@2` 默认 `features = ["fs"]` 不含 `watch`，`Cargo.toml` 写 `"2"` 也不会自动开
- **Decision**: `src-tauri/Cargo.toml` 显式写 `features = ["watch"]`
- **Consequences**: 跨平台文件监听可用（`tauri-plugin-fs` 的 `watch` feature）；新增 feature flag 需要在 CI 多平台矩阵中验证



## v0.3.3 — BUG 修复和部分重构  (2026-06-13)

### ADR-20260613-001: mermaid 走 `Decoration.widget`，不走 NodeView

- **Context**: mermaid SVG 渲染需要改写 atom 节点 outer dom 的 `innerHTML`；ProseMirror 的 `DOMObserver` 会把它当外部突变 → `readDOMChange` → `view.updateState` → 整个 view tree 重 mount，所有 NodeView destroy + recreate，用户每敲一字符 mermaid 全闪 loader
- **Decision**: 改用 `Decoration.widget`（`WidgetViewDesc.ignoreMutation` 默认忽略所有非 selection 突变），NodeView 整层移除
- **Consequences**:
  - schema toDOM 输出 `height: 0` 隐藏占位（atom 节点必须有 dom 用于 `posAtCoords` / selection 映射，藏视觉即可）
  - plugin promise resolve 后**直接**在 widget dom 上写 svg，**不要** dispatch setMeta 触发 `buildDecorations`（否则新 Decoration 实例的 `WidgetType.eq` 比对失败 → widget 复用失效 → 死循环）
  - 主题切换走 widget 工厂里挂 `velo:theme-change` window listener 自己改 dom，不走 plugin setMeta 路径（同上死循环原因）；decoration `spec.destroy` 钩子负责 `removeEventListener` 防泄漏



## v0.4.0 — milkdown 重构  (2026-06-13)

### ADR-20260613-002: 编辑器从 Milkdown 迁到 ProseMirror + remark/unified

- **Context**: Milkdown 抽象层（`$prose` / `$inputRule` / `$remark` 包装）遮蔽 ProseMirror 原生行为，upstream `markRule` 正则 bug 要写补丁绕开；传递依赖 96 个包冗余；`@milkdown/vue` 的生命周期 hook 不够灵活
- **Decision**: 拆 3 阶段（feature flag 灰度 → 接入 → 清理），逐步迁到裸 ProseMirror + `remark-parse` / `remark-stringify` + 自写 mdast↔PM 转换
- **Consequences**:
  - 净减 96 传递包（删 `@milkdown/*`）
  - 后续 ProseMirror 原生能力（`Decoration.widget` / `appendTransaction` / NodeView API）可直接用
  - 失去 Milkdown 插件生态（但本项目不需要，自己写 NodeView / remark 插件更直接）



## v0.4.1 — 增加语法渲染  (2026-06-15)

### ADR-20260615-001: 语法实时转换走 `appendTransaction` 框架

- **Context**: 历史上每条语法各自一个 `InputRule`（末尾紧贴 `$` 锚）+ link 单独一份 `linkAutoFormatPlugin`（全文扫描）。问题：① 反向输入（如先 `]` 再补 `[^xxx`）不触发 InputRule；② 粘贴 / 中间编辑不响应 InputRule；③ 块级语法（`### ` / `> ` / `- ` 等）根本无人接管，**只能渲染已写好的、不能输入触发**；④ 每条规则各自处理黑名单 / 编辑态 session，扩展成本高
- **Decision**: 新框架 `plugins/syntaxAutoFormat.ts` 单 `appendTransaction`，从 `tr.mapping.maps` 提 dirty range → 扩展到 textblock → 对每个 textblock 跑 `syntax/block/*` 段首检测 + `syntax/inline/*` 段内 g 正则检测
- **Consequences**:
  - 敲一字符 = 扫一段；粘贴整段 = 扫被粘入的 N 段；无全文重扫
  - 黑名单（`code_block` / `html_block` / `mermaid` / `math_block`）、`code` mark、`linkClickPluginKey.session` 范围由框架统一过滤，语法定义只写 `pattern + apply`
  - 新增语法 = 写一个文件 + 在 `syntax/index.ts` 注册一行
  - `InputRule` 仅保留 `ellipsis` / `emDash` 这种纯文本→纯文本的快速路径
  - 坑：block detector 要求 `pattern` 带 `^`、不带 `g`；inline 反过来要求带 `g` 不带 `^/$`，框架做 `pattern.global` 防御但不自动改写



## v0.4.2 — 代码整理  (2026-06-15)

### ADR-20260615-002: 编辑器重建走 `view.updateState(EditorState.create(...))`

- **Context**: 旧路径用 `innerKey` ref 触发整个 `EditorView` destroy + recreate（`:focus-on-create` prop），`modelValue` 变化时（切文件 / 新建 / 外部同步）频繁闪烁且丢失 IME composition 状态
- **Decision**: `EditorInner.vue` 内部直接 `view.updateState(EditorState.create(...))` 替换内部 state，plugin state 因 init 跑归零（等价 destroy + recreate 但不销毁 view 实例）；`index.vue` 不再参与重建控制
- **Consequences**:
  - 删除 `innerKey` ref + `onRebuildRequest` + `:focus-on-create` prop
  - 外部 modelValue 变化用 `lastSelfEmitted` 哨兵探测（自己 emit 的 echo 跳过），不匹配时 `view.updateState` 替换内部 state
  - 比 `isInternalChange + nextTick` 时序标志更稳，避免竞态



## v0.4.3 — 代码块升级

### ADR-20260616-001: 代码块高亮 shiki Dual Themes

- **Context**: highlight.js 不支持 token 级主题切换(整块一个色)，且需要手写色板对齐 VS Code 主题；shiki 早期试过 `createCssVariablesTheme` 模式，官方不推荐 + 跟 VS Code 真实主题有色差
- **Decision**: `codeToTokensWithThemes(code, { themes: { light, dark } })` 返回 `ThemedTokenWithVariants[][]`，每个 token span 写 `--shiki-light:${hex}; --shiki-dark:${hex}` 局部 CSS 变量；`pre` 自身 `color: var(--shiki-light)` 选色，切 `<html class="dark">` 走 CSS cascade 翻面（零重渲，ProseMirror / shiki 不参与）。pre 背景 / border 写死（白/深灰），跟代码块主题解耦
- **Consequences**:
  - 用户从 shiki 66 个 bundled 主题里自选，`createHighlighter` 启动只装当前 2 个主题
  - **切主题要 rebuild**（hex 变了）：走 App.vue `watch store.codeLightTheme` → `ensureTheme` 追加 + `dispatch setMeta` 触发，跟 darkMode toggle 路径**正交**
  - `getLanguage` 在 lang 未注册时**同步 throw ShikiError**（不是返回 null），try 兜住后走 plain text 降级，不阻断其他 code block 高亮
  - 引入 30 个开放语种清单 + 浮层语言选择 UI（Teleport 挂 body）、一键复制（`@tauri-apps/plugin-clipboard-manager`）

### ADR-20260616-002: 代码块工具条 widget 几何同步

- **Context**: 工具条用 `Decoration.widget(side: -1)`，widget 是 `<pre>` 兄弟节点，几何无绑定；侧边栏开合改容器宽度但不触发 `window.resize` / `scroll`，工具条漂位
- **Decision**: RAF 之后再 `ro.observe(wrap.offsetParent)` + 同时观察 pre 自身 + offsetParent，覆盖"内部 layout 变化"路径
- **坑**：① 同步执行 `makeToolbarDom` 时 widget 未挂 DOM，`offsetParent === null`，`ro.observe(null)` 报 null 错被吞、RO 整个没建立；② 祖先有 `transform` / `filter` 让 absolute 子元素的 offsetParent 跳走，未来加 splitter / 抽屉时记得回头补 RO

### ADR-20260616-003: 启动期零闪烁双层保险

- **Context**: shiki 装错主题只能 `loadTheme` 追加再 rebuild → 闪；`state.init` 是同步函数不能 await，PM mount 时 hl 可能 null → token span 继承 SCSS 默认色 → "先黑后用户主题色"闪烁
- **Decision**: 双层保险
  1. App.vue `codeBlockReady` 守门 PM mount（**不用顶层 await** —— 会变 async setup，根模板没 `<Suspense>` 包裹会白屏无报错）
  2. `CodeBlockLangs.cachedHighlighter` 在 `getHighlighter()` resolve 时填；`getHighlighterSync()` 同步可读；`state.init` 直接填好 highlighter，首次 `decorations(state)` 就有 token style
- shiki 加载失败 → `codeBlockReady` 翻 true 走 SCSS 默认色降级，不卡白屏

### ADR-20260616-004: dev web 端 Tauri API 统一 `isTauri()` 守门

- **Context**: `npm run dev` 调 Tauri API 同步 throw，单行 throw 让 onMounted async 链整条 reject，后续 watch 挂不上 → 切代码主题失灵根因
- **Decision**: 顶层 `const tauri = isTauri()` 同步算一次，Tauri API 调用分两类 ——
  1. **fire-and-forget 异步**（`invoke('set_window_theme')` 等）走 `if (tauri)` 守门
  2. **onMounted await 链路里的 Tauri 同步**（`get_cli_args` / `listen('cli-args', ...)` / `onCloseRequested`）整段 `if (tauri) { ... }` 包裹，不让单行 throw 阻断整条 async 链
  persistence 模块统一加 `tauriOnly()` 守门：web 端 load=null / save=noop，store 走默认值继续渲染

### ADR-20260618-001: shiki 预扫 + 懒加载 lang

- **Context**: 启动期 `createHighlighter` 装 30 个 lang 全集约 6MB grammar,实际单篇 doc 只会用其中 2-5 个;完全懒加载又会让首屏代码块第一帧走 SCSS 默认色,出现"先骨架后着色"的明显两段
- **Decision**: 启动期 mdast 预扫 doc 的 fenced code lang(由 App.vue 调 `extractLangsFromDoc`)∪ 5 项 `BASELINE_LANGS` 兜底(js/ts/py/bash/json) → `createHighlighter` 只装这一小撮;运行时 miss 走 `ensureLanguage` fire-and-forget 异步追加,resolve 后 plugin 端 rAF 节流一次 dispatch setMeta 触发 rebuild
- **Consequences**:
  - 首屏 grammar 从 ~6MB 降到 ~1-1.6MB
  - `getTokensSync` 改用 `hl.getLoadedLanguages()` 探活
  - `bundledLanguages` Record gate 拦未注册 lang,避免无效 `loadLanguage` 触发 ShikiError warn 刷屏
  - 首次 miss 那一帧的 decoration 是无 token 的;rebuild 下一帧才出 token —— 这是有意为之的"先骨架后着色",不是 bug
  - `setDecorationRebuildCallback` 单 slot 钩子,一次粘贴 N 个未装 lang resolve 后 coalesce 到下一帧一次 dispatch;多 PM instance 场景要改 `Set<cb>`



## v0.4.4 — 快捷键与高亮  (2026-06-18)

### ADR-20260618-002: 快捷键走 declarative registry

- **Context**: 历史上 ProseMirror keymap 在 `EditorInner.vue` 的 allPlugins 里手写,keymap 项散落在多处代码中,改一个键位要翻全栈;命令与键位耦合(没法独立复用 command);且没有任何机制能枚举当前有哪些键位。用户提出"快捷键介绍"需求时,这一缺口立刻显现
- **Decision**: 新建 `editor/shortcuts/registry.ts` 单例 + `registerShortcut({ key, command, label, group })` API;`editor/shortcuts/commands/` 按命令类型分文件(`toggleMarkWithWrap` / `setHeading` / `wrapIn*` / `insertTable2x2` / `triggerLinkEdit`);`editor/shortcuts/bindings.ts` 集中所有 `registerShortcut` 调用;`EditorInner.vue` 仅 `import './editor/shortcuts'` 触发副作用注册 + `buildShortcutKeymap()` 进 allPlugins。`label` / `group` 字段为后续命令面板 / 速查 overlay 留好接口
- **Consequences**:
  - 新加快捷键 = 1 个 command 文件 + `bindings.ts` 加 1 行 registerShortcut,**不碰** `EditorInner.vue` / `registry.ts`(除非改 API)
  - `getShortcuts()` 一处可见所有键位,改键位 = 改 `bindings.ts` 一处
  - v0.4.4 共发布 17 个键位(文本 mark 5 + 段落 1 + 标题 6 + 列表 2 + 引用 1 + 代码块 1 + 表格 1);水平线快捷键(`Mod-Shift-h`)验收未生效,延期后续版本,`insertHr` 函数保留以便复用,启用只需在 `bindings.ts` 加 1 行
  - `toggleMarkWithWrap` 统一行为:选区非空 toggle / 选区空插包裹符 + setStoredMark / 已在 mark 内 removeStoredMark / `code_block` 与 `code` mark 黑名单 / linkClick session 内只 setStoredMark 不插包裹符(保护源码编辑态不被改)
  - link mark(`Mod-k`)走 `triggerLinkEdit` 单独实现:`setMeta(syntaxAutoFormatPlugin, false)` 防止 syntaxAutoFormat 抢转 link mark,源码插入后启动 linkClick session 进入编辑态



## v0.4.6 — mermaid 重构 + 源代码模式 (CodeMirror 6)  (2026-06-21)

### ADR-20260620-001: mermaid 节点 → `code_block { language: 'mermaid' }` 升级

- **Context**: v0.4.5 引入 shiki 代码块高亮后,```mermaid 在编辑器内被 `syntax/block/codeBlock.ts` 的 `codeBlockEnterCommand` 路由到普通 `code_block` 节点(`language: 'mermaid'`),但 `markdownIO.fromMarkdown` 保留旧路径把 ```mermaid 还原回 `mermaid` 节点 + textarea 编辑器 —— 两条平行宇宙各自正确、接缝处出错:编辑器里输入 ```mermaid + Enter 产生的 `code_block` 永远不渲染 SVG(必须经一次磁盘往返 → reload 才"激活")。评估 A (保留 textarea + mermaid 节点) vs B (改走 code_block + SVG widget) 时关键发现:**A 已经是坏的**(不是 0 改动修复路径),而 **B 已实现一半**——shiki mermaid 语法高亮已在工作,差的只是把 SVG 预览挂上去。用户原话:"我倾向于高亮代码块 + mermaid 图的方式"

- **Decision**: 选方案 B —— mermaid 节点废弃,```mermaid 改走 `code_block { language: 'mermaid' }`(与其他 fenced code 同管线),由 `nodes/MermaidDecoration.ts` 的 `Decoration.widget` 扫 code_block 渲染 SVG + 自管 toolbar。实施:特性开关 `MERMAID_AS_CODE_BLOCK` 灰度 → 切 markdownIO + 重写 widget → 跑测试 → 删旧分支
  - `MermaidDecoration` 挂两件 decoration:**Decoration.node** 在 pre 上写 `data-mermaid-source="hidden"/"visible"` 控制"看源码"态;**Decoration.widget(side: 1, block: true)** 锚在 block 末尾之后挂 SVG 容器 + 自管 toolbar(切换源码 / 删除)
  - **widget 几何分工**:`codeHighlightPlugin` toolbar(side: -1, pre 前)继续提供 mermaid 的语言选择 + 复制按钮(同 code_block 共享,不重复);`MermaidDecoration` widget(side: 1, pre 后)专管 SVG 切换 / 删除;两个 widget side 不同,PM 内部排序不互踩
  - **toolbar 行为**:`codeHighlightPlugin` 在 lang='mermaid' 上**不**挂 toolbar 注释是因为原 plan 写时还没意识到与 MermaidDecoration widget 协作 —— 最终实现是两者并存,MermaidDecoration 自管的 toolbar (chevron 切换 / 删除) 与 codeHighlight 的 lang/copy toolbar 各管各的按钮

- **Consequences**:
  - **净删代码**:`MermaidDecoration` 的 fillEditor / textarea / 实时预览 / commit / cancel / autoHeight 一整块 ~250 行删掉;用户输入即所得 + reload 即所得对齐
  - **shiki mermaid 语法高亮白送**(用户最想要);复制按钮 / 语言切换 / 行选择 / 查找替换 / `codeBlockBackspaceCommand` 自动覆盖 mermaid(空 code_block Backspace 转 paragraph,等价"删除空 mermaid"行为)
  - **不再 atom**:选区/键盘 navigation 行为变(从"整块选中 + Backspace 删整块" → "逐字符编辑 + 空时 Backspace 转 paragraph");但更符合直觉
  - **SVG 浮在 pre 下方**:整块视觉布局变化,需要新 CSS 校准(`.mermaid-svg-area` 样式重置)
  - **测试一次性破坏 5-7 个**:`markdownIO.test.ts` mermaid round-trip / `markdownPaste.test.ts` "mermaid 节点"用例 / `codeHighlight.test.ts` 第 10 项("widget 不被 mermaid 节点触发"前提失效,换成"code_block lang=mermaid 既出 toolbar 又出 SVG 双 widget");careful 重写
  - **实施踩坑**(沉淀到 ARCHITECTURE 设计要点):
    - widget promise resolve 后**不要** dispatch setMeta 触发 rebuild decorations(否则新 Decoration 实例 `WidgetType.eq` 比对失败 → widget 复用失效 → 死循环),直接在 widget dom 上写 svg
    - 主题切换走 widget 工厂里挂 `velo:theme-change` window listener 自己改 dom,不走 plugin setMeta(同上死循环);`spec.destroy` 钩子负责 `removeEventListener` 防泄漏
    - `tr.mapping.map(pos)` 默认 `assoc=+1`(关联"变更之后"),把"content 起点"映射到"插入文本末尾" → `editNodeSet` 里的 absolutePos 跑偏,buildDecorations 找不到匹配 → pre 被误判 hidden;apply 必须用 `mapping.map(pos, -1)` 保留"在变更之前"语义


### ADR-20260621-001: 源代码模式从 pre+textarea overlay 换成 CodeMirror 6

- **Context**: 旧源码模式是 `<pre>` 渲染 + 同尺寸 `<textarea>` overlay 叠加。软换行下 textarea 拿不到"第 N 行折到哪个像素 Y",要手搓一层像素测量层对齐 pre 与 textarea 的折行;行号、语法高亮(旧版纯文本无高亮)都要自补。评估 A(留 textarea overlay + 自补行号/高亮/折行测量) vs B(换 CM6)时:B 的 `lineNumbers()` + `lineWrapping` 免费覆盖行号与软换行对齐,且 shiki 高亮可走 CM6 `ViewPlugin`(`shikiCmPlugin.ts`)逐 token 转 `Decoration.mark`,与 WYSIWYG 侧 `CodeHighlightWidget` 同形(token hex 写 `--shiki-light/dark` 局部变量),SCSS `.velo-cm-source .cm-line span` 接管选色 —— 跨模式复用同一套 shiki 主题镜像 + `ensureTheme` 串行机制
- **Decision**: 选 B —— `SourceModeEditor.vue` 独立 CM6 `EditorView`,与 `ProseMirrorEditor` 经 `v-if` 互斥挂载,`documentStore.sourceMode` 单开关。`documentStore.content` 仍是唯一数据源:CM6 `updateListener`(docChanged)→ emit → store;外部 `watch(modelValue)` 用 `lastSelfEmitted` echo 哨兵跳过自身回写,真外部变化 dispatch changes 替换 doc 并夹住光标。主题镜像机制等价于旧版(本地 ref 镜像 + `ensureTheme` 串行),dispatch target 从 Vue ref 改 CM6 `setShikiTheme` StateEffect —— store mutate 本身不触发 rebuild,只有 effect dispatch 后(= `ensureTheme` 已 resolve = shiki 拿到真 hex)才 rebuild,防"未 resolve 期间全黑"。`token.offset` 即 CM6 doc pos(shiki offset 是相对输入串全局偏移,CM6 单文档 pos 等于字符串偏移,两者同构)
- **Consequences**:
  - 删掉旧 pre+textarea overlay + 像素测量层;行号 / 软换行 / 选区 / 特殊字符高亮 / 撤销栈全由 CM6 免费
  - shiki 语法高亮白送(旧源码模式无高亮),与 WYSIWYG 代码块同主题同配色
  - 双编辑器栈并存(PM + CM6),后续跨模式功能(光标同步 / 查找替换)需要双后端适配(见 ADR-20260621-002 / -003)
  - **源码模式禁止拖入 / 粘贴图片**(对齐 Typora):`forbidFileDropPaste`(`EditorView.domEventHandlers`)对文件型 drop `preventDefault`(否则 `dragDropEnabled:false` 下 webview 把文件当"打开"导航掉)、image/* paste 吞掉;PM 模式由 `imageUploadPlugin` 兜这个 preventDefault,源码模式无等价 PM 插件,这里补


### ADR-20260621-002: 跨模式光标 + 滚动同步走 token 序列 + LCS 对齐

- **Context**: `toggleSourceMode()` 翻转 `sourceMode` → `v-if` 互换两个编辑器,两边卸载重挂,光标 / 滚动在 DOM 层丢失,切模式后总是跳回文档顶。需要"最佳努力"把出方向光标位置迁到入方向对应处。评估 A(整窗归一化文本 `indexOf` 子串匹配) vs B(token 化 + LCS 最长公共子序列对齐)时关键发现:链接 `[text](url)` 的 URL、表格 `|` / `|---|---|` 分隔行是 CM6 侧多出、PM 侧没有的 token,会卡在光标窗口中间 —— 整窗子串匹配砍不掉这些多余段 → 失败跳顶;LCS 把多余 token 当"未对齐"自动跳过
- **Decision**: 选 B —— `crossModeSync.ts`。两边各 token 化(剥 markdown 标记字符 `#*~_\`-+[]()!>|`——**`|` 入集是关键**,否则无空格表格 `|cell|cell` 粘成一个 token;标记与空白都作分隔,`**bold**`→`bold`、`well-known`→`well`+`known`,两边对称即可)。`captureAnchor` 取光标所在 token ±64 个 token 的文本序列 + 光标 token 索引 + token 内字符偏移;`applyAnchor` 在入方向全 token 上跑 LCS,光标 token 映到对端对应 token,迁移 intraOffset,设选区 + 滚动居中。App.vue 单点 `watch(sourceMode, cb, { flush: 'pre' })` 覆盖全部切换入口(Ctrl+\` / 工具栏 / Esc 都走这一个布尔翻转);`flush:'pre'` 保证读到**出**方向 view(卸载在 render 阶段,晚于 pre-flush watcher)→ 抓锚点,`await nextTick()` 后**入**方向 `onMounted` 已建 view → 应用。滚动:CM6 `EditorView.scrollIntoView(pos,{y:'center'})`;PM 不用 `tr.scrollIntoView()`(默认"最小滚入视口",光标在视口下方只露底边 = 表现成跳到最底下),改手动 `coordsAtPos` + 祖先 `scrollBy` 居中
- **Consequences**:
  - 切模式光标落在视觉对应处,不再跳顶;光标 token 自身是多余方(如落在 URL 里)→ 退到最近对齐邻居 token 边界
  - **最佳努力**语义:空文档 / view 未就绪 → 静默放弃留默认;LCS 矩阵超 4M 格(token > ~31k 的大文档)→ 退线性首现匹配,防 O(n²) 卡顿
  - 单点 `watch(sourceMode)` 覆盖所有入口,后续新加切模式触发点无需改同步逻辑
  - 入方向主动 focus(PM 手动滚动依赖 view 已布局)


### ADR-20260621-003: 查找替换走 PM / CM6 双后端抽象 + 意图上提 provide/inject

- **Context**: v0.4.5 的 `FindReplace.vue` 写死绑 ProseMirror(`editorViewGetter` 返回 PM `EditorView`,内部 `findMatchesInDoc` / `findHighlight` PM 插件 / `TextSelection.create` / `tr.replaceWith`)。源码模式(CM6)下 `ProseMirrorEditor` 整个 `v-if` 卸载,`FindReplace` 跟着消失,工具栏搜索按钮还被 `:disabled="sourceMode"` 显式禁用。要在两模式共用同一份面板,评估 A(把 FindReplace 上提到 App.vue,App 跨编辑器取 view 构造后端) vs B(每编辑器各挂一份 FindReplace,各自用自己 view 构造后端) vs C(FindReplace 内部 mode 条件分支)。C 让组件耦合两套编辑器 API,放弃。A vs B:B 的 `backendGetter` 平凡(用自己 view)、面板定位天然落在各自 card 内、无需 App 跨编辑器取 view;选 B
- **Decision**: 选 B + 后端抽象。新建 `FindReplaceBackend` 接口(`findreplace/backend.ts`):`getSelectionText` / `getRangeText` / `findMatches` / `setSelection` / `scrollMatchIntoView` / `setHighlight` / `clearHighlight` / `replaceRange` / `focus`,`createPmBackend(view)` / `createCmBackend(view)` 两份实现,FindReplace 不直接依赖任一编辑器 API。两份 `FindReplace.vue` 分别挂 `ProseMirrorEditor/index.vue`(PM)与 `SourceModeEditor.vue`(CM6),`v-if/v-else` 互斥同一时刻只一份活着。**用户意图(query / 选项 / 替换文 / showReplace)上提到 App.vue 经 `provide(findIntentKey)` → FindReplace `inject` 共享**:切模式时 PM 份卸载、CM6 份新挂,意图在 App.vue 存活 → query 跨模式保留;`matches` / `currentIndex` 不上提(模式相关,新挂载时用当前后端重算)。CM6 高亮走新 `cmFindHighlightField` StateField + `cmFindHighlightEffect`(镜像 PM 侧 `findHighlight` 插件,`Decoration.mark({class}).range`),class 复用 `velo-find-match`/`velo-find-current`(CSS 提到 `_editor-base.scss` 全局层两套编辑器共用)
- **Consequences**:
  - `replaceAll` 编辑器无关化:倒序遍历 matches(逆序避免位置错位),每个 match 取 `getRangeText` → `replaceInText` → `replaceRange`;PM(match 不跨文本节点)/ CM6(match 可跨行)统一成立
  - 两后端语义差异各自符合该模式用户所见文本:PM `findMatches` 搜 prose 文本(不含 markdown 标记,match 不跨块)、CM6 搜原始 markdown 全串(含 `**`/`|`/`[]()`,match 可跨行)
  - `scrollMatchIntoView` 两套:PM 手动 `coordsAtPos`+祖先 `scrollBy`(焦点在 find 输入里时 `tr.scrollIntoView` 早退)、CM6 `EditorView.scrollIntoView(pos,{y:'center'})` effect(不依赖焦点)
  - 意图上提的踩坑:切模式 findOpen 保持 true,新挂载 FindReplace 的 `open` watcher(immediate)在 setup 阶段跑 recompute,但此时入方向 view 未建好(backendGetter 返回 null → matches=[]),之后 query/选项是 inject 的同一 ref 值没变不触发 watch → matches 停空,要手动改 query 才重算。修法:`onMounted` + `nextTick` 补一次 recompute(nextTick 时父组件 onMounted 已同步建好 view)
  - FindReplace 无 provide 时回退本地 ref(独立挂载 / 测试自洽);`backend.test.ts` 覆盖 PM / CM6 两后端 round-trip

### ADR-20260621-004: 导出走 HTML 自包含 + 平台原生 PrintToPDF(v0.4.7 后),复用现有渲染管线

- **Context**: v0.4.7 加导出功能,产品要求支持 HTML + PDF,UX 上要跟 Typora / Obsidian 一致(选完路径直接写盘无对话框)。v0.4.7 最初版本选了 iframe + `window.print()` 弹系统对话框(用户自选"另存为 PDF"位置),但实际 UX 不够理想 —— 跟 Typora 一类工具的"静默导出"差距明显。

  后续重新评估四条 PDF 路径:
  - A) 走 `html2pdf.js` / `pdfmake` / `jsPDF` 等纯前端库:几百 KB 新依赖 + CJK 字体配置 + 跟现有 shiki/KaTeX/mermaid 渲染管线重复(得重排版)
  - B) 走 Tauri 2 暴露的 `printToPdf` API:Tauri 2 WebviewWindow **不**直接暴露 `printToPdf`(早期版本里有,后来被废弃/移除)
  - C) 走 `iframe + window.print()` 弹系统对话框(原方案):零依赖但 UX 差
  - D) **走 Tauri 2 `with_webview` 调平台原生 PrintToPDF API**(Windows `ICoreWebView2_7::PrintToPdf` / macOS `WKWebView::createPDFWithConfiguration:` / Linux `WebKitPrintOperation` + `output-uri`):复用应用自带的 webview 渲染引擎,**静默写盘无对话框**,与 Typora / Obsidian 一致;Typora(Obsidian 同款)用的就是 Electron 自带的 `webContents.printToPDF` —— 我们的等价物是 Tauri `with_webview` escape hatch。
  - 选 D。代价是 Rust 端引入 `webview2-com` 仅 Windows target(`tauri 2.11` 已经传递依赖,实际新增 Cargo.toml 行);macOS / Linux 需要后续补对应实现(暂返回 `PdfError::Unsupported`)
- **Decision**:
  1. **HTML 走 `buildExportHtml` + `writeTextFile`**:`lib/export/htmlRenderer.ts` 复用 `editor/markdownIO.ts` 的同一份 unified pipeline(7 个 remark 插件)parse 出 mdast,自写轻量 walker 转 HTML(不走 PM doc —— 省去 PM doc → mdast 二次桥接)。节点类型逐个 dispatch:`code lang='mermaid'` 走 `mermaidHtml`;其他 code 走 `shikiHtml`(复用 `CodeBlockLangs` 的 `getHighlighterSync` + `getTokensSync`,与编辑器内 `CodeHighlightWidget` token 渲染同套 API,保证配色一致);math 走 `katex.renderToString`;html 走 DOMPurify(`PURIFY_CONFIG` 与 `HtmlNodeView.ts:27-36` 同步,见维护者注意点 #13);image src 走 `convertFileSrc` 转 `asset://`。**降级策略**:任何渲染失败 → 走原文 `<pre>` 或 `<span class="math-error">` + 收进 `warnings` 数组,**不**抛错中断整次导出
  2. **PDF 走 Tauri command `export_pdf` 调平台原生 PrintToPDF**(v0.4.7 后替换原 iframe+print 方案):
     - **链路**:前端 `invoke('export_pdf', { outputPath, html })` → Rust command `pdf::export_pdf`(`src-tauri/src/pdf.rs`)→ `window.with_webview(|webview| ...)` 拿平台 handle → 三平台分发
     - **Windows**(`src-tauri/src/pdf_windows.rs`,完整实现):`controller.CoreWebView2()` 拿 `ICoreWebView2`,`cast::<ICoreWebView2_7>()` 拿 `PrintToPdf`,`cast::<ICoreWebView2Environment6>()` 拿 `CreatePrintSettings`(注意 v1 环境上没这个方法,必须 cast 到 v6);encode HTML 成 base64,`Navigate("data:text/html;base64,...")` 触发 HTML 加载(需要 tauri `webview-data-url` feature);注册 `NavigationCompletedEventHandler`(HTML 加载完后发起 `PrintToPdf`),`PrintToPdfCompletedHandler` 把结果通过 `tokio::oneshot` 桥接到 async command;`Arc<Mutex<Option<oneshot::Sender>>>` 共享 sender 防双重发送;全局 `tokio::Mutex<()>` `PRINT_LOCK` 防 WebView2 同时跑两个 print 崩溃;30s `tokio::time::timeout` 兜底防回调不触发永久挂起
     - **macOS / Linux**:当前返回 `PdfError::Unsupported("macOS")` / `Unsupported("linux")`,前端展示 "not supported on this platform yet" 错误。后续补完时是独立子任务(需要 `objc2-web-kit` / `webkit2gtk` 等新 Cargo 依赖)
  3. **dual themes → 单 theme + 自适应**:shiki token 仍写 `--shiki-light` / `--shiki-dark` 双 hex(同编辑器);dark 命中靠 `@media (prefers-color-scheme: dark)`,跟 GitHub README 同款自适应性。`@media print` 强制 light(白底黑字),避免 PDF 里整片黑底
  4. **saveDialog 多 filter 一键覆盖两产物**:顶栏单按钮 + `Ctrl/Cmd+Shift+E` → saveDialog filter 列出 HTML / PDF,按扩展名 dispatch
  5. **不**改 `currentFilePath` / `lastSavedContent` / `fs:watch` —— 导出是"产出一份静态文件",与"切换到那个文件继续编辑"是不同语义(避免选错扩展名默默污染 currentFilePath 引发后续 Ctrl+S 把 HTML 当 MD 覆盖回去丢数据)
- **Consequences**:
  - 前端零新依赖;复用 shiki / KaTeX / mermaid / DOMPurify,导出 HTML 配色与编辑器内一致
  - PDF 静默写到 `saveDialog` 拿到的目标路径,**不再**经系统打印对话框;UX 与 Typora / Obsidian 同款
  - Rust 端新增依赖(仅 Windows target):`webview2-com = "0.38"` + `windows = "0.61"`(`tauri 2.11` 已经传递依赖,实际增量编译代价小);通用:`thiserror` / `tokio` / `base64`(均已有版本可对齐 `Cargo.lock`)
  - **降级路径健壮**:jsdom 测试环境 mermaid 因缺 SVG BBox 失败 → 走 `<pre class="mermaid-error">` + warning 收进 `ExportResult.warnings`;KaTeX 语法错 → `<span class="math-error" title="errMsg">` 显示原文;shiki lang 未装 → 纯文本 `<pre><code>` 兜底
  - 已知限制:导出 HTML 的 image 走 `asset://` 协议,在 Tauri webview 内能解析,拿到外部浏览器打开会破图(见维护者注意点 #14);后续要做"导出带图片"得改成 inline base64 或把图片复制到 HTML 同目录
  - PDF 走平台原生而非 Puppeteer headless:省几百 MB Chromium 二进制 + CJK 字体问题,跟应用自身 webview 复用,渲染一致性最高
  - **跨平台一致性**:Windows 已完整实现 + 编译通过;macOS / Linux 暂时返回 Unsupported,需 macOS / Linux 环境开发者补完(独立子任务,不会污染 Windows 实现)
  - 已知遗留:HTML 注入 navigate(data_url) 后**不**自动 restore 主 webview URL,用户导出期间短暂看到 PDF 内容;可接受,后续可优化(在 PrintToPdf 完成后 navigate 回原 URL)
  - 导出测试 18 + 7 = 25 例,覆盖核心语法 / 降级 / store 合约(invoke PDF 路径) / reentrant 守门



## v0.5.0 — 工作区与文件树骨架  (2026-06-23)

### ADR-20260623-001: 工作区根走 recursive 单 watch 句柄,而非逐目录懒 watch

- **Context**: v0.5.0 文件树需要反映外部对工作区下任意子目录的增删改。两条候选:
  - A) 工作区根一个 `watch(root, { recursive: true, delayMs })` 单句柄,notify-rs 自带 delayMs burst 合并,cb 拿事件 paths 推断脏目录 → 重拉对应子树
  - B) 每展开一个目录挂一个 watch,折叠 unwatch,`Map<dir, UnwatchFn>` 管多句柄
  - 关键观察:`documentStore` 现有 `startWatchOf` / `stopWatch` 是 fire-and-forget 单句柄串行,理论 race 但单文件场景下被 `disk === lastSavedContent` 短路 + `externalCheckInFlight` 重入保护兜住,从未真触发。B 的多句柄生命周期把 race 风险从"理论"变"现实"(用户快速展开/折叠时 await stopWatch/await watch 交错可泄漏 / 串台),要做就得 per-dir 串行化队列,复杂度跳一档
- **Decision**: 选 A。工作区根挂单 recursive watch,事件回调把 `dirnameOf(event.paths)` 入脏目录集,前端 120ms 二次 debounce flush → `FileTree.refreshDir(dir)` 逐个重拉。activeRoot 变化时先 stop 后 start,沿用 documentStore 同款 race 容忍策略
- **Consequences**:
  - 生命周期单句柄,跟 documentStore 单文件 watch 同形,认知负担小
  - 当前文件 watch(documentStore)+ 工作区根 watch 共存,当前文件落在根树下会收到两份事件;documentStore 内 `disk === lastSavedContent` 短路已经去重,不需要额外协调
  - 深目录树事件量大,前端二次 debounce 的同时只对"脏目录集"按目录重拉(`readDir` 一次 < 5ms),不重拉整树
  - **已知限制**:notify-rs 对网络盘 / OneDrive / Dropbox 漏报在目录级比文件级更严重;窗口聚焦兜底(window-focus → checkExternalChange)只覆盖当前文件,工作区根侧无等价兜底,v0.5.0 接受。后续视用户反馈再决定加"重拉整树"按钮 / 自动


### ADR-20260623-002: 新建 `src/tauri/` 薄封装层,业务侧不再直 import `@tauri-apps/*`

- **Context**: v0.4.x 业务代码(`document.ts` / `persistence.ts` / `imageStorage.ts` / `export.ts` / `App.vue`)直接 import `@tauri-apps/plugin-fs` / `plugin-dialog` / `api/path`,测试 mock 散落打在各个 `@tauri-apps/*` 模块上。v0.5.x 起 fs 调用点会成倍增长(目录遍历 / 批量重命名 / 资产移动 / 文件树 watch / 多工作区切换);若不收敛,后续接 tauri-driver E2E 时需要逐处补 mock / 桩。候选:
  - A) 建 `src/tauri/{fs,dialog,path}.ts` 薄封装(re-export + 一个 `tauriOnly` 守门 helper),业务侧只 import 封装;测试 mock 单一入口
  - B) 沿用现状,业务直 import `@tauri-apps/*`
- **Decision**: 选 A。`src/tauri/fs.ts` 暴露 readDir / readTextFile / writeTextFile / readFile / writeFile / mkdir / remove / rename / exists / watch + `tauriOnly()`;`src/tauri/dialog.ts` 暴露 open / save / confirm / message;`src/tauri/path.ts` 暴露 appDataDir / join / dirname / basename / sep。一次性迁移 `persistence.ts` / `document.ts` / `imageStorage.ts` / `export.ts` / `App.vue` 全部调用点。封装层**不**统一错误形态 —— plugin-fs 自家不一致的错误形态(Error vs string)由调用方各自的降级策略消化(persistence 走默认值 / document.save 弹 message / imageStorage throw 透传),封装层重新包一层会破坏现有降级语义
- **Consequences**:
  - 业务代码不再出现 `@tauri-apps/*` import;测试 mock 后续可逐步从 `@tauri-apps/*` 收敛到 `src/tauri/*`(本次保留旧 mock 形态,vi.mock 透传,避免大改测试)
  - tauri-driver E2E 接入时,fs 边界是单一入口,横切关心(如"E2E 期间打 fixture 桩")集中加在 `src/tauri/*` 即可
  - `tauriOnly()` 守门从 persistence 模块内部 helper 提升为 `src/tauri/fs.ts` 命名导出,业务代码统一通过它判断 web dev 端降级
  - 封装层本身不写测试(测它等于测 mock,见 TESTING.md §8 反过度测试),保留薄度


### ADR-20260623-003: capability fs scope 保持 `**`,不收紧到工作区根内

- **Context**: `capabilities/default.json` 自 v0.3.x 起开 fs read-text-file / write-text-file / exists / watch / unwatch / mkdir / write-file / read-file / read-dir / remove / rename 全部 `allow: [{ path: "**" }]`。v0.5.x 起 fs 操作面变宽(目录遍历 / 资产移动 / 大量重命名),"是否要收紧到当前工作区根内"自然冒出来。三条候选:
  - A) 保持 `**`,UI 层做约束(destructive op 必弹 confirm)
  - B) 放弃 plugin-fs 直连,所有 fs op 改走自写 Rust command,在 Rust 侧校验路径必须在工作区根内
  - C) 动态 capability / scope 变量:Tauri 2 fs scope 是静态 glob,不支持引用运行时选的根路径,技术上无法直接表达"仅当前工作区根" —— C 退化为 B
- **Decision**: 选 A。理由:Velo 是本地单用户桌面编辑器,威胁模型是"用户主动打开的文件",`**` 不 worsen;对标 Typora / Obsidian / VS Code,本地编辑器 fs scope 本就是 `**`。B 等于重写 fs 访问层,只在"处理不可信工作区 / 多租户"时才有意义,Velo 不是。安全性靠 UI 层 destructive op 二次确认(删除 / 移动资产 / 跨工作区操作 pre-confirm)
- **Consequences**:
  - 工作区切换 / 文件树打开任意位置文件均不受 scope 限制,实现简单
  - v0.5.1 资产面板"复制图片到工作区 assets/" 需要 `fs:allow-copy`,届时补 capability;`fs:allow-stat`(资产元数据)同理按需补
  - **不会**反复推翻:把"scope 不收紧"显式 ADR 留痕,避免日后"应该收紧"的直觉再次被翻出来

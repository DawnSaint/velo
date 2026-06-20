# Velo Changelog

> 重大架构决策与重大重构的 ADR（Architecture Decision Records）。



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



## v0.4.6 — mermaid 重构：走 `code_block` + SVG widget

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


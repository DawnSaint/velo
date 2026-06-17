# Velo Changelog

> 重大架构决策与重大重构的 ADR（Architecture Decision Records）。
> 本文件只记录"为什么走这条路的取舍"；普通 feat / fix / refactor / test 不迁移，完整变更以 `git log` 为准。
> 当前 / 下一版本 To-Do → 见 [`ROADMAP.md`](./ROADMAP.md)。
> 当下代码层的"为什么这样写" → 见 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的"设计要点 / 维护者注意点"段。

---

## v0.3.2 — 图片  (2026-06-12)

### ADR-20260612-001: Tauri 2.5 `plugin-fs` 必须显式开 `watch` feature

- **Status**: Accepted (2026-06-12)
- **Context**: JS 端 `invoke('plugin:fs|watch')` 报 `Command watch not found`；upstream `@tauri-apps/plugin-fs@2` 默认 `features = ["fs"]` 不含 `watch`，`Cargo.toml` 写 `"2"` 也不会自动开
- **Decision**: `src-tauri/Cargo.toml` 显式写 `features = ["watch"]`
- **Consequences**: 跨平台文件监听可用（`tauri-plugin-fs` 的 `watch` feature）；新增 feature flag 需要在 CI 多平台矩阵中验证

---

## v0.3.3 — BUG 修复和部分重构  (2026-06-13)

### ADR-20260613-001: mermaid 走 `Decoration.widget`，不走 NodeView

- **Status**: Accepted (2026-06-13)
- **Context**: mermaid SVG 渲染需要改写 atom 节点 outer dom 的 `innerHTML`；ProseMirror 的 `DOMObserver` 会把它当外部突变 → `readDOMChange` → `view.updateState` → 整个 view tree 重 mount，所有 NodeView destroy + recreate，用户每敲一字符 mermaid 全闪 loader
- **Decision**: 改用 `Decoration.widget`（`WidgetViewDesc.ignoreMutation` 默认忽略所有非 selection 突变），NodeView 整层移除
- **Consequences**:
  - schema toDOM 输出 `height: 0` 隐藏占位（atom 节点必须有 dom 用于 `posAtCoords` / selection 映射，藏视觉即可）
  - plugin promise resolve 后**直接**在 widget dom 上写 svg，**不要** dispatch setMeta 触发 `buildDecorations`（否则新 Decoration 实例的 `WidgetType.eq` 比对失败 → widget 复用失效 → 死循环）
  - 主题切换走 widget 工厂里挂 `velo:theme-change` window listener 自己改 dom，不走 plugin setMeta 路径（同上死循环原因）；decoration `spec.destroy` 钩子负责 `removeEventListener` 防泄漏

---

## v0.4.0 — milkdown 重构  (2026-06-13)

### ADR-20260613-002: 编辑器从 Milkdown 迁到 ProseMirror + remark/unified

- **Status**: Accepted (2026-06-13)
- **Context**: Milkdown 抽象层（`$prose` / `$inputRule` / `$remark` 包装）遮蔽 ProseMirror 原生行为，upstream `markRule` 正则 bug 要写补丁绕开；传递依赖 96 个包冗余；`@milkdown/vue` 的生命周期 hook 不够灵活
- **Decision**: 拆 3 阶段（feature flag 灰度 → 接入 → 清理），逐步迁到裸 ProseMirror + `remark-parse` / `remark-stringify` + 自写 mdast↔PM 转换
- **Consequences**:
  - 净减 96 传递包（删 `@milkdown/*`）
  - 后续 ProseMirror 原生能力（`Decoration.widget` / `appendTransaction` / NodeView API）可直接用
  - 失去 Milkdown 插件生态（但本项目不需要，自己写 NodeView / remark 插件更直接）

---

## v0.4.1 — 增加语法渲染  (2026-06-15)

### ADR-20260615-001: 语法实时转换走 `appendTransaction` 框架

- **Status**: Accepted (2026-06-15)
- **Context**: 历史上每条语法各自一个 `InputRule`（末尾紧贴 `$` 锚）+ link 单独一份 `linkAutoFormatPlugin`（全文扫描）。问题：① 反向输入（如先 `]` 再补 `[^xxx`）不触发 InputRule；② 粘贴 / 中间编辑不响应 InputRule；③ 块级语法（`### ` / `> ` / `- ` 等）根本无人接管，**只能渲染已写好的、不能输入触发**；④ 每条规则各自处理黑名单 / 编辑态 session，扩展成本高
- **Decision**: 新框架 `plugins/syntaxAutoFormat.ts` 单 `appendTransaction`，从 `tr.mapping.maps` 提 dirty range → 扩展到 textblock → 对每个 textblock 跑 `syntax/block/*` 段首检测 + `syntax/inline/*` 段内 g 正则检测
- **Consequences**:
  - 敲一字符 = 扫一段；粘贴整段 = 扫被粘入的 N 段；无全文重扫
  - 黑名单（`code_block` / `html_block` / `mermaid` / `math_block`）、`code` mark、`linkClickPluginKey.session` 范围由框架统一过滤，语法定义只写 `pattern + apply`
  - 新增语法 = 写一个文件 + 在 `syntax/index.ts` 注册一行
  - `InputRule` 仅保留 `ellipsis` / `emDash` 这种纯文本→纯文本的快速路径
  - 坑：block detector 要求 `pattern` 带 `^`、不带 `g`；inline 反过来要求带 `g` 不带 `^/$`，框架做 `pattern.global` 防御但不自动改写

---

## v0.4.2 — 代码整理  (2026-06-15)

### ADR-20260615-002: 编辑器重建走 `view.updateState(EditorState.create(...))`

- **Status**: Accepted (2026-06-15)
- **Context**: 旧路径用 `innerKey` ref 触发整个 `EditorView` destroy + recreate（`:focus-on-create` prop），`modelValue` 变化时（切文件 / 新建 / 外部同步）频繁闪烁且丢失 IME composition 状态
- **Decision**: `EditorInner.vue` 内部直接 `view.updateState(EditorState.create(...))` 替换内部 state，plugin state 因 init 跑归零（等价 destroy + recreate 但不销毁 view 实例）；`index.vue` 不再参与重建控制
- **Consequences**:
  - 删除 `innerKey` ref + `onRebuildRequest` + `:focus-on-create` prop
  - 外部 modelValue 变化用 `lastSelfEmitted` 哨兵探测（自己 emit 的 echo 跳过），不匹配时 `view.updateState` 替换内部 state
  - 比 `isInternalChange + nextTick` 时序标志更稳，避免竞态

---

## v0.4.3 — 代码块升级  (2026-06-16)

### ADR-20260616-001: 代码块高亮从 highlight.js CDN 迁到 shiki + css-variables

- **Status**: Accepted (2026-06-16)
- **Context**: 原方案依赖 CDN hljs，离线不可用；切暗色主题要重跑高亮导致闪烁；`codeBlockTheme` setting 字段与全局 `darkMode` 行为分叉
- **Decision**: shiki 4.x 本地 npm + css-variables 主题模式，token 颜色通过 `var(--shiki-xxx)` 引用 CSS 变量；切 `darkMode` 不重跑高亮
- **Consequences**:
  - 新增 30 个开放语种清单 + 浮层 UI（`CodeBlockLanguagePicker.vue` 通过 Teleport 挂 body，支持搜索 + 自定义输入）
  - 代码块工具条：一键复制（走 `@tauri-apps/plugin-clipboard-manager`，失败闪 `✗` 1.5s 不抛错）
  - `codeBlockTheme` setting 字段从 store / persistence / settings 全部清除，代码块主题跟随全局 `darkMode`
  - `_editor-code.scss` 重写为 shiki 主题色板，light 写在 `html:not(.dark) .velo-editor pre`，dark 写在 `html.dark .velo-editor pre`
  - 工具条 widget 必须用真盒子（`display: block; height: 22px`），不能用 `display: contents` —— 后者让元素 hit-test 边界消失，`:hover` 命中不到

### ADR-20260616-002: 代码块工具条几何同步链路与"转 NodeView"备选路径

- **Status**: Accepted (2026-06-16)
- **Context**: v0.4.3 工具条用 `Decoration.widget(side: -1)`，widget 是 `<pre>` 的**兄弟节点**，几何上跟 pre 没有任何绑定关系。`syncPosition` 用 `getBoundingClientRect()`（视口坐标） + `wrap.offsetParent` 换算把 widget absolute 定位同步到 pre 内部右上角。这套坐标系依赖 3 个触发源：① `window.resize`；② `window.scroll`（capture）；③ `ResizeObserver` 观察 pre 自身 + `wrap.offsetParent`。
- **Problem**: App.vue 用 `aside.w-0/w-64` + ProseMirrorEditor `flex-1` 切大纲/设置面板，**容器宽度变了但没触发 window.resize / window.scroll**，工具条 widget 的 inline style 还是旧的 → "漂到其他地方"。第一次修复加了 RO 观察 `wrap.offsetParent` 但**没生效**：同步执行 `makeToolbarDom` 时 widget 还没挂到 DOM，`wrap.offsetParent === null`，`ro.observe(null)` 报错被吞、RO 整个没建立。
- **Decision**: 同步监听只能监听**稳定后**的元素 — RAF 后再 `ro.observe(wrap.offsetParent)`；同时观察 pre 自身 + offsetParent 覆盖"内部 layout 变化"路径
- **Consequences**:
  - 排查清单：① 同步执行时 offsetParent 必为 null → RAF 后再拿；② 祖先有 `transform` / `filter` / `will-change` / `perspective` 会让 absolute 子元素的 offsetParent 跳到该节点（绕过最近的 `position: relative` 祖先）；③ 祖先有 `overflow: hidden` + `position: relative` 会裁切 absolute 兄弟节点；④ 任何让 PM 容器变宽变窄但不改 window 的 layout（splitter / 抽屉 / 多面板）都要回头补 RO
- **备选方案 — 转 NodeView（未实施，留底）**: 当前 widget 路径下，几何同步靠"JS 跑同步 + 多触发源监听"，是**补丁式不变量**。如果同步问题持续恶化（RO 救不回的 ancestor transform / splitter 越来越多），把整个 `code_block` 从 `toDOM + decoration widget` 改成 NodeView（参考 `mermaid` / `math_block` / `image` 同款 `Plugin.props.nodeViews`）：
  - 工具条 DOM 直接 `appendChild` 到 `<pre>` 内部，`position: absolute; top: 6px; right: 8px`，**几何上**跟 pre 完全绑定，同步链路全部消失
  - 不再需要 syncPosition / wrap.offsetParent / ResizeObserver / window scroll 监听
  - 不再需要 widget 真盒子 hack + `:has(+ pre:hover)` — 工具条是 pre 的真子元素，`pre:hover > .velo-code-toolbar-widget` 直接命中
  - 不再需要 widget key 含 lang+hash 强制重挂
  - 风险：NodeView outer dom 改 innerHTML 会被 DOMObserver 当外部突变触发 rebuild（参见 mermaid 教训 ADR-20260613-001），但代码块工具条不重写 code 内容，只改按钮文字，Mutation 极少，风险远低于 mermaid 那次

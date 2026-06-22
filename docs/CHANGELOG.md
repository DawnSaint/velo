# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> 重大架构决策的取舍记录见 [`DECISIONS.md`](./DECISIONS.md)；当前设计状态与踩坑记录见
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的"设计要点 / 维护者注意点"。本文件只记
> **用户可见**的版本变更；普通 feat / fix 的 source of truth 是 `git log`。

## [Unreleased]

### Added
- **导出功能 (HTML / PDF)**：顶栏新增"导出"按钮（`Ctrl/Cmd+Shift+E`），弹原生 saveDialog 选 HTML / PDF。
  - **HTML**：自包含文档，mermaid / KaTeX / 代码高亮 / 任务列表 / 警告框 / GFM 表格 / 脚注 / kbd / mark 全部内嵌；图片走 `asset://` 协议在 Tauri webview 内可显示；自适应 `prefers-color-scheme` 暗色；导出失败有 warnings 收集而非中断。
  - **PDF**：经 Tauri 调平台原生 PrintToPDF 静默写盘，**不弹任何系统对话框**（与 Typora / Obsidian 同款 UX）。Windows 已实现；macOS / Linux 暂不支持。

### Changed
- 引入导出管线端到端 + store 合约测试。

### Fixed
- 导出 HTML / PDF 中 `[TOC]` 不被识别为目录（原当普通段落输出，目录结构丢失）。
- 导出 HTML / PDF 中脚注引用端视觉与编辑器不一致（无主色 / 无 hover / 无焦点反馈）。


## [0.4.6] — 2026-06-21

### Added
- **Mermaid 改走标准代码块管线**：shiki 语法高亮 + SVG 预览 + 语言切换 / 复制工具条一体化，输入即所得，无需磁盘往返"激活"。
- **Mermaid 主题感知配色**：旁路 shiki 薄弱的 mermaid grammar，颜色跟随当前代码块主题与 dark / light 切换。
- **源代码模式迁移到 CodeMirror 6**：软换行、持久行号、shiki 双主题高亮、撤销栈、特殊字符高亮。
- **跨模式光标与浏览状态同步**：切换 WYSIWYG ↔ 源码模式时落在视觉对应处而非跳回文档顶。
- **源代码模式查找替换**：与 WYSIWYG 共用面板，query 跨模式保留。
- **code_block Backspace 隔离**：起点按 Backspace 不误拆 defining code_block。
- **任务列表两阶段升级**：在已有 list_item 内键入 `[ ] ` / `[x] ` 切换状态。
- **完整 CommonMark 主题分隔线**：`-` / `_` / `*`，无需尾随空格。
- 源码模式禁止拖入文件 / 粘贴图片（对齐 Typora）。

### Changed
- Mermaid 不再是 atom 节点：选区 / 键盘 navigation 从"整块选中"变为"逐字符编辑"。

### Fixed
- Mermaid 删除按钮范围错位（残留 open token 并把下一段并进来）。
- Mermaid pre 首次插入后自动隐藏。
- 查找替换切模式后找不到匹配。

### Removed
- Mermaid 旧 textarea 实时预览路径（约 250 行）。
- `MERMAID_REFACTOR_EVAL.md`（决策已沉淀为 ADR）。

### Dependencies
- 新增 `@codemirror/commands`、`@codemirror/state`、`@codemirror/view`。


## [0.4.5] — 2026-06-19

### Added
- **`[TOC]` 目录支持**：`[TOC]` 独占段落自动渲染为动态目录（点击跳转 + 闪烁反馈），实时键入自动转换；hover 显示垃圾桶图标，点击还原为 `[TOC]` 段落（保留撤销）。

### Fixed
- 多段 Markdown 粘贴错位（heading 与 strong 等错位）。


## [0.4.4] — 2026-06-18

### Added
- **声明式快捷键注册表**：改键位改一处即可。
- **`==highlight==` 高亮 mark**。
- **`**bold**` / `__bold__` / `*italic*` 实时键入**。

### Deprecated
- 水平线快捷键（`Mod-Shift-h`）验收未生效，延期后续版本。


## [0.4.3] — 2026-06-18

### Added
- **shiki 双主题代码高亮**：替换 CDN 加载的 highlight.js，零重渲切色。
- **代码块工具条 + 语言选择**：20+ 常用语言，全部本地打包无 CDN。
- **主题设置**：66 个 shiki 主题下拉选择，启动仅懒加载当前主题对。
- **首屏零闪烁守门**。
- **崩溃恢复草稿**：脏盘期间每 30s 自动保存，启动时提示恢复。
- **代码块启动期预扫 + 懒加载语言**：首屏 grammar 大幅降低。
- 工具条几何同步（修复侧边栏开合导致的工具条漂位）。
- `isTauri()` 守门（dev web 端不阻断 async 链）。

### Changed
- 代码块主题弃用跟随 darkMode（旧 settings 文件残留字段被忽略）。
- 升级示例 markdown 覆盖全语法演示。

### Fixed
- `code_block` 内 Enter 误拆段。
- WASM 在 Tauri build 中失效（CSP 加 `'wasm-unsafe-eval'`）。

### Dependencies
- 新增 `shiki`、`@shikijs/langs`、`@shikijs/themes`、`@tauri-apps/plugin-clipboard-manager`、`tauri-plugin-clipboard-manager`。
- Tauri 加 `devtools` feature + `open_devtools` command。


## [0.4.2] — 2026-06-15

### Changed
- **CSS 分层**：660 行 `<style>` 拆到 9 个 SCSS partial。
- **命名清理**：`.milkdown-*` 全部改 `velo-` 前缀。
- **编辑器重建路径简化**：view 实例稳定，不再整体重挂。

### Fixed
- `velo-drop-cursor` 不显示。
- 链接 `[text](url 含内部空格)` 解析失败。
- 锚点跳转不匹配（带空格链接）。

### Removed
- 删 `paragraph.attrs.empty` 死属性。
- 删 `prosemirror-caret-hidden` 老 bug 代码。


## [0.4.1] — 2026-06-15

### Added
- **链接渲染**：Cmd / Ctrl+click 跳转外部链接，`[text](url)` 自动补全，选中内容自动格式化。
- **GitHub 风格警告框**：5 种变体（note / tip / important / warning / caution），完整双向 markdown 映射。
- **HTML 透传**：通过 DOMPurify 安全渲染标签（如 `<kbd>`、`<details>`）。
- **语法实时转换框架**：新增语法只需写一个文件并注册一行。
- **键入即转化的块级语法**：heading / blockquote / bullet_list（含 task）/ ordered_list / code_block / hr / alert 共 7 类。
- 行内语法反向输入修复（footnote / link / math / emphasis / strike "先 `]` 再补 `[^xxx`"不触发）。

### Changed
- InputRule 收敛进 syntax registry。

### Fixed
- list_item Enter 行为错误（空 list_item 按 Enter 正确退化为普通段落）。
- 空行保留（修复显示与 round-trip 翻倍）。
- CRLF / CR 文件多空行识别。

### Dependencies
- 新增 `dompurify`、`@tauri-apps/plugin-shell`。


## [0.4.0] — 2026-06-13

### Added
- **编辑器从 Milkdown 迁移到裸 ProseMirror + remark/unified**：Milkdown 抽象层对每条自定义语法都是纯开销，迁移后净减 96 个传递依赖。
- 自建 schema（22 节点 / 5 mark）+ unified pipeline（remark-parse + remark-gfm + remark-math）。

### Changed
- 迁移 11 个 nodes / findreplace / image / plugins 文件。

### Removed
- 删 `src/components/MilkdownEditor/`（18 文件）。
- 卸载 `@milkdown/*`（净 -96 传递依赖）。
- 删 `VITE_USE_PM` feature flag，硬切到 ProseMirrorEditor。

### Fixed
- 迁移期回归（均补回归测试）：Enter 不换行、Backspace 选整段、`$x$` 不转 math_inline、Shift-Tab 非列表上下文失焦。


## [0.3.3] — 2026-06-13

### Changed
- **Mermaid 改用 `Decoration.widget`**：原 NodeView outer dom 突变触发整块 remount + 每字符闪烁。
- **编辑器目录拆分**：拆为 `nodes/` + `findreplace/` + `image/` + `plugins/` 子目录。

### Removed
- 删 `MermaidNodeView.ts`（改走 widget 方案）。


## [0.3.2] — 2026-06-12

### Added
- **图片粘贴 / 拖拽落盘**：保存到 `<fileDir>/assets/`（已保存文档）或 `<appDataDir>/assets/`（未命名文档），markdown 使用相对路径便于文档迁移。
- **SHA-256 内容级去重**：重复导入同一张图复用已有文件。
- **image-inline NodeView** + Tauri `asset://` 协议代理本地图片。
- **Atom 节点删除保护**：Backspace / Delete 紧贴 atom 节点先选中再删。
- **图片上传插件** + 图片路径工具链。
- **Tauri asset 协议**：CSP / 作用域 / fs 权限配置。

### Fixed
- tauri-plugin-fs watch feature 门控（修复 `Command watch not found`）。


## [0.3.1] — 2026-06-09

### Added
- **编辑器内查找 / 替换**（Ctrl+F / Ctrl+H）：大小写 / 全词 / 正则匹配、命中高亮、计数、导航与替换。
- 工具栏搜索按钮 + 全局 Ctrl+F / Ctrl+H 快捷键。
- 行首 `$$` + Enter 快速插入空数学公式块。
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
- **设置持久化**：字号 / 主色 / 字体 / 暗色 / 代码块主题 / 自动保存等全部持久化。
- **大纲折叠状态持久化**，按文件路径区分。
- **崩溃恢复**：脏盘期间每 30s 落盘草稿，启动时检测并提示恢复。
- **任务列表**：`[ ]` / `[x]` 编辑器内点选切换。
- **脚注语法**：渲染、Ctrl / Cmd+点击跳转 def、def 末尾回链 ref。
- **状态栏**：字数 / 词数 / 行数。

### Changed
- **编辑器生命周期交给 `@milkdown/vue`**：删手写的 createEditor / onMounted / 守卫逻辑，改用自管挂载。
- 抽 `outline.ts` / `plugin-common.ts` 共享逻辑。

### Fixed
- 左侧大纲超长无滚动条。
- 大纲标题里 `_` `*` 等符号被多余反斜杠显示。
- 粘贴 markdown 源码不被识别为富文本。
- Mermaid / math textarea 粘贴内容被外层 ProseMirror 抢走。
- `save` / `saveAs` / `openPath` 失败时缺反馈，改为弹原生 message。
- 行内公式编辑态键入抛 `ReferenceError`。
- `recoverDraft` 后被 focus / fs:watch 静默用磁盘旧版本覆盖。
- 切文件后编辑器不自动获取焦点。
- `syncTitle` 在非 Tauri 浏览器环境同步抛 `TypeError` 致白屏。

### Test
- 引入 Vitest + jsdom + Tauri mock。
- 纯函数 / Pinia store / ProseMirror 插件集成测试，共 101 个测试。

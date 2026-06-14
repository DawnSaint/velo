# Velo Roadmap

规划后续版本的迭代方向



### v0.3.x — 持久化与基础补齐



#### v0.3.0 — 持久化与基础补齐

**feat**

- [x] 持久化所有用户设置(字号、主色、字体、暗色、代码块主题、自动保存等)至 `app_data_dir`
- [x] 持久化大纲折叠状态，按文件路径为 key 区分
- [x] 崩溃恢复：脏盘期间定时落盘草稿，启动时检测并提示恢复
- [x] 任务列表 `- [ ]` / `- [x]` 支持在编辑器内点选切换
- [x] 脚注语法支持(渲染 + 点击跳转 + 末尾回链)
- [x] 字数 / 词数 / 阅读时间状态栏

**fix**

- [x] 修复左侧大纲超出长度无滚动条
- [x] 修复大纲中标题里的 `_` 等符号被多余 `\` 反斜杠显示
- [x] 修复粘贴 markdown 源码(`**bold**` 等)不被识别为富文本格式
- [x] 修复 mermaid / math 的 textarea 粘贴内容被外层 ProseMirror 抢走

**refactor**

- [x] 编辑器生命周期交给 `@milkdown/vue`：`MilkdownEditor/index.vue` 内手写的 `createEditor()` / `onMounted` / `onUnmounted` / `watch(modelValue)` / `isInternalChange` 标志位 / 220ms `setTimeout` 守卫全部删除，改为拆出 `MilkdownEditor/EditorInner.vue` 用 `useEditor()` + `<Milkdown />` 自管 mount/unmount/destroy。

**test**

- [x] 阶段 0 — 基础设施(Vitest + jsdom + CI 门禁)
- [x] 阶段 1 — 纯函数(`EditorOutline` 大纲解析)
- [x] 阶段 2 — Pinia store(状态机回归)



#### v0.3.1 — 编辑器内查找替换

**feat**
- [x] 查找替换 (Ctrl+F / Ctrl+H)：大小写、全词、正则三档选项
- [x] 大纲当前标题高亮改为主题色

**fix**
- [x] 修复 mermaid 主题切换错位的问题
- [x] 修复主题切换时 mermaid 反复坍缩再展开导致闪烁的问题
- [x] 修复行内公式 `$xxx$` 不能正确渲染的问题
- [x] 修复文档中空行不能被渲染的问题
- [x] 修复滚到顶端 / 刚进入编辑器时大纲不高亮第一个标题的问题
- [x] 修复插入公式后 ProseMirror 自动追加 separator / trailingBreak 占视觉空间的问题
- [x] 修复脚注在段首被解析成脚注的问题，移除孤儿脚注的波浪下划线
- [x] 修复 `$$` + Enter 无法插入 math_block 的问题



#### v0.3.2 — 图片

**feat**

- [x] 图片粘贴 / 拖拽落盘到 `<fileDir>/assets/`(untitled 走 `appDataDir/assets/`)
- [x] 图片相对路径 / 绝对路径识别
- [x] 图片删除文件跟随(用户删唯一引用时 confirm 删磁盘文件)


**fix**

- [x] Tauri 2.5 `tauri-plugin-fs` 默认不开 `watch` feature → `plugin:fs|watch` 命令未注册，JS 端 `invoke` 抛 "Command watch not found"。`Cargo.toml` 显式开 `features = ["watch"]`，文件监听正常工作



#### v0.3.3 — BUG 修复和部分重构


**fix**

- [x] 修复 mermaid 在用户每次输入字符时整块销毁重建闪烁的问题

**refactor**

- [x] `MilkdownEditor/` 按功能分子目录:`nodes/` (节点 NodeView/Schema)、`findreplace/`、`image/`、`plugins/`，根目录只留 `index.vue` + `EditorInner.vue`
- [x] math block view 抽 textarea 编辑器(`createTextareaEditor`)，取代 `plugin-common.ts` 小工具集；
- [x] mermaid 改用 `Decoration.widget`(widget 由 ProseMirror View 自己管理，内部 mutation 不再触发 DOMObserver)，NodeView 整层移除

**style**

- [x] 顺手调整了正文标题(h1-h6)的字号/装饰(h1 居中放大、h2 加底边、h3 移除原 4 边框 tint 框等)；不是本次 refactor 主线目标，但跟着 CSS 重组一起改了



### v0.4.x


#### v0.4.0 — milkdown 重构


**详细评估**:见 [`docs/MIGRATION_PROSEMIRROR.md`](./MIGRATION_PROSEMIRROR.md)。

**refactor**

- [x] Phase 1 — 基础设施(藏在 feature flag 后，旧路径保留)
  - [x] 依赖:加 `prosemirror-*` / `remark-*` / `mdast-util-*`(已是传递依赖，显式化即可，无新下载)
  - [x] `composables/useProseMirror.ts` 替代 `useEditor()` + `<Milkdown />`
  - [x] `editor/schema.ts` 基础 schema(等价 preset-commonmark + gfm)
  - [x] `editor/markdownIO.ts` markdown ↔ ProseMirror doc 双向(unified + remark + 自写 mdast↔PM)
  - [x] `editor/imageNodeView.ts` 替代 `imageInlineComponent`(极简版，空态仅提示)
  - [x] `__tests__/markdownIO.test.ts` round-trip 10 sample 全绿
  - [ ] ~~`nodes/MathSyntax.ts` 接管 `@milkdown/plugin-math` 的 `$...$` / `$$...$$` 解析~~ → markdownIO 已通过 `remark-math` 接管，KaTeX 渲染走旧 `MathNodeViews.ts`，Phase 2 改 import
  - [ ] ~~`nodes/MermaidSyntax.ts` `$nodeSchema` 宏 → 裸 `Schema.spec`~~ → schema 已合并进 `schema.ts`，转换走 markdownIO，Phase 3 删旧文件
- [x] Phase 2 — 接入
  - [x] 11 个 nodes/ + findreplace/ + image/ + plugins/ 文件搬迁 + 改 import + 解 `$prose`/`$inputRule`/`$remark` 包装
  - [x] 4 个 `__tests__` 文件搬迁
  - [x] `EditorInner.vue` 重写用 `useProseMirror` 装配
  - [x] `index.vue` 删 `MilkdownProvider`
  - [x] `App.vue` 接 `VITE_USE_PM=1` flag 切换
  - [x] 跑通 `vitest run` 全绿(227/227) + `vue-tsc --noEmit` 0 错 + `vite build` 双路径都通过
- [x] Phase 3 — 清理
  - [x] 删 `safeCommonmark` / `safeGfm` / `fixedEmphasisUnderscoreInputRule` / `fixedStrikethroughInputRule` 及 `$prose` / `$inputRule` 包装
  - [x] 跑 MIGRATION_PROSEMIRROR.md §6.3 手动回归清单(12 项)
  - [x] 删 `src/components/MilkdownEditor/`(18 个文件)
  - [x] 删 `@milkdown/*` 依赖(净减 96 传递包)
  - [x] `App.vue` 删 `VITE_USE_PM` flag + MilkdownEditor import
  - [x] 注释里 4 处过期 "MilkdownEditor" 引用改写为 ProseMirrorEditor

**fix**

- [x] 移除 upstream `markRule` 正则 bug 补丁(见 `ARCHITECTURE.md` "v0.4.0 重构记录" 段)，裸 ProseMirror 不需要这层防御
- [x] Enter 不换行 → 补 `keymap(baseKeymap)` + 显式 `chainCommands(..., splitBlock)`
- [x] Backspace 选中整段 → imageKeymap 改 `type.name` 比对(ProseMirror 陷阱 `$pos.nodeBefore` 在文本中间返回 atom 化 text 切片)
- [x] `$x$` 不转 math_inline → 加 inlineMathInputRule(remark-math 只管外部解析,实时键入需显式 InputRule)
- [x] 非列表 Shift-Tab 丢焦点 → 返回 `true` 消费 + ProseMirror 自动 preventDefault

**test**

- [x] 现有 `__tests__/` 改 import:`@milkdown/prose/*` → `prosemirror-*`
- [x] 新增 round-trip 测试:10 个 sample 循环 `fromMarkdown → toMarkdown → normalize`
- [x] 现有测试全绿(FootnoteNodeViews / findMatches / preserveEmptyLine)
- [x] 新增 4 个回归合约测试:`baseKeymap` / `backspaceRegression` / `shiftTabFocus` / `inlineMathInputRule`

**docs**

- [x] `docs/ARCHITECTURE.md` 删除 "Plan B 模块身份" 段、"已修复的 upstream 问题" 段，Milkdown 插件链表格重写为裸 ProseMirror 插件链，新增"v0.4.0 重构记录"段


#### v0.4.1 — 增加语法渲染

**feat**

- [x] `[text](url)` 链接语法渲染(沿用 `prosemirror-markdown` 自带 link mark + schema)
- [x] 警告框渲染(`remarkAlert` 改写 mdast `> [!NOTE]` → `alert` schema 节点,5 种 variant note/tip/important/warning/caution,反向 toMarkdown 用 mdast `html` 节点绕过 `[` 转义)
- [x] html 语法渲染(`html_block` / `html_inline` 节点 + `HtmlNodeView` 用 DOMPurify sanitize 后 innerHTML 写入;行内 `<kbd>Ctrl</kbd>` 等用 `mergeHtmlInlineRuns` 合并被 remark 拆散的标签段)

**fix**

- [x] 修复空行无法正常显示的问题(`v0.4.0` markdownIO 重构后,`preprocessBlankLines` 注入的 `<br />` 走 `html_block` 路径渲染成单独 `<div>`,不是空段;改成 `paragraph([])` 空 childCount + `toMarkdown` 用 `text` 节点占位 + 调整 `preprocessBlankLines` 公式为 `match.length / 2 - 1`,实现 `1 空段 round-trip 后仍 1 空段` 不翻倍)



#### v0.4.2 — 沉浸式写作

**feat**

- [ ] 专注模式：当前段落外的内容降透明度
- [ ] 打字机模式：光标锁屏中
- [ ] 全屏模式
- [ ] 保持窗口最前


#### v0.4.3 — 代码块升级

**feat**

- [ ] 代码块支持语言选择和语法高亮



#### v0.4.4 — 目录

**feat**

- [ ] 增加目录的渲染



#### v0.4.5 — 插件回归测试


**feat**

- [ ] 源代码模式

**test**

- [ ] 阶段 3 测试组件引入





### v0.5.x — 工作区与文件管理


**目标**

- 工作区层：以目录为单位的资源聚合视图，文件树可浏览、操作。
- 资产管理层：已粘贴图片可被集中查看、定位、重新组织。
- 视图层：大纲与文件树统一在侧边栏，提升空间利用率。



#### v0.5.0 — 工作区与侧边栏文件树

**feat**

- [ ] 侧边栏文件树：目录懒加载、点开、右键菜单(新建 / 重命名 / 删除 / 在资源管理器中显示)
- [ ] 工作区概念：以根目录为粒度，记录展开状态
- [ ] 侧边栏统一收纳大纲与文件树，二者可切换
- [ ] 打开最近文件功能



#### v0.5.1 — 资产面板与拖入文件

**feat**
- [ ] 资产面板：展示当前文档引用过的所有图片(本地 + 外链)，支持点击定位
- [ ] 拖入文件：从文件树拖入编辑器直接打开



#### v0.5.2 — 大纲搜索与状态栏集成

**feat**
- [ ] 大纲搜索过滤
- [ ] 状态栏集成工作区信息



#### v0.5.3 — 组件层与端到端测试

**test**
- [ ] 阶段 4 — 组件层(随 v0.3.x / v0.5.x 持续补)
- [ ] 阶段 5 — 端到端(跨组件状态流出现时启动)

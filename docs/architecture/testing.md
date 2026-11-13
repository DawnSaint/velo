# Testing Architecture

> **本文件负责**: 测试目标 / 选型 / 现状、单测/集成规约、Tauri 测试边界、反过度测试原则。
>
> **何时阅读**: 新增 / 删除测试文件、修改测试基建、调整测试规约、发版更新测试现状，或需要判断“该不该写测试”时。
>
> **先记住**:
> - 回归保护优先，不追求 100% 覆盖。
> - 最便宜层优先，纯函数能覆盖的别上组件，组件能覆盖的别上 UI。
> - 测行为不测实现；纯展示、薄封装、样板代码通常不测。
> - Tauri 边界一律 mock；不在 Tauri runtime 里跑测试。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [Tauri 架构](./tauri.md) / [ROADMAP](../ROADMAP.md)

---

## 目标与原则

1. **回归保护优先** —— 测试是业务代码改动的快速反馈机制(秒级),不以覆盖率数字为考核指标。
2. **从纯函数到 UI** —— 价值密度最高的逻辑(状态机、文本解析、插件)全部与 DOM 解耦,优先用最便宜的工具覆盖。
3. **Tauri 边界一律 mock** —— 测试不在 Tauri runtime 里跑,通过一层薄薄的 stub 把 `@tauri-apps/*` 隔在 store / 工具函数之外。
4. **测行为不测实现** —— 断言“输入 → 用户可观察输出”,不测 class 名 / ref 名 / 内部分支 / 函数是否被调用。
5. **最便宜层优先** —— 纯函数能覆盖的别上组件 mount,组件能覆盖的别上完整 UI 链路。
6. **不追求 100% 覆盖** —— 覆盖率只用来发现“哪块完全没被测过”,不用来刷分。

---

## 选型

| 层 | 工具 | 理由 |
|---|---|---|
| 单测 / 集成 | **Vitest 5.1** | Vite 原生,TypeScript + ESM + JSDOM 一把梭,极快 |
| 组件 | **@vue/test-utils** | Vue 3 官方 |
| 覆盖率 | **@vitest/coverage-v8 5.1** | 看个大概,不卡阈值 |
| 断言辅助 | **@testing-library/jest-dom** | 组件断言更语义化(可选) |

> **版本约束** —— Vitest 5 要求 Node ≥ 22.12、Vite ≥ 6.4,且 `vite` 已成为必需 peer(本项目已显式声明)。`vitest` 与 `@vitest/coverage-v8` 必须同版本升级(coverage 的 peer 锁的是精确版本)。v5 起报告产物统一进 `.vitest/`,覆盖率报告仍在 `coverage/`,两者均已 gitignore。

> **不选 Jest** —— 配 ESM + Vite alias 麻烦。

---

## 现状快照

覆盖：纯函数(`utils/` 含 imageSrc 跨视图图片 src 解析 / lineDiff(Myers 行级算法 / 字符级 inline diff / hunk 提取 / 公共前后缀裁剪 / 快照按 D 分配))、Pinia store(`document`(openFilePaths 多标签 / 自动保存快照合并下沉磁盘:缓存为空时合并 / 一次读盘判断删旧写新修剪) / `editor`(含 zoomLevel) / `export` / `system`(自动更新开关 hydrate / snapshot) / `workspace` / `versionHistory`(本地快照 + Git 历史合并 / 异步 diff / 缓存) / `migration`(settings v1→vN / workspaces v1→v5 迁移链))、ProseMirror 核心(块级增量序列化不变式:块边界对抗样本 / 多 seed 随机编辑 fuzz / 缓存判净与 LRU / markdownIO round-trip 含 underline mark / strictMath 插件(mathFlow 围栏 `$$` 独占行匹配 + mathText 行内 `$...$` 匹配) / 语法实时转换 / 键位(Enter 链:splitInListItemNestedBlock 守卫 / liftEmptyBlock / mathBlockEnter / Shift+Enter 多场景命令链) / NodeView / 插件 / WYSIWYG diff(Myers 行级算法 / 字符级 inline diff / hunk 提取 / block 树结构比对:格式·类型变更 / 非文本节点删除 / split·merge / 空块配对退化 / 表格二维网格:删列·删行·行列同删·同页多表 / 语义化装饰:marks 区间 / 类型 tooltip / 删除片段保留结构 / 边界提示 / 视口增量构建 / 整框分组包围盒几何 / 归组 pos 边界 / 删除片段图片 src 代理 / 文本块与原子块不配对 / DiffView 双模式与异步竞态守卫) / 查找替换 / CJK 排版三件套:字间距装饰插件 / 括号自动配对插件 / 智能排版格式化器库(5 组规则 + 保护区扫描 + 完整性校验回滚 + WYSIWYG 往返) / markdownPaste 插件 / 表格列对齐 round-trip / CellSelection 拖蓝多选批量增删:矩形内右键锚定点击格、上/下插行锚定矩形外边界、左/右插列锚定矩形外边界、删行删掉矩形覆盖的所有 body 行(全删=删表)、删列删掉覆盖列(保底 1 列)、多列对齐覆盖列一起变 / CellSelection 剪贴板:content() 矩形 rows slice、clipboardTextSerializer tab 分隔文本、cut 清空选中 cell、paste 整块填充、copy→paste round-trip / 表格右键菜单 contextmenu plugin / 折叠占位符真实节点交互:点击 `...` 展开、划选覆盖高亮、foldDeleteCommand 整块删除、appendTransaction 同步 fold_placeholder 与 collapsedSet / 自绘光标(customCaret:非文本位置自绘覆盖条 / fold_placeholder 前后接管 / fallback 零高度矩形) / code header 祖先折叠跳过(isCodeBlockAncestorFolded) / 行内 HTML 点击展开源码编辑:点击 html_inline 展开 → commit 重建 / Escape 还原 / 标签平衡校验 / session 退避 / 块级 HTML 源码切换:点击按钮替换成 code_block 编辑 → 光标移出 commit 重建 / Escape 还原 / HTML 图片适配:独立 `<img>` → image 节点(htmlSource + htmlAttrs round-trip)、嵌套 img → 渲染层 proxyDomURL 代理) / emoji 短码 round-trip(`:smile:` → emoji atom 节点 → `:smile:` idempotent)+ emoji 源码编辑(光标靠近展开 `:shortcode:` / 移出 commit 重建 / Escape 还原 / 降级纯文本)+ emoji 自动补全(`:short` 输入态下拉模糊匹配 / 键盘导航 / Enter+Tab 插入 / Escape 关闭)、数学公式(strictMath 严格围栏匹配 / math_block 围栏残缺降级 / 块级公式实时语法检测 / math_block 内 Enter 行为 / 降级后光标 clamp)、导出管线(`htmlRenderer` 端到端)、跨模式光标同步、源码模式(CodeMirror 6)、diff 视图组件(DiffView 双模式 / 未保存条目 / 异步竞态守卫 / StatusBar 未保存入口)、侧边栏(ActivityBar shell 入口 / FileMenuButton 顶栏文件下拉含最近文件子菜单 / CommandPalettePanel 命令面板 / Sidebar 外部 tab 状态渲染 + settingsActive 空态 / FileTree 过滤排序 / 行内 input CRUD + FileTreeContextMenu 转发)、工作区搜索(Ctrl+P fuzzy / Ctrl+Shift+P 命令 fuzzy / Ctrl+Shift+F 全文搜索)、Rust 下沉单测层(`cargo test`：`workspace.rs` 22 例 —— walker 隐藏目录过滤(根自身豁免) / md 扩展名集合 / rel_path 正斜杠 / UTF-16 偏移换算(中文 + emoji) / CRLF 行尾剥离 / 无尾换行末行 / 零宽匹配跳过 / wholeWord 边界 / matchOrdinal·fileMatchCount 口径 / 正则模式与非法正则报错 / 字面模式转义 / 替换计数·捕获组·`$&`·`$0`·`$$` 归一·空替换·无匹配不变(dirty 跳过 / 按 fullPath 去重的语义由 JS 侧 workspaceSearch.test.ts 覆盖,Rust command 层同口径);`git.rs` 7 例 —— git2 定位 workdir / 非仓库报错 / 单提交历史 / blob 去重 / show_file 读 blob / 缺失路径报错 / workdir 相对路径正斜杠;tempfile 建临时工作区与仓库)。JS 侧新增 `quickOpenIndex.test.ts`(5)/ `workspaceSearchRust.test.ts`(8,含 Channel 嵌套 snake_case file 归一回归),存量 `workspaceSearch.test.ts` 经 setup.ts 默认抛错自动走 JS fallback、零改动保持通过。字符实体新增 `__tests__/charRef.test.ts`(parse 标注 / 往返保真 / 强边界 / 连写实体 / 代码块内字面量 / 幂等 + 查找命中字面量)与 `plugins/__tests__/charRefSourceEdit.test.ts`(真实 EditorView 下点击展开 / 重复点击兜底 / 光标移出即还原 / 字面量内部移动保持 / 跨实体一笔 sync / 失焦还原 / 用户改写字面量 / 查找面板纯装饰显示命中 / 面板关闭重判 / flush / 全局搜索点击跳转 / 加粗源码态浅灰样式)。全量现状:113 个测试文件 / 2048 个用例全绿。

---

## 目录与命名规范

```
src/
├── test/
│   └── setup.ts                          # 全局 mock、测试期 hook、全局指令注册(v-velo-scroll)
├── utils/
│   └── __tests__/
│       ├── outline.test.ts
│       ├── fuzzy.test.ts
│       ├── commandPalette.test.ts
│       ├── markdownPath.test.ts
│       ├── workspaceSearch.test.ts       JS fallback 路径(隐藏目录过滤 / CRLF / wholeWord / 替换 dirty 守门 / scope)
│       ├── workspaceSearchRust.test.ts   Rust 流式路径(Channel 事件 hydrate / progress 计数 / cancel 绑定 searchId / invoke reject 降级 JS)
│       ├── quickOpenIndex.test.ts        Rust 单 command 路由(优先 / 失败回落 JS BFS / 缓存 / stale / pending 去重)
│       ├── documentStats.test.ts
│       ├── statusPath.test.ts
│       ├── imagePath.test.ts
│       ├── imageSrc.test.ts           图片 src 解析:相对路径按文档目录归一 / 外链与 asset: 透传 / 无基准目录降级 / 非 Tauri 环境原样返回
│       └── lineDiff.test.ts           Myers 行级 diff / 字符级 inline diff / hunk 提取 / 公共前后缀裁剪 / 大文档快照空间分配
├── stores/
│   └── __tests__/
│       ├── confirm.test.ts           ask 结算 / 并发 ask 取消上一请求 / 重复 settle
│       ├── document.test.ts          openFilePaths / openPathsInTabs 批量并行恢复 / openPathInTab({ silent }) / closeTab 收敛 / 自动保存快照合并下沉磁盘(缓存为空 / 一次读盘判断删旧写新修剪)
│       ├── editor.test.ts             zoomLevel hydrate / snapshot / clampZoomLevel 边界
│       ├── export.test.ts
│       ├── migration.test.ts         持久化迁移链(settings v1→vN / workspaces v1→v5 / sidebarWidth 跨文件迁移 / 废弃字段清理)
│       ├── recentFiles.test.ts       push / 前缀重写·删除 / removePaths 精确批量删除 / deletes patch merge
│       ├── system.test.ts           自动更新开关 hydrate / snapshot / 非法值忽略 / 快照往返
│       ├── versionHistory.test.ts      本地快照 diff 语义 / 虚拟未保存条目 / Git 历史合并排序 / 异步 diff 流程 / 缓存失效
│       └── workspace.test.ts           工作区切换 / recentFiles / 失效记录 removeRoot·removeRecentFiles / patch merge
├── composables/
│   └── __tests__/
│       └── useStaleEntry.test.ts      失效判定(exists false / 抛错不误删)/ 启动 last-file 探测 / 统一确认框结算
├── lib/export/
│   └── __tests__/
│       └── htmlRenderer.test.ts
└── components/
    ├── __tests__/
    │   ├── ActivityBar.test.ts
    │   ├── DiffView.test.ts            diff 视图:未保存条目入口 / 异步加载竞态守卫 / 双模式切换
    │   ├── CommandPalettePanel.test.ts
    │   ├── VeloConfirmDialog.test.ts 精简内容渲染 / 主按钮结算 / Esc 取消 / 无请求不渲染
    │   ├── QuickCommandPanel.test.ts 前缀分发 / 键盘导航 / file 模式新建行 / 失效最近记录清理(静默 + 确认框)
    │   ├── FileMenuButton.test.ts
    │   ├── WorkspaceSearchPanel.test.ts
    │   ├── StatusBar.test.ts
    │   ├── crossModeSync.test.ts
    │   ├── SourceModeEditor.test.ts
    │   ├── FileTree.test.ts
    │   └── Sidebar.test.ts
    └── ProseMirrorEditor/
        ├── __tests__/                    # 编辑器核心:markdownIO / 语法 / 键位 / NodeView / 插件
        │   ├── contentSync.test.ts       内容回写 ↔ 大纲一致性:普通删除 / echo 回环撞后一笔编辑 / debounce 窗口内切标签 / 点击旧标题按 DOM 重建
        │   ├── codeBlockLangSuggest.test.ts  ``` 语言建议下拉(状态检测 / DOM / 键盘导航 / Enter 提交 / Escape / 点击)
        │   ├── codeHighlight.test.ts     code header widget(装载 / shiki dual-theme token / 语言切换 / 复制 / mermaid 联动折叠 / 祖先折叠时 header 跳过 / frontmatter yaml+toml 高亮)
        │   ├── foldDecoration.test.ts    折叠 plugin(makeStableKey / collectFoldableKeys / apply / 跨 plugin 同步 / fold_placeholder 真实节点:appendTransaction 插入删除、handleClickOn 点击展开、Decoration.node 选中高亮、foldDeleteCommand 整块删除、toggle data-fold-state 同步)
        │   └── foldCrossPlugins.test.ts   跨 plugin 集成(codeLineNumber × fold / mermaid × fold),**必须独立成文件**(module-level Set 泄漏源)
        │   └── cjkLetterSpacing.test.ts  CJK 字间距装饰插件(装饰计算 / 增量更新 / 设置开关 / 代码块内禁用)
        │   └── autoPair.test.ts          CJK 括号自动配对(配对插入 / 选区包裹 / 跳越 / 成对删除 / IME 守卫 / 代码块内不触发)
        │   └── cjkFormatter.test.ts       CJK 智能排版格式化器(5 组规则 / 保护区不被破坏 / 完整性校验回滚 / WYSIWYG 往返)
        │   └── markdownPaste.test.ts      markdownPaste 插件(粘贴时清理外部样式 / 保持代码块结构)
        │   └── tableCellSelection.test.ts CellSelection 拖蓝多选:矩形内右键锚定点击格 / 上/下插行锚定矩形外边界(触 header 时新行变 header + 旧 header 降级为 body) / 左/右插列锚定矩形外边界 / 删行删覆盖 body 行(保底 1 body 行,全在 header 内=noop) / 删列删覆盖列(保底 1 列) / 多列对齐覆盖列一起变 / header 行为 th 时菜单隐藏删除行
        │   └── tableClipboard.test.ts CellSelection 剪贴板:content() 矩形 rows slice / clipboardTextSerializer tab 分隔文本 / cut deleteSelection 清空选中 cell / paste handlePaste 整块填充(2×2 覆盖、1×1 clipCells 扩展、纯文本塞首 cell、单 cell 光标填充) / copy→paste round-trip / text/plain 路径(无 HTML):clipboardTextParser tab 分隔文本→表格行(列复制→纵向填充、行复制→横向填充、纯单行/非表格→null) / HTML 路径(slice 无表格结构):handlePaste 检测→从 clipboard text 重建 TSV slice→委托 tableHandlePaste(列/行、2×2 矩形、已有表格结构→不重建、非 CellSelection→false) / 含表头列复制粘贴(text/plain、HTML 有表格结构、HTML 无表格结构→重建) / 真实 HTML round-trip(DOMSerializer→innerHTML→DOMParser.parseSlice→handlePaste:含表头列、不含表头列;验证 hasValidTableStructure 检测 openStart>1 和空行损坏)
        │   └── imageUploadPaste.test.ts imageUploadPlugin.handlePaste 表格粘贴:Excel/浏览器复制表格(HTML <table> + 图片文件)→检测表格→手动解析成规整 table 节点插入(非插图);纯图片粘贴(无 text/html)→仍拦截插图;HTML 无表格 + 图片→仍拦截;空剪贴板→不接管
        │   └── imageSourceEdit.test.ts  HTML 图片源码编辑:独立 `<img>` → image 节点(htmlSource/htmlAttrs round-trip) / 源码编辑 trigger+commit / preview widget / 嵌套 img → html_block 渲染层 proxyDomURL
        │   └── emojiSourceEdit.test.ts  emoji 源码编辑:光标靠近展开 `:shortcode:` / 移出 commit 重建 emoji / Escape 还原 / 降级纯文本 / 预览 widget
        │   └── emojiSuggest.test.ts     emoji 自动补全:`:short` 输入态下拉 / node-emoji 模糊匹配 / 键盘导航 / Enter+Tab 插入 / Escape 关闭 / code mark+code_block+源码编辑 session 内不激活
        │   └── zoomCommands.test.ts    zoom 命令边界 clamp(zoomIn / zoomOut / zoomReset 步长 + 上下限)
        │   └── customCaret.test.ts     自绘光标:非文本位置自绘覆盖条 / fold_placeholder 前后接管 / fallback 零高度矩形
        │   └── exitBlockEnter.test.ts  Shift+Enter 多场景命令链:code_block 退出 / table cell 换行 / blockquote 退出 / list_item 缩进段落 / 兜底换行
        │   └── listBlockquoteEnter.test.ts  list_item 嵌套 block(blockquote/alert) Enter:空段落退出嵌套 block / 非空 splitBlock / liftListItem 不降级
        │   └── strictMath.test.ts      strictMath 插件:mathFlow 围栏 `$$` 独占行匹配 / mathText 行内 `$...$` 匹配 / 残缺围栏不解析
        │   └── mathBlockBrokenFence.test.ts  math 围栏残缺降级:首尾 `$` 缺失 → paragraph / 内容为空 → 占位
        │   └── mathBlockSyntax.test.ts 块级公式实时语法检测:段落中 `$$\n...\n$$` 自动转 math_block / 不完整围栏不转
        │   └── mathBlockEnter.test.ts  math_block 内 Enter:闭合 `$$` 后 → 退出插入段落 / 内容区 → 换行不拆段
        │   ├── mathBlockDowngradeCursor.test.ts  math_block 降级光标 clamp:删除分隔符导致降级后光标定位在 paragraph content 范围内
        │   ├── blockDiff.test.ts        block 树结构比对:格式·类型变更 / 非文本节点删除 / split·merge / 空块配对退化
        │   ├── diffDecoration.test.ts   diff 语义化装饰:marks 区间 / 类型 tooltip / 删除片段保留结构 / 表格二维网格删列删行 / 视口增量构建
        │   ├── tableMarkSessionDup.test.ts  整表替换前 mark 源码会话:先提交 / 区间翻转丢弃 / 不再复制出重复表格
        │   ├── charRef.test.ts            字符实体:parse 标注 / 往返保真 / strong 边界 / 连写实体 / 代码块内字面量 / 查找命中字面量与空格
        │   └── diffGroupFrames.test.ts  整框 overlay:包围盒几何 / 归组 pos 边界 / 真实 EditorView 端到端定位 / destroy 后异步回调不重建
        ├── nodes/__tests__/
        │   ├── HtmlNodeView.test.ts   html_block NodeView:块级 HTML 源码切换(点击按钮→code_block 替换→光标移出 commit / Escape 还原) / 独立 img 分流(→ image 节点) / 嵌套 img proxyDomURL 代理
        │   └── mathLazyRender.test.ts B3 NodeView 延迟渲染:视口外不调 katex.render / 进入视口渲染 / 滚出销毁+缓存 / 缓存同步恢复 / edit 态不销毁(fake IntersectionObserver)
        ├── plugins/__tests__/
        │   └── charRefSourceEdit.test.ts 实体源码态:点击展开 / 光标移出还原 / 跨实体 sync / 失焦还原 / 编辑字面量 / 查找面板纯装饰 / flush / 全局搜索跳转 / 加粗源码态浅灰装饰
        └── findreplace/__tests__/
```

约定:
- 单测放 `__tests__/` 子目录,后缀 `.test.ts`(`vitest.config.ts` 已配 include)
- 基准测试放 `src/bench/`,后缀 `.bench.ts`(`vitest.config.ts` 的 `benchmark.include` 已配),跑 `npm run bench`;Vitest 5 起 `bench` 不再是顶层导出,而是 test context fixture:`test(name, async ({ bench }) => { await bench(name, fn).run() })`;带时间预算时 options 是**第二参**(`bench(name, { time, warmupTime }, fn)`),传第三参会直接抛错。现有 `markdown.bench.ts`(parse / serialize / round-trip)与 `source-mode-input.bench.ts`(源码模式输入路径:全文 tokenize 对照 / 视口重建 / CM6 单字符 dispatch,复用 `src/bench/corpus/` 三档语料,验收线为单次输入同步路径 < 16.7ms)
- 一个源文件一个对应测试文件,集成场景加 `.integration.test.ts` 后缀
- 描述用 `it('写盘失败时 lastSavedContent 回滚, dirty 恢复', ...)` 这种“行为 + 期望”句式,不要 `it('test save')`

---

## 维护约定

1. **新加业务逻辑默认带测试** —— 改 `document.ts` / `outline.ts` / `markdownIO.ts` 这种核心文件时,改动 PR 必须包含对应 `*.test.ts`。
2. **Bug 修复先写一个失败用例** —— 任何 bug 的修复 PR 第一条 commit 是“加一个会失败的测试”,第二条才是“修代码让它绿”。
3. **失败用例优先于新功能测试** —— 升级 ProseMirror / remark / Pinia / Tauri 时,先跑 `npm test`,红了再决定要不要升级。
4. **改 schema / markdownIO 必跑 round-trip** —— `markdownIO.test.ts` 是合约门,开发中跑 `vitest run markdownIO` 确认不破,commit 前跑全量 `vitest run` 必须全绿。
5. **不强求覆盖** —— `MathNodeViews.ts` / `TaskListNodeView.ts` / `TextareaEditor.ts` 这类强依赖 ProseMirror 视图 / CodeMirror 内嵌的,绕过。

---

## Tauri API 隔离层

**原则**:业务代码只调 `@tauri-apps/*` 的“语义”,不关心实现。测试用 `vi.mock` 把 Tauri 全替成 stub。

**已 mock 的清单**(见 `src/test/setup.ts`):
- `@tauri-apps/plugin-fs` → `readTextFile` / `writeTextFile` / `watch` / `watchImmediate` / `readFile` / `writeFile` / `readDir` / `exists` / `mkdir` / `rename` / `remove` / `copyFile`。清单必须跟住 `src/tauri/fs.ts` 的 re-export:该模块是测试 mock 的单一入口,任一导出缺失会让所有间接 import `@/tauri/fs` 的测试文件在**模块加载期**整批报 "No export is defined on the mock"(不是断言失败)
- `@tauri-apps/plugin-dialog` → `open` / `save` / `message`(系统对话框只剩选文件 / 选保存位置)
- `@tauri-apps/plugin-clipboard-manager` → `writeText`
- `@tauri-apps/api/window` → `getCurrentWindow().{label,setTitle,onCloseRequested,minimize,toggleMaximize,close,destroy,isMaximized,onResized}`
- `@tauri-apps/api/core` → `isTauri`(恒 true) / `convertFileSrc`(透传) / `invoke`(按 command 分发) / `Channel`(ChannelStub)。**invoke 的默认返回值是刻意设计的兼容层**:
  - `scan_workspace_files` / `search_workspace` / `replace_workspace` 默认 **throw**(模拟旧版后端无此 command)→ `quickOpenIndex` / `workspaceSearch` 自动走 JS fallback,存量依赖 plugin-fs mock 的测试零改动保持通过;测 Rust 路径的用例(`quickOpenIndex.test.ts` / `workspaceSearchRust.test.ts`)用 `vi.mocked(invoke)` 自行覆盖
  - `cancel_workspace_search` 返回 undefined;`git_*` 三命令返回空结果(null / [] / '');`take_window_cli_args` / `new_app_window` 返回固定桩
  - **ChannelStub**:构造器接收 `onmessage`,测试从 invoke mock 的参数里拿到 channel 实例后手动调 `channel.onmessage(event)` 模拟 Rust 流式回传(scanned / file / progress / done);`toJSON` 返回占位串,不走真实 IPC

**全局指令注册**: `setup.ts` 还全局注册了 `v-velo-scroll` 指令(工作区滚动条 hover 显示，实现见 `src/directives/veloScroll.ts`)，避免每个 mount 用到它的组件测试(FileTree / WorkspaceSearchPanel / Sidebar / AssetPanel 等)单独传 `global.directives`。

**确认弹窗**: 单测不挂载 `VeloConfirmDialog`,`useConfirmStore().ask()` 会留下永不 resolve 的 promise。触发确认决策的用例(`document.test.ts` / `FileTree.test.ts`)在各自文件内 `vi.mock('@/stores/confirm')` 把 `ask` 换成 `vi.fn()` 桩 —— `vi.resetAllMocks()` 后桩返回 undefined(falsy = 取消),要放行时 `mockResolvedValue(true)`。测弹窗本身 / 失效清理的用例(`confirm.test.ts` / `VeloConfirmDialog.test.ts` / `useStaleEntry.test.ts` / `QuickCommandPanel.test.ts`)用真实 store,通过 `store.current` 断言文案、`store.confirm()` / `store.cancel()` 结算。

**新增 Tauri 调用的规约**:
- 在 `src/tauri/` 下建薄封装(如 `src/tauri/fs.ts`、`src/tauri/dialog.ts`),业务侧 import 封装
- 封装内部 import `@tauri-apps/*`
- 测试只 mock `src/tauri/*` 即可,业务逻辑保持纯净

> 阶段性升级:业务代码直接 import Tauri、mock 也直接打在 `@tauri-apps/*` 的旧写法仍允许;**后续逐步收敛**到 `src/tauri/` 封装层,让 fs / dialog 边界集中可控。**薄封装本身不写测试**——测它等于测 mock,无价值。

---

## 反过度测试

测试不是越多越好。下列**不写**测试:

- **纯展示 / 低交互组件** —— 无状态展示组件没有用户可见的失败模式;一旦出现异步竞态 / 状态切换等失败模式即不再适用(`DiffView.vue` 现已有对应回归用例)。
- **薄封装 / 转发层** —— `src/tauri/*.ts` 只是转发 Tauri API,测它等于测 mock。
- **稳定的样板代码** —— boilerplate 配置、纯 CSS 调整、props 透传。
- **只断言“代码跑过了”的用例** —— 半年没抓到回归、又无行为断言,是死重,敢删。阶段性审计一次。

**写测试的触发条件**(满足其一):
- 修 bug(先写失败回归用例)
- 核心逻辑(schema / markdownIO / outline / syntax / store 状态机)
- 有失败模式的用户交互(快捷键分发、模式切换、查找替换 UI)

**组件层标准**:“有交互逻辑 + 有用户可见失败模式”才测,不全覆盖。逻辑重的(`App.vue` 快捷键、`useProseMirror.ts`)用真实 `mount`,纯展示用 `shallowMount`。

**反模式**:
- 测样式 / class 名
- 测私有细节(组件内部 ref 名、函数是否被调用)
- 测“我点了按钮,某 ref 变成 x” —— 应测“我点了按钮,store 收到信号 / 用户看到 Y”

---

## CI 集成

- GitHub Actions `.github/workflows/ci.yml` 走 `workflow_dispatch`（手动触发）+ tag push（`v*`）触发;步骤 checkout → setup-node → `npm ci` → type-check → lint:deps(dependency-cruiser) → lint:console → lint:design-tokens → knip(死码检测) → eslint --quiet(仅卡 error) → `npm test`(vitest,ubuntu) → `npm run build`。不在每次 push master 时触发——独立开发 + AI 驱动下每次 push 跑 CI 太慢，改为发版前手动触发或 tag push 自动触发
- 不挂覆盖率阈值,只挂"测试通过"门
- ESLint 仅卡 error（`--quiet`），warnings 不阻断 CI；存量 warnings 通过 CLAUDE.md 约定引导 coding agent 在接触文件时顺手修复

---

## 同步规则

- 本文件是测试文档的唯一 canonical source；不要再新增单独的测试索引或拆分测试目录。
- 新增 / 删除测试文件、动测试基建(`vitest.config.ts` / `src/test/setup.ts`)、改变测试规约时，更新本文件。
- 纯加测试用例通常不需要改文档；发版时才更新本文件“现状快照”。
- 不要把阶段勾选表写进测试文档，向前规划走 [`ROADMAP.md`](../ROADMAP.md)。

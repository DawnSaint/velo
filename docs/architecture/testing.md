# Testing Architecture

> **本文件负责**: 测试目标 / 选型 / 现状、单测/集成规约、Tauri 测试边界、反过度测试原则与 E2E 跑法。
>
> **何时阅读**: 新增 / 删除测试文件、修改测试基建、调整测试规约、发版更新测试现状，或需要判断“该不该写测试”时。
>
> **先记住**:
> - 回归保护优先，不追求 100% 覆盖。
> - 最便宜层优先，纯函数能覆盖的别上组件，组件能覆盖的别上 E2E。
> - 测行为不测实现；纯展示、薄封装、样板代码通常不测。
> - Tauri 边界一律 mock；E2E 是 WebdriverIO + tauri-driver 的单独链路。
> - E2E Windows only，`maxInstances: 1`，跑前 snapshot appData，跑后先 kill 再 restore。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [Tauri 架构](./tauri.md) / [ROADMAP](../ROADMAP.md)

---

## 目标与原则

1. **回归保护优先** —— 测试是业务代码改动的快速反馈机制(秒级),不以覆盖率数字为考核指标。
2. **从纯函数到 UI** —— 价值密度最高的逻辑(状态机、文本解析、插件)全部与 DOM 解耦,优先用最便宜的工具覆盖。
3. **Tauri 边界一律 mock** —— 测试不在 Tauri runtime 里跑,通过一层薄薄的 stub 把 `@tauri-apps/*` 隔在 store / 工具函数之外。
4. **测行为不测实现** —— 断言“输入 → 用户可观察输出”,不测 class 名 / ref 名 / 内部分支 / 函数是否被调用。
5. **最便宜层优先** —— 纯函数能覆盖的别上组件 mount,组件能覆盖的别上 E2E。
6. **不追求 100% 覆盖** —— 覆盖率只用来发现“哪块完全没被测过”,不用来刷分。

---

## 选型

| 层 | 工具 | 理由 |
|---|---|---|
| 单测 / 集成 | **Vitest** | Vite 原生,TypeScript + ESM + JSDOM 一把梭,极快 |
| 组件 | **@vue/test-utils** | Vue 3 官方 |
| 覆盖率 | **@vitest/coverage-v8** | 看个大概,不卡阈值 |
| 端到端 | **WebdriverIO 9** + `tauri-driver` | Tauri 官方 webdriver 走 WD Classic;Playwright 仅支持 CDP/BiDi 不可用 |
| 断言辅助 | **@testing-library/jest-dom** | 组件断言更语义化(可选) |

> **不选 Jest** —— 配 ESM + Vite alias 麻烦。**Playwright 不可用于 Tauri webview** —— `tauri-driver` 是 WebDriver Classic 代理,Playwright 只支持 CDP/BiDi;Tauri 官方 example 只给 Selenium / WebdriverIO。

---

## 现状快照

覆盖：纯函数(`utils/`)、Pinia store(`document` / `editor` / `export` / `workspace`)、ProseMirror 核心(markdownIO round-trip 含 underline mark / 语法实时转换 / 键位 / NodeView / 插件 / 查找替换 / CJK 排版三件套:字间距装饰插件 / 括号自动配对插件 / 智能排版格式化器库(5 组规则 + 保护区扫描 + 完整性校验回滚 + WYSIWYG 往返) / markdownPaste 插件 / 表格列对齐 round-trip / CellSelection 拖蓝多选批量增删:矩形内右键锚定点击格、上/下插行锚定矩形外边界、左/右插列锚定矩形外边界、删行删掉矩形覆盖的所有 body 行(全删=删表)、删列删掉覆盖列(保底 1 列)、多列对齐覆盖列一起变 / CellSelection 剪贴板:content() 矩形 rows slice、clipboardTextSerializer tab 分隔文本、cut 清空选中 cell、paste 整块填充、copy→paste round-trip / 表格右键菜单 contextmenu plugin / 折叠占位符真实节点交互:点击 `...` 展开、划选覆盖高亮、foldDeleteCommand 整块删除、appendTransaction 同步 fold_placeholder 与 collapsedSet / code header 祖先折叠跳过(isCodeBlockAncestorFolded) / 行内 HTML 点击展开源码编辑:点击 html_inline 展开 → commit 重建 / Escape 还原 / 标签平衡校验 / session 退避 / 块级 HTML 源码切换:点击按钮替换成 code_block 编辑 → 光标移出 commit 重建 / Escape 还原 / HTML 图片适配:独立 `<img>` → image 节点(htmlSource + htmlAttrs round-trip)、嵌套 img → 渲染层 proxyDomURL 代理) / emoji 短码 round-trip(`:smile:` → emoji atom 节点 → `:smile:` idempotent)+ emoji 源码编辑(光标靠近展开 `:shortcode:` / 移出 commit 重建 / Escape 还原 / 降级纯文本)+ emoji 自动补全(`:short` 输入态下拉模糊匹配 / 键盘导航 / Enter+Tab 插入 / Escape 关闭)、导出管线(`htmlRenderer` 端到端)、跨模式光标同步、源码模式(CodeMirror 6)、侧边栏(ActivityBar shell 入口 / FileMenuButton 顶栏文件下拉含最近文件子菜单 / CommandPalettePanel 命令面板 / Sidebar 外部 tab 状态渲染 + settingsActive 空态 / FileTree 过滤排序 / 行内 input CRUD + FileTreeContextMenu 转发)、工作区搜索(Ctrl+P fuzzy / Ctrl+Shift+P 命令 fuzzy / Ctrl+Shift+F 全文搜索)。

**E2E**: WebdriverIO 9 + tauri-driver，1 条 spec(`e2e/specs/multi-window.spec.ts`)，覆盖二次启动经 `tauri-plugin-single-instance` 路由创建独立工作区窗口。Windows only，需手动 `cargo install tauri-driver` + 装 msedgedriver；CI 挂钩走 build.yml，见 ROADMAP `#ci-pipeline`。

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
│       ├── workspaceSearch.test.ts
│       ├── documentStats.test.ts
│       ├── statusPath.test.ts
│       └── imagePath.test.ts
├── stores/
│   └── __tests__/
│       ├── document.test.ts          openFilePaths / openPathsInTabs 批量并行恢复 / openPathInTab({ silent }) / closeTab 收敛
│       ├── editor.test.ts
│       ├── export.test.ts
│       ├── recentFiles.test.ts
│       └── workspace.test.ts
├── lib/export/
│   └── __tests__/
│       └── htmlRenderer.test.ts
└── components/
    ├── __tests__/
    │   ├── ActivityBar.test.ts
    │   ├── CommandPalettePanel.test.ts
    │   ├── FileMenuButton.test.ts
    │   ├── WorkspaceSearchPanel.test.ts
    │   ├── StatusBar.test.ts
    │   ├── crossModeSync.test.ts
    │   ├── SourceModeEditor.test.ts
    │   ├── FileTree.test.ts
    │   └── Sidebar.test.ts
    └── ProseMirrorEditor/
        ├── __tests__/                    # 编辑器核心:markdownIO / 语法 / 键位 / NodeView / 插件
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
        ├── nodes/__tests__/
        │   ├── HtmlNodeView.test.ts   html_block NodeView:块级 HTML 源码切换(点击按钮→code_block 替换→光标移出 commit / Escape 还原) / 独立 img 分流(→ image 节点) / 嵌套 img proxyDomURL 代理
        │   └── mathLazyRender.test.ts B3 NodeView 延迟渲染:视口外不调 katex.render / 进入视口渲染 / 滚出销毁+缓存 / 缓存同步恢复 / edit 态不销毁(fake IntersectionObserver)
        ├── plugins/__tests__/
        └── findreplace/__tests__/

e2e/                                       # WebdriverIO + tauri-driver,顶层(vitest include: src/** 不会误吃)
├── wdio.conf.ts                          # WDIO 主配置 + 进程生命周期 hook
├── tsconfig.json
├── README.md                             # 跑前自检 / 跑法
├── helpers/                              # workspace tmp / killStaleVelo / selectors / platform 守门
├── fixtures/
└── specs/
    └── multi-window.spec.ts              # 多窗口:二次启动创建独立工作区窗口
```

约定:
- 单测放 `__tests__/` 子目录,后缀 `.test.ts`(`vitest.config.ts` 已配 include)
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
- `@tauri-apps/plugin-fs` → `readTextFile` / `writeTextFile` / `watch`
- `@tauri-apps/plugin-dialog` → `open` / `save` / `confirm`
- `@tauri-apps/plugin-clipboard-manager` → `writeText`
- `@tauri-apps/api/window` → `getCurrentWindow().{label,setTitle,onCloseRequested,minimize,toggleMaximize,close,destroy,isMaximized,onResized}`

**全局指令注册**: `setup.ts` 还全局注册了 `v-velo-scroll` 指令(工作区滚动条 hover 显示，实现见 `src/directives/veloScroll.ts`)，避免每个 mount 用到它的组件测试(FileTree / WorkspaceSearchPanel / Sidebar / AssetPanel 等)单独传 `global.directives`。

**新增 Tauri 调用的规约**:
- 在 `src/tauri/` 下建薄封装(如 `src/tauri/fs.ts`、`src/tauri/dialog.ts`),业务侧 import 封装
- 封装内部 import `@tauri-apps/*`
- 测试只 mock `src/tauri/*` 即可,业务逻辑保持纯净

> 阶段性升级:业务代码直接 import Tauri、mock 也直接打在 `@tauri-apps/*` 的旧写法仍允许;**后续逐步收敛**到 `src/tauri/` 封装层,方便接 E2E。**薄封装本身不写测试**——测它等于测 mock,无价值。

---

## 反过度测试

测试不是越多越好。下列**不写**测试:

- **纯展示 / 低交互组件** —— `DiffView.vue` 这类,没有用户可见的失败模式。
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

## E2E 跑前自检(Windows only)

E2E 走 WebdriverIO + `tauri-driver` + `msedgedriver`(WebView2 后端),需手动准备:

```bash
# 1. 装 tauri-driver
cargo install tauri-driver --locked

# 2. 装与本机 Edge 匹配的 msedgedriver.exe
cargo install --git https://github.com/chippers/msedgedriver-tool
msedgedriver-tool             # 下载 msedgedriver.exe 到当前目录,放进 $PATH

# 3. 跑
npm run test:e2e              # onPrepare 自动 tauri:build:debug + killStaleVelo
```

**约束**:

- **Windows only**;`e2e/helpers/platform.ts` 非 Windows 平台 `process.exit(0)` 不报错
- **不并行**:`tauri-plugin-single-instance` 让多 session 互相路由,`maxInstances: 1` 是硬约束;`taskkill /F /IM velo.exe /T` 在 `onPrepare` / `afterSession` / `onComplete` 三处兜底清残留
- **CI 挂钩走 build.yml**:tag push 自动触发 `e2e` job(Windows),`workflow_dispatch` 勾选 `run-e2e` 手动触发;CI 中构建 release 裸 binary(`tauri build --no-bundle`),通过 `VELO_E2E_BINARY` 环境变量传给 wdio;Phase 1 `continue-on-error`,失败不阻塞 release attach
- **本地构建走 debug profile**(`tauri build --debug --no-bundle`):无需 installer,Cargo 增量后续秒级;CI 走 release profile 更接近用户产物

---

## 测试钩子约定

### `data-testid` 钩子

E2E spec 不依赖 class 名(Tailwind utility,改起来频)。**所有 E2E 选择器走 `data-testid`**,常量集中在 `e2e/helpers/selectors.ts`。当前钩子:

- `src/components/Sidebar/FileTree.vue`:
  - 工作区根 row:`data-testid="workspace-root"`
  - 普通文件 / 目录 row:`data-testid="file-row-${node.name}"`
  - 行内 input(新建 / 重命名共用):`data-testid="inline-input"`
- `src/components/Sidebar/FileTreeContextMenu.vue`:每个菜单项 `data-testid="ctx-{action}"`(`ctx-new-file` / `ctx-new-dir` / `ctx-rename` / `ctx-delete` / `ctx-reveal` / `ctx-open-in-editor` / `ctx-open-as-workspace`)
- `src/components/ProseMirrorEditor/EditorInner.vue`:PM 挂载容器 `data-testid="pm-editor"`
- `src/components/StatusBar.vue`:工作区 label:`data-testid="status-workspace-label"`

新增 E2E 触达元素时同步加 `data-testid` + 更新 `e2e/helpers/selectors.ts` 常量。**不写 testid 钩子 + 不更新常量 = 后续 spec 写不下去**。

### `__VELO_E2E_AUTO_CONFIRM__` window flag

WebDriver 无法操作系统级 confirm 对话框(`@tauri-apps/plugin-dialog::confirm` 在 Windows 上调系统对话框)。E2E spec 删除链路依赖此钩子绕开:

- `src/tauri/dialog.ts` 的 `confirm` 包了 `import.meta.env.DEV` 守门:dev build 下若 `window.__VELO_E2E_AUTO_CONFIRM__ === true`,直接 resolve `true` 跳过原生对话框
- release build 经 esbuild 把 `if (import.meta.env.DEV && ...)` dead-code-eliminate,行为不变
- spec 在 `before()` 里一次性 `browser.execute(() => { window.__VELO_E2E_AUTO_CONFIRM__ = true })` 打开

> 不走 Rust 端 `#[cfg(debug_assertions)]` invoke 拦截:前端守门等效但实施代价 10× 低,且不涉及 Cargo 重建。如未来要支持系统 message / save dialog 同款绕开,继续走前端 flag 模式即可。

### WebView2 + msedgedriver 交互层兜底

WebView2 backend 下 msedgedriver 的 WebDriver Actions / interactability 检查与标准 Chrome 不一致,踩了三个坑,统一在 spec 顶部 helper 绕开:

- **右键不触发 `contextmenu`**:Actions API 的 `click({ button: 'right' })` 在 WebView2 里只发 `mousedown` / `mouseup`,DOM 上的 `contextmenu` 事件不发火 → Vue `@contextmenu` 监听静默不触发。**绕开**:`rightClick(selector)` 走 `browser.execute` 派发 `new MouseEvent('contextmenu')`,bubbles 到 Vue 监听等价。
- **`.click()` / `.setValue()` 偶发 `not interactable`**:虚拟列表里的 row 或刚 mount 的 `<input>`(Vue `nextTick` 异步 focus),msedgedriver 的 visibility 检查比浏览器实际渲染保守,看不见 → 直接报 `element not interactable`。**绕开**:`jsClick(selector)` 派发 `MouseEvent('click')`;`setInlineValue(text)` 直接写 `input.value` + 派发 `Event('input')` 触发 Vue v-model。

> 这些只对**已知工具链限制**绕,不是给业务代码留口。新增 spec 若用 native `.click()` / `.setValue()` 跑通,就保留原写法。

### CLI argv 容错(`--` 前缀剥离)

E2E 用 `tauri:options.args = [tmpWs]` 注入工作区路径,但 tauri-driver 在 Windows 上把每个 arg 映射进 `ms:edgeOptions.args`,msedgedriver 当成 Chrome flag **强制加 `--` 前缀**,velo.exe 收到的是 `--C:\Users\...\velo-e2e-XXX`。`PathBuf::from("--C:\\...")` 既不是 file 也不是 dir → CliArgsPayload 空 → 持久化的工作区赢。

**修法**:`parse_cli_args` 容忍单层 `--` 前缀(`a.strip_prefix("--").unwrap_or(a)`)。真实 CLI 不受影响:用户传 `--help` 在 strip 后还是 `is_file=false` / `is_dir=false`,本来就会被过滤。

### appData 持久化文件快照/还原

debug binary 跟 dev / release 共用 `%APPDATA%/com.velo.editor/`。E2E spec `setActiveRoot(tempWs)` 触发 App.vue debounce watch 落盘 `velo-workspaces.json`,**永久污染用户数据**(active 指向已删的 tempWs → 用户下次 dev 启动 FileTree 报“读取目录失败”)。

**修法**:`e2e/helpers/appdata.ts` 提供 `snapshotAppData()` / `restoreAppData()`:
- `before()`:把 `velo-workspaces.json` / `velo-outline-state.json` / `velo-settings.json` 三份整体备份到 `tmpdir()/velo-e2e-appdata-snapshot/`,原本不存在的文件留一个 `.missing` 标记
- `after()`:**先 killStaleVelo 再 restore**(Velo 还活着 → debounce watch 会再写一次)。备份存在 → 字节级回写;有 `.missing` 标记 → 删 E2E 残留

> 不走 product name 拆 debug appDataDir 的路径:那要改 `tauri.conf.json`,代价高且影响 `npm run tauri:dev` 的真实数据隔离语义。spec 层备份还原最小侵入,跑完 `diff` 字节级一致。

---

## CI 集成

- GitHub Actions `.github/workflows/ci.yml` 走 `workflow_dispatch`（手动触发）+ tag push（`v*`）触发;步骤 checkout → setup-node → `npm ci` → type-check → lint:deps(dependency-cruiser) → lint:console → lint:design-tokens → knip(死码检测) → eslint --quiet(仅卡 error) → `npm test`(vitest,ubuntu) → `npm run build`。不在每次 push master 时触发——独立开发 + AI 驱动下每次 push 跑 CI 太慢，改为发版前手动触发或 tag push 自动触发
- 不挂覆盖率阈值,只挂"测试通过"门
- ESLint 仅卡 error（`--quiet`），warnings 不阻断 CI；存量 warnings 通过 CLAUDE.md 约定引导 coding agent 在接触文件时顺手修复
- **E2E 挂钩 build.yml**:vitest 单测是发版前的廉价门,而 E2E 是真二进制冷启动 / WebView2 / fs round-trip 集成链,跑不快且只需验一次 → `build.yml` 的 `e2e` job 在 tag push 时自动跑,`workflow_dispatch` 可手动触发;Phase 1 `continue-on-error` 不阻塞发版,稳定后改为硬门

---

## 同步规则

- 本文件是测试文档的唯一 canonical source；不要再新增单独的测试索引或拆分测试目录。
- 新增 / 删除测试文件、动测试基建(`vitest.config.ts` / `src/test/setup.ts`)、改变测试规约时，更新本文件。
- 纯加测试用例通常不需要改文档；发版时才更新本文件“现状快照”。
- 不要把阶段勾选表写进测试文档，向前规划走 [`ROADMAP.md`](../ROADMAP.md)。

# Testing Architecture

> **本文件负责**：测试目标 / 选型 / 现状、单测与集成规约、Tauri 边界 mock、反过度测试原则、CI 集成。
>
> **何时阅读**：新增 / 删除测试文件、改测试基建（`vitest.config.ts` / `src/test/setup.ts`）、调测试规约、发版更新现状时。
>
> **代码入口**：`vitest.config.ts`、`src/test/setup.ts`、`.github/workflows/ci.yml`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [Tauri 架构](./tauri.md) · [ROADMAP](../ROADMAP.md)

## 红线

- **Tauri 边界一律 mock**，不在 Tauri runtime 里跑测试。
- **`src/test/setup.ts` 的 mock 清单必须跟住 `src/tauri/fs.ts` 的 re-export** —— 缺一个导出会让所有间接 import `@/tauri/fs` 的测试在模块加载期整批报 "No export is defined on the mock"。
- **测行为不测实现**：不断测 class 名 / ref 名 / 内部分支 / 函数是否被调用。
- **薄封装不写测试**（`src/tauri/*.ts` 只转发 Tauri API，测它等于测 mock）。
- **不追求覆盖率阈值**，覆盖率只用来发现「哪块完全没被测过」。
- **纯展示 / 低交互组件不写测试**，除非出现异步竞态 / 状态切换等真实失败模式。
- **Bug 修复先写失败用例**：第一条 commit 加会失败的测试，第二条才修代码。
- **改 schema / markdownIO 必跑 round-trip**（`markdownIO.test.ts` 是合约门）。
- **CI 不挂覆盖率阈值**，只挂「测试通过」门。

## 架构

### 选型

| 层 | 工具 | 理由 |
| --- | --- | --- |
| 单测 / 集成 | Vitest 5.1 | Vite 原生，TS + ESM + JSDOM，极快 |
| 组件 | @vue/test-utils 2.4 | Vue 3 官方 |
| 覆盖率 | @vitest/coverage-v8 5.1 | 看个大概，不卡阈值 |

- `vitest` 与 `@vitest/coverage-v8` 必须同版本升级（coverage 的 peer 锁精确版本）。
- 不选 Jest —— 配 ESM + Vite alias 麻烦。
- `vitest.config.ts`：`environment: 'jsdom'` + `globals: true`，include `src/**/*.{test,spec}.ts`，`setupFiles: ['./src/test/setup.ts']`。

### 基准测试

`src/bench/*.bench.ts`（`benchmark.include` 已配），跑 `npm run bench`。Vitest 5 起 `bench` 不再是顶层导出，而是 test context fixture：`test(name, async ({ bench }) => { await bench(name, fn).run() })`；带时间预算时 options 是**第二参**（`bench(name, { time, warmupTime }, fn)`），传第三参会抛错。现有 `markdown.bench.ts`（parse / serialize / round-trip，100KB / 500KB / 1MB 三档）与 `source-mode-input.bench.ts`（全文 tokenize 对照 / 视口重建 / CM6 单字符 dispatch，复用 `src/bench/corpus/` 三档语料，验收线为单次输入同步路径 < 16.7ms）。

### 测试分层与规模

113 个测试文件，按「越便宜越优先」分布：

| 位置 | 数量 | 覆盖重点 |
| --- | --- | --- |
| `src/components/ProseMirrorEditor/__tests__/` | 55 | 编辑器核心：markdownIO round-trip / 块级增量序列化 / 语法实时转换 / Enter·Backspace·Shift+Enter 键位链 / 数学·emoji·char_ref·HTML 图片源码会话 / 表格 CellSelection 与剪贴板 / 折叠占位符 / CJK 排版三件套 / diff 语义化装饰 / 代码高亮 |
| `src/utils/__tests__/` | 15 | 纯函数：fuzzy / outline / quickCommand / commandPalette / quickOpenIndex / workspaceSearch(JS + Rust) / lineDiff / imageSrc / imagePath / markdownPath / documentStats / statusPath / breadcrumbs / revealHeading |
| `src/components/__tests__/` | 13 | 组件：QuickCommandPanel / WorkspaceSearchPanel / FileTree / Sidebar / SourceModeEditor / DiffView / VeloConfirmDialog / ActivityBar / StatusBar / TabContextMenu / FileMenuButton / crossModeSync / treeUtils |
| `src/stores/__tests__/` | 10 | Pinia：document（多标签 + 自动保存快照下沉）/ workspace / migration（settings v1→vN、workspaces v1→v5）/ recentFiles / versionHistory / system / editor / export / confirm / notify |
| `ProseMirrorEditor/plugins/__tests__/` | 9 | 插件：resolvePlugins / remarkAlert / preserveEmptyLine / charRefSourceEdit / focusMode / linkClick / linkSyntax / sessionRetreat / typewriterMode |
| `ProseMirrorEditor/nodes/__tests__/` | 4 | HtmlNodeView / FootnoteNodeViews(+integration) / mathLazyRender |
| `ProseMirrorEditor/findreplace/__tests__/` | 2 | backend / findMatches |
| `ProseMirrorEditor/composables/__tests__/` | 2 | useProseMirror / useResizeSplitter |
| `ProseMirrorEditor/editor/shortcuts/commands/__tests__/` | 1 | zoomCommands |
| `src/lib/export/__tests__/` | 1 | htmlRenderer（含 SCSS 源断言） |
| `src/composables/__tests__/` | 1 | useStaleEntry |

完整清单以文件系统为准（`find src -name '*.test.ts'`）；本表只用于判断「哪一层缺覆盖」。

### Tauri API 隔离层

原则：业务代码只调 `@tauri-apps/*` 的语义，测试用 `vi.mock` 把 Tauri 全替成 stub。

`src/test/setup.ts` mock 清单：

- `@tauri-apps/plugin-fs` → `readTextFile` / `writeTextFile` / `readFile` / `writeFile` / `watch` / `watchImmediate` / `exists` / `mkdir` / `readDir` / `rename` / `remove` / `copyFile`
- `@tauri-apps/plugin-dialog` → `open` / `save` / `message`
- `@tauri-apps/plugin-clipboard-manager` → `writeText`
- `@tauri-apps/plugin-shell` → `open`（linkClick 打开外部 URL）
- `@tauri-apps/plugin-opener` → `revealItemInDir`
- `@tauri-apps/api/window` → `getCurrentWindow()` 单例（`label: 'main'` + setTitle / minimize / toggleMaximize / close / destroy / isMaximized / onResized / onCloseRequested）
- `@tauri-apps/api/webviewWindow` → `getAllWebviewWindows` / `getCurrentWebviewWindow`
- `@tauri-apps/api/path` → `appDataDir` / `join` / `dirname` / `sep`
- `@tauri-apps/api/core` → `isTauri`（恒 true）/ `convertFileSrc`（透传）/ `invoke`（按 command 分发）/ `Channel`（ChannelStub）

**invoke 默认返回值是刻意设计的兼容层**：

- `scan_workspace_files` / `search_workspace` / `replace_workspace` 默认 **throw**（模拟旧版后端无此 command）→ `quickOpenIndex` / `workspaceSearch` 自动走 JS fallback，存量依赖 plugin-fs mock 的测试零改动通过；测 Rust 路径的用例用 `vi.mocked(invoke)` 自行覆盖。
- `cancel_workspace_search` → undefined；`git_*` 三命令 → 空结果（null / [] / ''）；`take_window_cli_args` / `new_app_window` → 固定桩。
- **ChannelStub**：构造器接收 `onmessage`，测试从 invoke mock 的参数里拿到 channel 实例后手动调 `channel.onmessage(event)` 模拟 Rust 流式回传（scanned / file / progress / done）；`toJSON` 返回占位串。

**jsdom polyfill**：`Element.prototype.scrollIntoView`、`document.elementFromPoint`（返回 null）、`CSS.escape`（ASCII 子集）。

**全局指令**：`setup.ts` 全局注册 `v-velo-scroll`（`src/directives/veloScroll.ts`），避免每个 mount 用到它的组件测试单独传 `global.directives`。

**确认弹窗**：单测不挂载 `VeloConfirmDialog`，`useConfirmStore().ask()` 会留下永不 resolve 的 promise。触发确认决策的用例（`document.test.ts` / `FileTree.test.ts`）在各自文件内 `vi.mock('@/stores/confirm')` 把 `ask` 换成 `vi.fn()` 桩 —— `vi.resetAllMocks()` 后桩返回 undefined（falsy = 取消），放行时 `mockResolvedValue(true)`。测弹窗本身 / 失效清理的用例（`confirm.test.ts` / `VeloConfirmDialog.test.ts` / `useStaleEntry.test.ts` / `QuickCommandPanel.test.ts`）用真实 store，通过 `store.current` 断言文案、`store.confirm()` / `store.cancel()` 结算。

**新增 Tauri 调用的规约**：

- 在 `src/tauri/` 下建薄封装，业务侧 import 封装，封装内部 import `@tauri-apps/*`。
- 测试只 mock `src/tauri/*` 即可，业务逻辑保持纯净。
- 薄封装本身不写测试。

## 关键取舍

- **回归保护优先，不追求 100% 覆盖** —— 测试是业务改动的秒级反馈，不是考核指标。
- **最便宜层优先** —— 纯函数能覆盖的别上组件 mount，组件能覆盖的别上完整 UI 链路。
- **测行为不测实现** —— 断言「输入 → 用户可观察输出」。
- **Tauri 边界一律 mock** —— 通过一层薄 stub 把 `@tauri-apps/*` 隔在 store / 工具函数之外。
- **薄封装不写测试** —— 测它等于测 mock，无价值。
- **不写测试的场景**：纯展示 / 低交互组件、薄封装 / 转发层、稳定样板代码、只断言「代码跑过了」的用例（半年没抓到回归又无行为断言，敢删）。
- **写测试的触发条件**（满足其一）：修 bug（先写失败回归用例）/ 核心逻辑（schema、markdownIO、outline、syntax、store 状态机）/ 有失败模式的用户交互（快捷键分发、模式切换、查找替换 UI）。
- **组件层标准**：「有交互逻辑 + 有用户可见失败模式」才测，不全覆盖。逻辑重的（`App.vue` 快捷键、`useProseMirror.ts`）用真实 `mount`，纯展示用 `shallowMount`。
- **反模式**：测样式 / class 名；测私有细节（内部 ref 名、函数是否被调用）；测「我点了按钮，某 ref 变成 x」—— 应测「我点了按钮，store 收到信号 / 用户看到 Y」。

## CI 集成

- `.github/workflows/ci.yml`：`workflow_dispatch`（发版前手动）+ tag push `v*` 触发；步骤 checkout → setup-node（Node 22）→ `npm ci` → type-check → lint:deps（dependency-cruiser）→ lint:console → lint:design-tokens → knip（死码检测）→ `eslint . --quiet`（仅卡 error）→ `npm test` → `npm run build`。
- 不在每次 push master 时触发 —— 独立开发 + AI 驱动下每次 push 跑 CI 太慢。
- 不挂覆盖率阈值，只挂「测试通过」门；ESLint warnings 不阻断 CI，通过 CLAUDE.md 约定引导 coding agent 在接触文件时顺手修复。

## 维护约定

1. 新加业务逻辑默认带测试 —— 改 `document.ts` / `outline.ts` / `markdownIO.ts` 这种核心文件时，PR 必须包含对应 `*.test.ts`。
2. Bug 修复先写一个失败用例。
3. 失败用例优先于新功能测试 —— 升级 ProseMirror / remark / Pinia / Tauri 时先跑 `npm test`，红了再决定要不要升级。
4. 改 schema / markdownIO 必跑 round-trip —— `markdownIO.test.ts` 是合约门，开发中跑 `vitest run markdownIO` 确认不破，commit 前跑全量 `vitest run` 必须全绿。
5. 不强求覆盖 —— `MathNodeViews.ts` / `TaskListNodeView.ts` 这类强依赖 ProseMirror 视图 / CodeMirror 内嵌的，绕过。
6. 本文件是测试文档的唯一 canonical source；新增 / 删除测试文件、动测试基建、改变测试规约时更新本文件；纯加测试用例通常不需要改文档，发版时才更新「现状快照」。
7. 不要把阶段勾选表写进测试文档，向前规划走 [ROADMAP.md](../ROADMAP.md)。

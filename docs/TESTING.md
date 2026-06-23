# Velo 自动化测试方案

> 稳定的测试规约（选型 / Tauri 隔离层 / 目录命名 / 维护约定 / 反过度测试）+ 一句话现状快照。
> 向前的测试规划（组件层、E2E 何时启动）走 [`ROADMAP.md`](./ROADMAP.md)，不在此记阶段勾选表。


## 1. 目标与原则

1. **回归保护优先** —— 测试是业务代码改动的快速反馈机制(秒级),不以覆盖率数字为考核指标。
2. **从纯函数到 UI** —— 价值密度最高的逻辑(状态机、文本解析、插件)全部与 DOM 解耦,优先用最便宜的工具覆盖。
3. **Tauri 边界一律 mock** —— 测试不在 Tauri runtime 里跑,通过一层薄薄的 stub 把 `@tauri-apps/*` 隔在 store / 工具函数之外。
4. **测行为不测实现** —— 断言"输入 → 用户可观察输出",不测 class 名 / ref 名 / 内部分支 / 函数是否被调用。
5. **最便宜层优先** —— 纯函数能覆盖的别上组件 mount,组件能覆盖的别上 E2E。
6. **不追求 100% 覆盖** —— 覆盖率只用来发现"哪块完全没被测过",不用来刷分。


## 2. 选型

| 层 | 工具 | 理由 |
|---|---|---|
| 单测 / 集成 | **Vitest** | Vite 原生,TypeScript + ESM + JSDOM 一把梭,极快 |
| 组件 | **@vue/test-utils** | Vue 3 官方 |
| 覆盖率 | **@vitest/coverage-v8** | 看个大概,不卡阈值 |
| 端到端 | **Playwright** + `tauri-driver` | Tauri 2 官方支持 webdriver,真要走 E2E 时再加 |
| 断言辅助 | **@testing-library/jest-dom** | 组件断言更语义化(可选) |

> **不选 Jest** —— 配 ESM + Vite alias 麻烦。**不上 Cypress** —— Tauri 场景里 Playwright + tauri-driver 更顺。


## 3. 现状快照
> 覆盖：纯函数(`utils/`)、Pinia store(`document` / `editor` / `export` / `workspace`)、ProseMirror 核心(markdownIO round-trip / 语法实时转换 / 键位 / NodeView / 插件 / 查找替换)、导出管线(`htmlRenderer` 端到端)、跨模式光标同步、源码模式(CodeMirror 6)、侧边栏(Sidebar tab 切换 / FileTree 过滤排序 / 行内 input CRUD + FileTreeContextMenu 转发)。
>
> 向前规划(组件层按需补、E2E 何时启动)见 ROADMAP,不在此维护阶段表。


## 4. Tauri API 隔离层

**原则**:业务代码只调 `@tauri-apps/*` 的"语义",不关心实现。测试用 `vi.mock` 把 Tauri 全替成 stub。

**已 mock 的清单**(见 `src/test/setup.ts`):
- `@tauri-apps/plugin-fs` → `readTextFile` / `writeTextFile` / `watch`
- `@tauri-apps/plugin-dialog` → `open` / `save` / `confirm`
- `@tauri-apps/api/window` → `getCurrentWindow().setTitle`

**新增 Tauri 调用的规约**:
- 在 `src/tauri/` 下建薄封装(如 `src/tauri/fs.ts`、`src/tauri/dialog.ts`),业务侧 import 封装
- 封装内部 import `@tauri-apps/*`
- 测试只 mock `src/tauri/*` 即可,业务逻辑保持纯净

> 阶段性升级:业务代码直接 import Tauri、mock 也直接打在 `@tauri-apps/*` 的旧写法仍允许;**后续逐步收敛**到 `src/tauri/` 封装层,方便接 E2E。**薄封装本身不写测试**——测它等于测 mock,无价值。


## 5. 目录与命名规范

```
src/
├── test/
│   └── setup.ts                          # 全局 mock、测试期 hook
├── utils/
│   └── __tests__/
│       ├── outline.test.ts
│       └── imagePath.test.ts
├── stores/
│   └── __tests__/
│       ├── document.test.ts
│       ├── editor.test.ts
│       └── export.test.ts
├── lib/export/
│   └── __tests__/
│       └── htmlRenderer.test.ts
└── components/
    ├── __tests__/
    │   ├── crossModeSync.test.ts
    │   ├── SourceModeEditor.test.ts
    │   ├── FileTree.test.ts
    │   └── Sidebar.test.ts
    └── ProseMirrorEditor/
        ├── __tests__/                    # 编辑器核心:markdownIO / 语法 / 键位 / NodeView / 插件
        ├── nodes/__tests__/
        ├── plugins/__tests__/
        └── findreplace/__tests__/
```

约定:
- 单测放 `__tests__/` 子目录,后缀 `.test.ts`(`vitest.config.ts` 已配 include)
- 一个源文件一个对应测试文件,集成场景加 `.integration.test.ts` 后缀
- 描述用 `it('写盘失败时 lastSavedContent 回滚, dirty 恢复', ...)` 这种"行为 + 期望"句式,不要 `it('test save')`


## 6. CI 集成(未接入)

- GitHub Actions 新增 `.github/workflows/test.yml`,触发 `push` 到 master + `PR`;步骤 checkout → setup-node → `npm install` → `npm test`
- 不挂覆盖率阈值,只挂"测试通过"门
- E2E 落地后拆独立 workflow,只对 `main` 触发


## 7. 维护约定

1. **新加业务逻辑默认带测试** —— 改 `document.ts` / `outline.ts` / `markdownIO.ts` 这种核心文件时,改动 PR 必须包含对应 `*.test.ts`。
2. **Bug 修复先写一个失败用例** —— 任何 bug 的修复 PR 第一条 commit 是"加一个会失败的测试",第二条才是"修代码让它绿"。
3. **失败用例优先于新功能测试** —— 升级 ProseMirror / remark / Pinia / Tauri 时,先跑 `npm test`,红了再决定要不要升级。
4. **改 schema / markdownIO 必跑 round-trip** —— `markdownIO.test.ts` 是合约门,任何 schema / 双向序列化改动后 `vitest run` 必须全绿。
5. **不强求覆盖** —— `MathNodeViews.ts` / `TaskListNodeView.ts` / `TextareaEditor.ts` 这类强依赖 ProseMirror 视图 / CodeMirror 内嵌的,绕过。


## 8. 反过度测试

测试不是越多越好。下列**不写**测试:

- **纯展示 / 低交互组件** —— `ExportButton.vue` / `DraftRecoveryDialog.vue` / `CodeBlockLanguagePicker.vue` 这类,没有用户可见的失败模式。
- **薄封装 / 转发层** —— `src/tauri/*.ts` 只是转发 Tauri API,测它等于测 mock。
- **稳定的样板代码** —— boilerplate 配置、纯 CSS 调整、props 透传。
- **只断言"代码跑过了"的用例** —— 半年没抓到回归、又无行为断言,是死重,敢删。阶段性审计一次。

**写测试的触发条件**(满足其一):
- 修 bug(先写失败回归用例)
- 核心逻辑(schema / markdownIO / outline / syntax / store 状态机)
- 有失败模式的用户交互(快捷键分发、模式切换、查找替换 UI)

**组件层标准**:"有交互逻辑 + 有用户可见失败模式"才测,不全覆盖。逻辑重的(`App.vue` 快捷键、`useProseMirror.ts`)用真实 `mount`,纯展示用 `shallowMount`。

**反模式**:
- 测样式 / class 名
- 测私有细节(组件内部 ref 名、函数是否被调用)
- 测"我点了按钮,某 ref 变成 x" —— 应测"我点了按钮,store 收到信号 / 用户看到 Y"

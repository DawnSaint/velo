# Velo 自动化测试方案



## 1. 目标与原则

1. **回归保护优先** —— 测试作为业务代码改动的快速反馈机制(秒级),
   不以覆盖率数字为考核指标。
2. **从纯函数到 UI** —— 价值密度最高的逻辑(状态机、文本解析、插件)
   全部与 DOM 解耦,优先用最便宜的工具覆盖。
3. **Tauri 边界一律 mock** —— 测试不在 Tauri runtime 里跑,通过一层
   薄薄的 stub 把 `@tauri-apps/*` 隔在 store / 工具函数之外。
4. **渐进、可中断** —— 任意阶段停下都不会让工程"半残";每阶段后
   都能继续做功能,只是少了那一层网。
5. **和 Roadmap 同步** —— v0.3/v0.4/v0.5 新加的逻辑(图片资产、Tab 切换、
   持久化)按本文档的分阶段方式持续接入,不让"历史包袱"越积越大。



## 2. 选型

| 层 | 工具 | 理由 |
|---|---|---|
| 单测 / 集成 | **Vitest** | Vite 原生,TypeScript + ESM + JSDOM 一把梭,极快 |
| 组件 | **@vue/test-utils** | Vue 3 官方 |
| 覆盖率 | **@vitest/coverage-v8** | 看个大概,不卡阈值 |
| 端到端 | **Playwright** + `tauri-driver` | Tauri 2 已经官方支持 webdriver,后续真要走 E2E 时再加 |
| 断言辅助 | **@testing-library/jest-dom** | 组件断言更语义化(可选) |

> **不选 Jest** —— 配 ESM + Vite alias 麻烦,生态差距在 Vite 项目里基本消失。
> **不上 Cypress** —— Tauri 场景里 Playwright + tauri-driver 更顺。



## 3. 分阶段路线图



### 阶段 0 — 基础设施(已完成)

**动作**:
- [x] 安装 `vitest` `@vue/test-utils` `@vitest/coverage-v8` `jsdom`
- [x] 新增 `vitest.config.ts`(jsdom + `@/` alias + `passWithNoTests`)
- [x] 新增 `src/test/setup.ts`(预留 hook,目前留空)
- [x] `package.json` 加 `test` / `test:watch` / `test:coverage` 三个脚本



### 阶段 1 — 纯函数(已完成)

- [x] 抽 `stripFormatting` / `stripFencedCodeBlocks` / `parseHeadings` 到 `src/utils/outline.ts`
- [x] `src/utils/__tests__/outline.test.ts`
- [ ] **可选**:`MathNodeViews.ts` / `MermaidSyntax.ts` 纯函数抽取(本期未做)



### 阶段 2 — Pinia store(已完成)

- [x] `src/test/setup.ts` 注册 Tauri mock(plugin-fs / plugin-dialog / api/window)
- [x] `src/stores/__tests__/document.test.ts`
- [x] `src/stores/__tests__/editor.test.ts`
- [x] vitest.config.ts 引入 `setupFiles`,`beforeEach` 用 `resetAllMocks` 清 mock 队列



### 阶段 3 — Milkdown 插件（卡住已修过的 upstream bug）

**目标**:为 `safeCommonmark` / `fixedEmphasisUnderscoreInputRule` /
`fixedStrikethroughInputRule` 写回归测试。

**动作**:
- [ ] 在 `src/components/MilkdownEditor/__tests__/inputRules.test.ts`
  用 prosemirror-state 构造最小 state + dispatch transaction,
  触发 input rule。
- [ ] 重点 case:
  - [ ] inline code 内的 `_x_` 不会被改成 emphasis
  - [ ] 段落末尾 `**foo** ` → bold mark
  - [ ] 段落末尾 `~~strike~~ ` → strikethrough mark
  - [ ] `*foo*`(星号版)正常工作(回归保护用,没改它)
- [ ] 同样地为 `MermaidSyntax.ts` 的"识别 ```mermaid 围栏"写 1~2 条
  转换测试。

**验收**:
- [ ] `inputRules.test.ts` ≥ 5 条 case
- [ ] 升级 Milkdown 时能跑出红 → 绿



### 阶段 4 — 组件层（持续,按需补）

**目标**:组件按"用户可见 + 有交互逻辑"的标准挑,不全覆盖。

**优先级**(从高到低):
1. `EditorSettings.vue` —— 开关切换、双向绑定
2. `App.vue` 的 Ctrl+S 快捷键分发
3. `MilkdownEditor/index.vue` —— `tabIndent`、Plan B 修复、
   `onCardClick` 行为

**推荐写法**:`@vue/test-utils` 的 `mount` + 必要时的浅渲染
`shallowMount`。逻辑较重的(如 `App.vue` 的快捷键)用真实 mount,
纯展示的(将来的 `Welcome.vue`)用 shallow。

**反模式提示**:
- **不要**测样式 / class 名
- **不要**测私有细节(组件内部 ref 名)
- **要**测用户行为("我点了按钮,store 收到信号"而不是
  "按钮的第 3 个 ref 被改成 x")

**验收**:
- [ ] 每个组件至少 3 条 case
- [ ] 聚焦"输入 → 输出"行为断言,不测内部实现



### 阶段 5 — E2E（需要时启动）

**目标**:端到端覆盖高价值用户路径。

**触发条件**:
- v0.4 多 Tab、v0.5 工作区 出现"跨组件状态流"时
- 手动回归成本明显上升

**动作**:
- [ ] 装 `@playwright/test` + `tauri-driver`
- [ ] `tauri.conf.json` 打开 webdriver(参考 Tauri 2 官方文档)
- [ ] 写 `e2e/` 目录,首批 3 个流程:
  - [ ] 新建 → 输入 → 保存 → 关闭 → 重开 → 内容还在
  - [ ] 外部修改文件 → 应用内弹确认 / 静默重载
  - [ ] 切换暗色模式 → 标题栏 native theme 变化

**注意**:E2E 跑得慢、不稳定、易过期,**只在前面 4 阶段做完、
手动回归明显吃力时**再开。



## 4. Tauri API 隔离层



**原则**:业务代码只调 `@tauri-apps/*` 的"语义",不关心实现。
测试用 `vi.mock` 把 Tauri 全替成 stub。

**已 mock 的清单**(阶段 2 起固定):
- `@tauri-apps/plugin-fs` → `readTextFile` / `writeTextFile` / `watch`
- `@tauri-apps/plugin-dialog` → `open` / `save` / `confirm`
- `@tauri-apps/api/window` → `getCurrentWindow().setTitle`

**新增 Tauri 调用的规约**:
- 在 `src/tauri/` 下建薄封装(如 `src/tauri/fs.ts`、
  `src/tauri/dialog.ts`),业务侧 import 的是封装
- 封装内部 import `@tauri-apps/*`
- 测试只 mock `src/tauri/*` 即可,业务逻辑保持纯净

> 这是阶段性升级 —— 阶段 0~2 允许业务代码直接 import Tauri,
> mock 也直接打在 `@tauri-apps/*`;**阶段 3 之后** 建议逐步收敛到
> `src/tauri/` 封装层,方便后续接 E2E。



## 5. 目录与命名规范

```
src/
├── test/
│   └── setup.ts                   # 全局 mock、测试期 hook
├── utils/
│   ├── outline.ts                 # 纯函数
│   └── __tests__/
│       └── outline.test.ts
├── stores/
│   ├── document.ts
│   ├── editor.ts
│   └── __tests__/
│       ├── document.test.ts
│       └── editor.test.ts
└── components/
    └── MilkdownEditor/
        ├── __tests__/
        │   └── inputRules.test.ts
        └── ...
```

约定:
- 单测放 `__tests__/` 子目录,后缀 `.test.ts`(阶段 0 已在 `vitest.config.ts` 配)
- 一个源文件一个对应测试文件,除非是阶段 5 那种端到端流程
- 描述用 `it('写盘失败时 lastSavedContent 回滚, dirty 恢复', ...)` 这种
  "行为 + 期望"句式,不要 `it('test save')` 这种空标题



## 6. CI 集成

**阶段 0 接入**:
- GitHub Actions 新增 `.github/workflows/test.yml`
- 触发:`push` 到 master、`PR` 打开 / 更新
- 步骤:checkout → setup-node → `npm install` → `npm test`
- 不挂覆盖率阈值,只挂"测试通过"门

**后续升级**:
- 阶段 2 之后:`npm run test:coverage` 上传 codecov(可选)
- 阶段 5 之后:E2E job 拆独立 workflow,只对 `main` 分支触发,
  跑通时间 ≥ 5 分钟可以接受



## 7. 维护约定

1. **新加业务逻辑默认带测试** —— 改 `document.ts` / `outline.ts` 这种
   核心文件时,PR 必须包含对应 `*.test.ts` 的改动。
2. **Bug 修复先写一个失败用例** —— 任何 bug 的修复 PR 第一条
   commit 应该是"加一个会失败的测试",第二条才是"修代码让它绿"。
   这是阶段 2 之后项目的隐性约定。
3. **失败用例优先于新功能测试** —— 看到 `package.json` 升级
   Milkdown / Pinia / Tauri 时,先跑一遍 `npm test`,红了再决定
   要不要升级。
4. **不追求 100% 覆盖** —— `MathNodeViews.ts` / `MermaidNodeView.ts`
   这类强依赖 ProseMirror 视图的,绕过。覆盖率的目的是"看哪块
   完全没被测过",不是"刷到 100%"。



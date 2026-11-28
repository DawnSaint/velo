# Velo Roadmap

> **维护规范**:
>
> - 每条 `- [ ]` 完成后改 `- [x]`，不要删除条目
> - 实现过程中发现原计划无法落地或方案改了 → 用删除线 + `→` 注明实际走法
>
> **调研文档**（`docs/research/`）:
>
> - **如何引用**: 在对应功能条目末尾加 `—— [RESEARCH](./research/xxx.md)` 链接，ROADMAP 是调研文档的唯一入口
> - **文件命名**: `docs/research/<feature-name>.md`，一个功能一篇，不设总索引文件
> - **写什么**: 候选方案对比、第三方依赖评估、与现有架构的结合点、风险点、推荐路线；不写实现步骤（实现后进 architecture docs）



## P3 — 远期方向

- [ ] **AI 辅助写作** `#ai-assist` `P3` `?`

- [ ] **主题市场** `#theme-market` `P3` `XL` `?`
  - 自定义颜色方案 / 字号规范 / 段落间距整套打包
  - 导入 / 导出主题 JSON
  - 社区分享（远期）

- [ ] **多种自带主题预设** `#theme-presets` `P3` `M`
  - 除当前两套外增加更多内置主题
  - 与主题市场共享主题数据格式

- [ ] **书签** `#bookmark` `P3` `S`
  - 在文档内标记位置，侧栏 / 命令面板快速跳回
  - per-file 书签列表，不跨文件（跨文件走大纲 / 标题跳转）

- [ ] **表格插入时选 MxN 尺寸** `#table-enhance-2` `P3` `M` `← #table-enhance`
  - 当前 `Mod-t` 只能插 2 × 2 表,扩展为插入前让用户选行数 × 列数,支持右键菜单与快捷键触发;编辑后光标落到新表首 cell。

- [ ] **AI Coherence Layer 共享版本数据层** `#coherence-layer` `P3` `L` `← #local-timeline`
  - 在本地版本时间线基础上抽象出统一的版本数据层，供未来 AI 集成消费
  - 提供结构化的版本 diff API（不只是行级，需理解 markdown 语义）
  - 版本数据可被 AI 用于上下文重建、变更意图推断、多文件一致性检查
  - 依赖 #local-timeline 的快照存储管线已就绪，此条目聚焦数据层抽象与 AI 消费接口
- [ ] **Stryker 变异测试** `#stryker` `P2` `L`
  - Velo 测试只跑 v8 覆盖率，容易高估有效性；变异测试能抓"测试过了但其实没断言"的假绿
  - 先对核心模块（`markdownIO` / `documentStore` / schema）

- [ ] **类型检查链路迁移 TS7** `#ts7-toolchain` `P3` `M`
  - 现状 `vue-tsc` 3.3.11 + TypeScript 6.0.3；TS7 是 Go 重写，`vue-tsc` 无法沿用，需切到 TS 官方 content-mappers 机制（`@vue/content-mapper` v4 alpha），编译器可选 tsrs（Rust 移植，npm `latest=7.1.0-beta.tsrs5`）或官方 `typescript@7.1.0-beta`
  - 实测（隔离环境，未改依赖）：`type-check` 约 10.3s → ~2.6s；但 v4 mapper 更严，暴露 150 个既有类型问题，一份 d.ts 补丁（`GlobalDirectives` + `data-*` / `aria-*`）+ 2 处 store 类型收窄可压到 12 个
  - 阻塞项：`typescript-eslint` peer 尚不支持 TS7；Volar v4 editor 支持未合并（vuejs/language-tools#6170）
  - 前置准备（不切换即可做，对现状无害）：`vVeloScroll` 全局指令声明、`data-*` / `aria-*` 全局类型补丁、`themeMode` / `startupMode` store 类型收窄
  - 调研见 [RESEARCH](./research/tsrs-content-mapper.md)

- [ ] **Lint 链路切换到 oxlint（type-aware 后端 tsrs）** `#oxlint-lint` `P3` `M` `← #ts7-toolchain`
  - oxlint 1.95.0（Rust linter）；实测同项目全量 lint 15.96s → 1.04s（~15×）；`@oxlint/migrate` 可从现有 flat config 生成 `.oxlintrc.json`（core / TS / globals / overrides 迁移覆盖良好）
  - type-aware 后端用 tsrs：装 `oxlint + tsrs` 后 oxlint 自动用 tsrs-lint（实测 `no-floating-promises` / `no-unnecessary-condition` 生效），同时绕开 `typescript-eslint` 不支持 TS7 的阻塞
  - 硬缺口：Vue 模板规则整批不支持（oxlint 仅 lint `<script>` 块），项目用到的 `attributes-order` / `no-v-html` / `html-self-closing` 等失效；官方路径 language plugins RFC #21936 / content mapper RFC #29142 均未落地，过渡可用第三方 `oxlint-vue-rs`
  - 策略：阶段 1 混合跑（oxlint 接管非模板 + ESLint 保留 vue 模板规则），阶段 2 随官方 language plugin 落地收回
  - 调研见 [RESEARCH](./research/tsrs-content-mapper.md)

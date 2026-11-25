# tsrs + @vue/content-mapper 迁移可行性调研

> 目标：评估把 Velo 的类型检查从 `vue-tsc`(TS 6.0.3) 切换到 **tsrs 7.1.0-beta.tsrs5**（搭配 `@vue/content-mapper`）的可行性、代价与收益。
>
> 结论先说：**技术上可行，且已在与本项目同规模的隔离环境实测跑通**；速度约 3.9×（10.3s → 2.7s），输出与官方 `tsc 7.1.0-beta` 高度一致。但提速主要来自 **TS 引擎换代**（JS 管线 → 原生 TS7），在本项目这种"Vue content mapper + ~400 文件 + Windows"场景下，tsrs 与官方 tsc 速度基本同档；tsrs 的差异化价值在内存 / WASM / 编辑器生态。真正的摩擦不在 tsrs 本身，而在 **Vue Language Tools v4 的检查变严**（暴露 150 个既有类型问题）与 **`typescript-eslint` 尚未支持 TS 7**。
>
> 附加（lint 联动）：若同时把 lint 切到 **oxlint**（type-aware 后端就是 tsrs），两者组成同一套 Rust/TS7 工具链——实测全量 lint 15.96s → 1.04s（~15×），并能绕开 `typescript-eslint` 对 TS7 的支持缺口；唯一硬缺口是 Vue 模板规则（oxlint 目前只 lint `<script>` 块）。细节见 §8。

---

## 1. 背景：这两样东西为什么会出现

- **TypeScript 7 是 Go 重写的原生编译器**（官方 `typescript` npm 包的 `beta`/`next` tag），`vue-tsc` 依赖 patch JS 版 TypeScript 编译器，无法用于 TS7。
- **content mapper** 是 TypeScript 7.1 引入的**官方插件钩子**：`tsconfig.json` 顶层声明 `contentMappers`，编译器把 `.vue` 这类文件交给 mapper 包换成虚拟 TS 再做类型检查，错误位置映射回原文件。`@vue/content-mapper`（Vue Language Tools **v4 alpha**）是其官方实现；v4 顺手移除了 `vue-tsc` / `@vue/typescript-plugin` / `@volar/typescript` 三个"外挂"包。
- **tsrs** 是 oxc-project 的 TypeScript 7 Rust 移植（Cloudflare 等参与），npm 包名 `tsrs`，CLI 与 `tsc` drop-in 对应；`7.1.0-beta.tsrs5` 对齐 `microsoft/TypeScript@3e9236361fa9`（7.1.0-beta）。目标是 100% conformance + 更低内存。

三者关系：**content mapper 是 TS 官方机制；`@vue/content-mapper` 是 Vue 侧实现；tsrs 是可选的编译器后端**。官方 `tsc` 与 `tsrs` 都实现了这套钩子，因此都能搭配 `@vue/content-mapper`。

## 2. 候选方案对比

| 维度 | A. 维持现状（vue-tsc 3 + TS 6.0.3） | B. 官方 TS 7.1 beta + content-mapper | C. tsrs + content-mapper（本次调研对象） |
|---|---|---|---|
| 实测耗时（本项目，带 mapper，中位） | 10.31s | ~2.99s | ~2.72s |
| 与官方 diagnostics 一致性 | v3 规则，宽松 | 基准 | 150 vs 150，仅 7 处文本级差异（见 §3） |
| `.vue` 类型检查能力 | 有（Volar v3 管线） | 有（同一 Volar 代码生成） | 有（实测错误位置精确映射回 `.vue` 原始行列） |
| 可选 flag | — | `--runExternalCode`（`-p` / `-b` 均可） | 同左；另有 `--fast` 性能预设 |
| 成熟度 | 稳定 | TS 7.1 beta + mapper alpha | tsrs beta（对齐 TS 7.1 beta）+ mapper alpha |
| 周边工具兼容 | 好 | **typescript-eslint 不支持 TS7**（peer `<6.1.0`） | 同 B |
| 编辑器 | Volar 稳定 | VS Code 需 TS7 扩展 + mapper 支持仍在 PR #6170 | tsrs 自带 LSP；VS Code 需把 `js/ts.tsdk.path` 指向 tsrs SDK |
| 差异化价值 | — | 官方维护、路径最短 | 更低内存、WASM（`@tsrs/wasm`）、Oxc 生态整合、Neovim 文档完善 |

**关键判断**：B 与 C 在速度、检查能力上同一档（同一 mapper、同一 TS 7.1 引擎）。选 tsrs 的理由应该是内存 / WASM / Oxc 生态，而不是"更快"（详见 §3 与 §6 的性能归因）。

## 3. 实测记录

方法：把项目 `src/`（45 个 `.vue` + 364 个 `.ts`/`.tsx`，约 3.9MB）复制到隔离目录，`node_modules` 用目录联接 / 本地安装复用，**未改动项目任何依赖**；配置改为迁移后形态（删 `baseUrl`、加 `contentMappers`、`target: 3.5`）。同一工程、同一命令形态下交替跑 5 轮取中位数。

| # | 命令（均为 `-b . --force --runExternalCode`） | 耗时（中位） | 错误数 |
|---|---|---|---|
| 1 | `vue-tsc --build --force`（现状基线） | **10.31s**（单轮） | 0（v3 规则宽松） |
| 2 | `tsrs` | **2.72s** | 150 |
| 3 | `tsrs --fast` | 2.76s（单轮） | 150 |
| 4 | 官方 `tsc`（typescript@7.1.0-beta） | **2.99s** | 150 |
| 5 | `tsrs`，去掉 content-mappers（仅 `.ts`）粗对照 | 0.52s | — |
| 6 | 官方 `tsc`，同 #5 | 0.90s | — |

要点：

- **带 Vue mapper 时两者基本同档**（2.72 vs 2.99s，tsrs 略快约 9%）。单轮计时噪声很大——首轮普查时官方一度快 25%，5 轮交替中位数才稳定；引用单次数字没有意义。
- **去掉 mapper 后 tsrs 优势显现**（0.52 vs 0.90s，约 1.7×），与 tsrs 官方基准趋势一致。即：`.vue` 经 Node 子进程做虚拟代码转换 / 位置映射的开销是本场景的主要瓶颈，把两个引擎的速度差稀释掉了。

**等价性**：#2 与 #4 各报 150 个错误，逐一比对仅 7 处差异，全部集中在 contextmenu 组件的 props 类型文本归属（如 `dataImageContextMenu` 报在哪一层类型上），无任何漏报/误报级别的偏差。不带 `--runExternalCode` 时 tsrs 与官方一致地报 `TS18068` 并把 `.vue` 当未知模块——**flag 漏加会静默漏检模板，属于必须守住的集成点**。

**配置兼容性实测**：现有 `tsconfig.json` 直接给 tsrs 用会报 `TS5102 Option 'baseUrl' has been removed` 与 `TS5090 Non-relative paths are not allowed`；`ignoreDeprecations: "6.0"` 同批失效。迁移必须删 `baseUrl`、`paths` 改写为 `./src/*`、删 `ignoreDeprecations`。

## 4. 与现有架构的结合点（改动面清单）

- **package.json**：移除 `vue-tsc`；新增 `tsrs@7.1.0-beta.tsrs5`、`@vue/content-mapper@4.0.0-alpha.0`；`typescript` 从 `^6.0.0` 升到 `7.1.0-beta`——注意 **CLI 即使用 tsrs，`typescript` 包仍需保留**：mapper 与 `@vue/language-core@4` 的 peer 要求 `typescript >=7.1.0-beta`，mapper 进程（`node server.js`）在 Node 里运行，需要这个包。
- **tsconfig.json**：删 `baseUrl` / `ignoreDeprecations`，`paths` 改 `"@/*": ["./src/*"]`；顶层新增 `contentMappers: [{ "package": "@vue/content-mapper", "extensions": [".vue"], "options": { "target": 3.5 } }]`（`target: 3.5` 对齐项目 vue 3.5.42）。
- **scripts**：`type-check` 改为 `tsrs -b . --force --runExternalCode`；`build` 同步（`vue-tsc --build --force && vite build` → `tsrs -b . --force --runExternalCode && vite build`）。
- **CI**：`ci.yml` / `npm run ci` 只是调用 `type-check`，脚本改完即生效，workflow 不用动；注意 CI runner 会随 tsrs 安装平台二进制 `@tsrs/win32-x64` 等 optional 依赖。
- **编辑器**：VS Code 需要 TS7 扩展（`TypeScriptTeam.native-preview`）并把 `js/ts.tsdk.path` 指向 tsrs SDK 目录（Windows 上指向 `@tsrs/win32-x64` 包根）；Volar 官方对 v4 mapper 的 editor 支持（跳转 / rename 回归）仍未合并，见 [vuejs/language-tools#6170](https://github.com/vuejs/language-tools/pull/6170)。
- **不受影响**：Vite（从不用 vue-tsc）、vitest、knip（依赖 `oxc-parser`，不读 `typescript` 包）、eslint-plugin-vue / vue-eslint-parser（走自身解析器）。**唯一直接受影响的是 `typescript-eslint`**（见 §6）。
- **数据流 / schema / 运行时**：零影响。本次改动只涉及类型检查链路与构建期校验。

## 5. v4 mapper 暴露的既有类型问题（150 → 12）

现状 0 错误是 vue-tsc v3 检查宽松的假象。换 v4 mapper 后立即暴露 150 个，构成如下：

| 类别 | 数量 | 性质 | 处置 |
|---|---|---|---|
| `TS2353` 自定义组件收到 `data-*`（`data-testid` ×93 等） | ~105 | 测试钩子属性，运行时 fallthrough 透传，无害 | 一份全局 d.ts 补丁（`ComponentCustomProps` / `HTMLAttributes` 增加 `data-*`、`aria-*` 索引签名） |
| `TS2353` 自定义组件收到 `aria-label` / 原生元素收到 `data-tauri-drag-region` 等 | ~26 | 同上（kebab attr 不被当作 camel prop） | 同上 |
| `TS2339` 全局指令 `vVeloScroll` 未声明 | 10 | 类型声明缺失（`main.ts` 用 `app.directive('velo-scroll', ...)` 注册） | `declare module 'vue' { interface GlobalDirectives { vVeloScroll: ... } }` |
| `TS2322` `store.themeMode` / `store.startupMode` 是 `string`，传给期望字面量联合的 prop | 2 | 真类型缺陷（store ref 定义过宽） | 收窄 store 类型为 `ThemeMode` / `StartupMode` |
| `TS2367` FileTree.vue(714,12) `'node'` vs `'inlineNew'` 比较无重叠 | 7（同一行重复 7 次） | 疑似 mapper 在 `v-for` + 多分支模板上的重复诊断 bug（该行只是 `v-else` 的 div） | 向 mapper/issue 反馈；短期可局部处理 |

**补丁实验**：把上面前两类（d.ts 补丁）+ 第三类（指令声明）一次性加上后，错误从 150 降到 **12**。即**迁移的类型修复成本约为：1 份 d.ts + 2 处 store 类型 + 1 个 mapper bug 待观察**，可控。

另测：mapper option `fallthroughAttributes: true` 在本项目几乎无效（151 → 150），不要指望它消除这类错误。

两个已知的 v4 mapper bug（alexop.dev 记录）本项目**不触发**：项目没有空事件处理器 `@click=""` 形态，也未开启 `allowUnreachableCode`。

## 6. 风险点

1. **`typescript-eslint` 尚未支持 TS 7**（对 ESLint 链路是最大阻塞）。8.74.0 及 canary 的 peer 都是 `typescript >=4.8.4 <6.1.0`。升级 `typescript` 到 7.1 后 peer 冲突（npm 警告 / pnpm 严格模式报错），且 parser 直接调用 TS compiler API，未经官方验证。`npm run ci` 里的 eslint 环节存在失效风险。**缓解：把 lint 切到 oxlint 后该阻塞消失（见 §8.5）**；保留 ESLint 的部分（如 Vue 模板规则）仍会受影响，这也是混合运行期需要留意的一点。
2. **mapper 与 Volar v4 均为 alpha**，`@vue/content-mapper` 的 dist-tag 混乱（`latest=4.0.0-alpha.0`，`alpha=4.0.0-alpha.3`），上游 PR #6170 未合并，编辑器跳转 / rename 有已知回归。
3. **tsrs 是 beta**：版本号随 TS beta 走；部分能力缺失（Windows `--watch` 不支持、`--init`/`--locale` 等），且 fast 模式与默认模式的诊断在边界 case 可能有差异（本项目实测无差异）。
4. **性能收益归因（重要，避免误读实测）**：tsrs 的"最高 8× / 省 70% 内存"是 **vs TypeScript 7.0** 的早期口径；tsrs 官方 `bench/RESULTS.md` 对 **7.1 beta** 的默认设置数字是 1.87–4.17×，等线程独立复测约 2.5–2.9×（ImportStatic、sph.sh），且基准都是**纯 TS 大项目 + macOS/Linux + PGO 构建**。这些优势在本项目被三件事抹平：① Vue content mapper 的 Node 子进程逐文件开销成为主瓶颈（实测去掉 mapper 后 tsrs 从 2.72s → 0.52s，优势从 9% 拉到 1.7×）；② 项目只有 ~400 文件，固定开销占比高，`--fast` 的多 checker 收益小；③ Windows 平台 + 单轮噪声。社区讨论（Hacker News 207 条评论、多篇独立评测）的共识也是"多数项目 tsgo 已经够快"。**结论：tsrs 的强项是内存与大项目吞吐，不是小项目的 Vue 全量检查。**
5. **缓存切换**：换引擎 / 切换 `--fast` 会使 `.tsbuildinfo` 不兼容，需要清缓存重跑（一次性）。
6. **集成点易漏**：`--runExternalCode` 不加则静默不检查模板；CI 与本地脚本必须同步。
7. **prerelease 依赖**：`tsrs` / `@vue/content-mapper` / `typescript@7.1.0-beta` 三者版本联动，升级需整组一起升。

## 7. 推荐路线

- **现在（不切换，零风险准备）**：落地 §5 的三类修复——`vVeloScroll` 全局指令声明、`data-*`/`aria-*` 全局类型补丁、`themeMode`/`startupMode` store 类型收窄。这些改动对现状无害，且是迁移的前置条件（与 alexop.dev 对 Directus 的建议一致）。
- **验证性迁移（愿意吃 beta）**：开分支按 §4 改动，跑一次完整 `npm run ci`，重点观察 eslint 环节与 CI 平台二进制安装。实测数据表明 tsrs 可跑通且与官方等价。
- **正式切换时机**：建议等 **TS 7.1 stable + Vue Language Tools v4 stable + `typescript-eslint` 官方支持 TS 7** 三者齐备；届时无论选官方 tsc 还是 tsrs，迁移阻力都最小。
- **lint 先行（与本条目协同）**：即使类型检查暂不迁移，也可先把 lint 切到 oxlint（阶段 1 混合跑：oxlint 接管非模板规则 + ESLint 保留 Vue 模板规则），立即拿到 ~15× 提速并提前接入 tsrs 生态，同时绕开 `typescript-eslint` 不支持 TS7 的阻塞。详见 `#oxlint-lint` 条目与本文档 §8。
- **选 tsrs 还是官方 tsc**：两者检查能力与速度同档。若看重内存占用、WASM / 浏览器内检查、Oxc 工具链（oxlint 类型感知 lint 后端已是 `tsrs-lint`）与 Neovim 场景，tsrs 更有长期价值；若只图省事，官方路径更短。**lint 侧切成 oxlint 后，`typescript-eslint` 对 TS7 的支持缺口不再阻塞工程链路。**

## 8. oxlint 调研（lint 链路同步切换）

> 用户规划：后续把 lint 也切到 oxlint。结论：**与 tsrs 是同一套 Rust/TS7 工具链，互相解锁**——oxlint 的 type-aware 后端首选就是 tsrs-lint；实测提速约 15×；唯一硬缺口是 Vue 模板规则。

### 8.1 现状

- `oxlint` npm latest **1.95.0**；Rust 实现的 JS/TS linter（Oxc 项目），v1.0 stable 于 2025-06 发布；官方口径比 ESLint 快 50–100×，内置 870+ 规则（ESLint core、typescript-eslint 非 type-aware 集、unicorn、import、jest/vitest、react、jsx-a11y、jsdoc、node/promise、vue 等）。
- 配置 `.oxlintrc.json`（ESLint v8 风格）；`@oxlint/migrate` 可从现有 flat config 自动生成配置（实测可用）。

### 8.2 与 tsrs 的组合（核心协同点）

- type-aware 后端有两组：`tsgolint`（Go）与 `tsrs-lint`（Rust）。官方已明确**优先 tsrs**：安装 `oxlint + tsrs` 后 oxlint **自动**使用 tsrs（无需配置路径），`--type-aware` / `options.typeAware` 开启，`--type-check` 顺带报告 TS 类型错误；覆盖 typescript-eslint 62 条 type-aware 规则中的 60 条。
- 实测（隔离环境）：装 `oxlint + tsrs` 后运行 `oxlint --type-aware -D typescript/no-floating-promises -D typescript/no-unnecessary-condition fixtures/TypeAwareSample.ts`，两条规则均正确报出——联动零配置。

### 8.3 实测：速度、迁移覆盖度、Vue 缺口

| 项 | ESLint（现状基线） | oxlint |
|---|---|---|
| 全量耗时（同机同批） | **15.96s**（`eslint . --quiet`） | **1.04s**（约 15×） |
| Vue 模板规则 | 正常（fixture 实测命中 `vue/attributes-order`） | **完全静默**（fixture 零输出） |
| type-aware | 需 `parserOptions.project`，走本地 TS 包 API | tsrs-lint（TS7 引擎），60/62 规则 |

- **迁移工具**：`npx @oxlint/migrate eslint.config.js --details` 生成了完整 `.oxlintrc.json`——ESLint core 与 typescript-eslint 单规则、全局变量、测试/cjs/scripts 的 overrides 都迁移成功；severity 会重排（推荐集展开为单规则列表、`categories.correctness=off`），需人工整理成分级形式。
- **硬缺口**：迁移工具对项目用到的 `vue/attributes-order`、`vue/no-v-html`、`vue/html-self-closing`、`vue/max-attributes-per-line`、`vue/singleline-html-element-content-newline` 逐条回复 *"Not currently possible, as it requires Vue template parsing"*。oxlint 当前只 lint `.vue` 的 `<script>` 块，**模板规则整批缺失**。

### 8.4 Vue 支持的落地路径

- 官方（均未落地）：language plugins RFC [#21936](https://github.com/oxc-project/oxc/discussions/21936) 与实施计划 [issue #23207](https://github.com/oxc-project/oxc/issues/23207)（让插件拿到模板 AST）；content mapper RFC [#29142](https://github.com/oxc-project/oxc/discussions/29142)（Phase 1 让 tsrs-lint 处理 `.vue`，原型对 Vue 的误报率 <1%）。社区已在等（#23207 下有 Vue 项目表示"drop ESLint entirely 只差这个"）。
- 第三方过渡：[`oxlint-vue-rs`](https://crates.io/crates/oxlint-vue-rs)（0.1.4，2026-11-12）以 oxlint JS plugin 形式补齐 oxlint 缺的 210 条 eslint-plugin-vue 规则（含模板），preset 复刻 `flat/recommended`；[`vad1ym/oxlint-vue`](https://github.com/vad1ym/oxlint-vue) 同类（69 implemented + 59 native）。可用但需评估第三方维护性。

### 8.5 迁移策略

- **阶段 1（现在即可做）**：oxlint 接管非模板规则，ESLint 暂时保留跑 Vue 模板规则与存量 type-aware（官方推荐的迁移期做法：`oxlint && eslint`，配合 `eslint-plugin-oxlint` 关闭重叠规则）。立刻拿到 ~15× 提速，并提前接入 tsrs（type-aware 后端）。
- **阶段 2**：跟进 language plugins / content mapper 落地后收回模板规则；或评估 `oxlint-vue-rs`。
- **与 §6 风险 1 的关系**：切 oxlint 后，lint 侧不再依赖 `typescript-eslint` 包（oxlint 的 TS 规则是原生 Rust 实现，type-aware 走 tsrs），**typescript-eslint 不支持 TS7 的阻塞对 lint 链路直接消失**；该阻塞只剩"保留 ESLint 的部分"。
- **不受影响**：`lint:console` / `lint:design-tokens`（自写 node 脚本）、`lint:deps`（dependency-cruiser）、`knip` 原样保留。

## 9. 参考来源

- [Goodbye vue-tsc? Moving a Vue Project to TypeScript 7.1 Content Mappers](https://alexop.dev/posts/goodbye-vue-tsc-typescript-7-content-mappers/)（含 Directus 迁移 benchmark 与 v4 已知 bug）
- [Announcing TypeScript 7.1 Beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
- [oxc-project/tsrs](https://github.com/oxc-project/tsrs) / [COMPATIBILITY.md](https://github.com/oxc-project/tsrs/blob/main/docs/COMPATIBILITY.md) / [DEFAULTS.md](https://github.com/oxc-project/tsrs/blob/main/docs/DEFAULTS.md) / [LSP.md](https://github.com/oxc-project/tsrs/blob/main/docs/LSP.md)
- [Introducing tsrs: a Port of TypeScript to Rust（Cloudflare）](https://blog.cloudflare.com/typescript-rust-port/)
- [tsrs bench/RESULTS.md](https://github.com/oxc-project/tsrs/blob/main/bench/RESULTS.md)（官方基准口径：对 7.1 beta 默认设置 1.87–4.17×）
- 性能归因与社区讨论：[ImportStatic 等线程复测（2.86×）](https://importstatic.com/rust/tsrs-vs-tsgo-typescript-7-1) · [sph.sh 基准（单线程 2.3–2.7×，默认行为变化）](https://sph.sh/en/posts/tsrs-typescript-rust-port-benchmarks) · [dev.to：8× 说法更接近 3×](https://dev.to/alanwest/cloudflares-rust-typescript-tsrs-vs-tsgo-the-8x-claim-is-closer-to-3x-37o4) · [Niz Logger：CI trial 指南](https://nizify.in/posts/tsrs-rust-typescript-port-vs-typescript-7)
- [vuejs/language-tools#6170（content mapper v4 alpha PR）](https://github.com/vuejs/language-tools/pull/6170)、[tsrs#issue 877](https://github.com/oxc-project/tsrs/issues/877)（CLI/API 对 mapper 的支持过程）

# Obsidian 风格知识图谱调研

> **性质**：pre-implementation 设计研究，候选方案尚未拍板。后续若决定实现，重大取舍进 `DECISIONS.md` ADR，最终架构同步 `ARCHITECTURE.md`。
> **对应 ROADMAP**：双链 / 反向链接
> **调研日期**：2026-06-25。
> **当前状态**：初版基于代码库现状与公开开源资料整理；后续通过 `npm view` 获取最新包元数据并补充「实施路线 / 数据模型 / 索引策略 / Wikilink 解析」等章节；如后续 deep research 有新证据，可继续修订本文。
>
> **前置约束（再调研补强）**：
>
> - Velo 当前没有「快速打开 / 全文搜索 / 知识图谱」等类似现成图索引 store；已对照现有 `workspaceStore`、`Sidebar.vue`、`persistence.ts`、`quickOpenIndex.ts`（后者不存在，但项目里有 outlineFilter 文件，说明该命名风格仅示例）等找设计参照。

---

### 0. 结论

Velo 可以实现类似 Obsidian 的知识图谱 / 关系图谱，而且与当前架构较匹配：Velo 已经具备工作区根目录、文件树、递归 `fs.watch`、Markdown 解析管线、Sidebar tab 容器、Pinia store。这些正好是实现「全局图谱 / 局部图谱 / 反向链接」的基础。

真正难点不在画图，而在稳定、增量地维护 Markdown 文件之间的链接索引。

推荐路线：

1. 第一阶段不要直接做完整 Obsidian Graph View，先做「链接索引 + 反向链接面板」。
2. 链接语法先支持：
   - 标准 Markdown 链接：`[title](./note.md)` / `[title](#heading)`
   - Obsidian 风格 Wikilink：`[[Note]]`、`[[Note#Heading]]`、`[[Note|Alias]]`
3. 图渲染推荐：
   - MVP / 中小知识库：`force-graph`
   - 更工程化 / 可扩展 / 上万节点：`sigma + graphology`
   - 不建议一开始上 `@antv/g6`，能力强但偏重。
4. 数据层建议新建 `knowledgeGraphStore`，图数据从「工作区 Markdown 文件索引」生成，而不是从当前 ProseMirror doc 直接生成。
5. UI 上最自然的位置是现有 Sidebar 新增一个 tab：`大纲 / 文件 / 图谱`，后续可再做独立全屏图谱窗口。

---

### 1. 功能拆解

#### 1.1 节点

Obsidian 图谱里常见节点类型：

| 节点类型 | Velo 中如何表示 |
|---|---|
| 已存在 Markdown 文件 | 工作区内 `.md` 文件，节点 id 用绝对路径或 workspace-relative path |
| 未创建页面 / dangling link | `[[Missing Note]]` 指向但文件不存在 |
| heading anchor | 可作为边的属性，MVP 不必独立成节点 |
| tag | `#tag` 可作为二期节点 |
| attachment | 图片 / PDF 等资源，MVP 可忽略或作为弱节点 |

建议 MVP 节点模型：

```ts
type GraphNode = {
  id: string // workspace-relative normalized path or virtual wikilink id
  path?: string
  title: string
  kind: 'file' | 'missing' | 'tag'
  inDegree: number
  outDegree: number
}
```

#### 1.2 边

边来自 Markdown 文本，而不是 ProseMirror 编辑态 DOM。

| 来源 | 示例 | 是否建议 MVP 支持 |
|---|---|---|
| Markdown link | `[foo](foo.md)` | 是 |
| Wikilink | `[[foo]]` | 是 |
| Wikilink heading | `[[foo#bar]]` | 是，anchor 作为 edge 属性 |
| Embed | `![[foo]]` | 二期 |
| Tag | `#project/velo` | 二期 |
| HTML link | `<a href="foo.md">` | 可后置 |

建议边模型：

```ts
type GraphEdge = {
  id: string
  source: string
  target: string
  kind: 'markdown' | 'wikilink' | 'tag' | 'embed'
  sourcePath: string
  targetPath?: string
  rawTarget: string
  anchor?: string
  alias?: string
  line?: number
}
```

#### 1.3 全局图 / 局部图

| 模式 | 说明 | 实现方式 |
|---|---|---|
| 全局图 | 当前 workspace 所有 Markdown 文件关系 | 直接从索引生成所有 nodes / edges |
| 局部图 | 当前文件 N 跳邻居 | 从当前 file node BFS，depth 默认 1 或 2 |

Quartz 的 Graph 组件也区分 localGraph / globalGraph；默认 local graph depth 为 1，global graph depth 为 -1，值得参考。Quartz 的实现用 `d3-force` 做布局，并通过 Pixi.js 渲染，支持标签、局部深度、hover focus、visited 节点等机制，可作为交互设计参考：[`Graph.tsx`](https://github.com/jackyzha0/quartz/blob/v4/quartz/components/Graph.tsx)、[`graph.inline.ts`](https://github.com/jackyzha0/quartz/blob/v4/quartz/components/scripts/graph.inline.ts)。

#### 1.4 索引与更新

Velo 现有架构里已经有：

- `workspaceStore.activeRoot`
- 文件树懒加载
- 工作区根 recursive `fs.watch`
- 当前文档 `documentStore.currentFilePath`
- Markdown parse / serialize 管线

建议新增独立索引层：

```txt
workspace root
  ↓ scan .md files
  ↓ parse links per file
  ↓ normalize targets
  ↓ build forwardLinks / backlinks / graph nodes / graph edges
  ↓ Sidebar Graph / Backlinks panel consume
```

建议 store：

```txt
src/stores/knowledgeGraph.ts
```

职责：

- 持有 `fileIndex`
- 持有 `linksBySource`
- 持有 `backlinksByTarget`
- 暴露：
  - `scanWorkspace(root)`
  - `refreshFile(path)`
  - `removeFile(path)`
  - `renamePathPrefix(oldPath, newPath)`
  - `globalGraph`
  - `localGraph(currentFilePath, depth)`

---

### 2. 与当前架构的结合点

| 位置 | 建议 |
|---|---|
| `workspaceStore.setActiveRoot` | 切 workspace 后触发图谱索引重建 |
| 工作区 `fs.watch` debounce flush | 文件变化后增量刷新对应 `.md` 文件 |
| `documentStore.save()` 成功后 | 当前文件刷新索引，保证图谱不等 fs.watch |
| `FileTree` rename / move / delete | 同步图谱 path prefix 或移除节点 |
| `Sidebar.vue` | 新增 Graph tab |
| `docs/ARCHITECTURE.md` | 若实现，需同步，因为这是新数据流 / Sidebar 功能 / 索引层 |

注意：Velo 当前架构中 `documentStore.content` 是编辑器文本唯一来源，但图谱是 workspace 级索引，不能只看当前文档内容。图谱 store 应独立于 editor state。

---

### 3. 关键设计问题

#### 3.1 Wikilink 解析：第三方还是自写

##### Wikilink 解析包现状（基于 `npm view`）

| 包 | 当前版本 | license | dist.unpackedSize | 最近发布日期 |
|---|---|---|---|---|
| [`remark-wiki-link`](https://github.com/landakram/remark-wiki-link) | `2.0.1` | MIT | 34.5 KB | 2023-10-10 |
| [`mdast-util-wiki-link`](https://github.com/landakram/mdast-util-wiki-link) | `0.1.2` | MIT | 29.5 KB | 2023-10-09 |
| [`micromark-extension-wiki-link`](https://github.com/landakram/micromark-extension-wiki-link) | `0.0.4` | MIT | — | 2023-09-18 |

⚠️ 维护现状：

- 这三个包自 **2023-10** 后无新版本发布。功能稳定，但活跃度低。
- `remark-wiki-link@2.0.1` 依赖 `mdast-util-wiki-link@^0.1.2` + `micromark-extension-wiki-link@^0.0.4`，且 devDeps 锁的是老版本 `unified@9`、`mdast-util-from-markdown@2`、`remark-parse@9`。Velo 当前依赖 `unified@^11.0.5` + `mdast-util-from-markdown@^2.0.3` + `remark-parse@^11.0.0`，理论上 `mdast-util-*` / `micromark-*` v0.x 包仍兼容 v2/v3 `unified` 生态，但需要实际跑一遍 round-trip 才能确认。
- 包版本仍处于 0.x：API 可能继续小幅变动。
- 这三个包都基于同一作者（`landakram`），是同一套方案的三层封装（micromark → mdast → remark）。

##### `remark-wiki-link` 能力

- 解析 `[[Wiki Links]]` → mdast `wikiLink` 节点。
- `data.alias` / `data.permalink` / `data.exists` / `data.hProperties.className` / `data.hProperties.href` 由配置驱动。
- 默认 `aliasDivider = ':'`；Obsidian 实际用 `|`，必须通过 `options.aliasDivider` 改（默认行为不兼容 Obsidian 语料）。
- 支持 `pageResolver` / `hrefTemplate` / `wikiLinkClassName` / `newClassName`。

##### `mdast-util-wiki-link` + `micromark-extension-wiki-link` 更底层

优点：可直接嵌入 Velo 现有 `mdast-util-*` 依赖矩阵。  
缺点：版本老、未主动维护；自定义 resolver / href 模板代码会比 remark 那一层多。

##### Quartz 自写正则路线（参考实现）

Quartz v4 的 Obsidian Flavored Markdown transformer 完全自写正则（不依赖 remark-wiki-link）：

```ts
/!?\[\[([^\[\]\|\#\\]+)?(#+[^\[\]\|\#\\]+)?(\\?\|[^\[\]\#]*)?\]\]/g
```

来源：[`ofm.ts`](https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts)。

正则拆解：

- `!?` 可选的 `!`（embed）
- `\[\[` `[[`
- 第一组 `([^\[\]\|\#\\]+)?` page name（不含 `[ ] | # \`）
- 第二组 `(#+[^\[\]\|\#\\]+)?` heading（`#` 开头）
- 第三组 `(\\?\|[^\[\]\#]*)?` alias（可选 `\` 转义的 `|` + 文本）
- `\]\]` 收尾

这套正则可作为 Velo MVP「索引层 extractor」的参考起点；后续若在编辑器内可视化 `[[...]]`，再视情况换成 remark / micromark extension，并按 CLAUDE.md 的「新增语法支持 checklist」走全流程（schema / markdownIO / syntax / tests）。

##### 建议

- **MVP**：自写轻量 extractor（参考 Quartz 正则 + 自写解析函数），只服务于 `knowledgeGraphStore` 索引层，不改 editor schema。
- **二期**：再视 round-trip 测试结果决定是否引入 `remark-wiki-link`，并强制把 `aliasDivider` 改为 `|` 对齐 Obsidian。

#### 3.2 路径解析是最大坑

Foam README 明确支持：graph visualization、backlinks panel、link rename sync、duplicate file names across directories、ambiguous wikilinks diagnostics、section links `[[resource#Section Title]]`、alias `[[wikilink|alias]]`。来源：[`Foam README`](https://github.com/foambubble/foam/blob/master/readme.md)；[`Foam LICENSE`](https://github.com/foambubble/foam/blob/master/LICENSE)（MIT）。

Velo 如果支持 `[[foo]]`，必须定义解析规则：

1. `[[foo]]` 指向 `foo.md`、当前目录下的 `foo.md`，还是 workspace 全局任意 `foo.md`？
2. 多个同名文件怎么办？选最近、标记 ambiguous，还是要求用户写 `[[dir/foo]]`？
3. 文件重命名后是否自动改链接？Obsidian / Foam 都有这类能力，但实现复杂。MVP 可先不自动重写，只刷新图谱。

建议规则：

- 标准 Markdown link：按当前文件目录相对解析（保持与 CommonMark 一致）。
- Wikilink：
  - 若含 `/`，按 workspace-relative path 解析。
  - 若不含 `/`，优先匹配 basename，Windows 下大小写不敏感。
  - 多匹配时标记 `ambiguous`，图谱可显示为特殊颜色，不自动猜。
- heading anchor：先只存 `edge.anchor`，不独立建 node。

#### 3.3 性能：不要每次渲染图谱都重新扫文件

建议索引策略：

| 场景 | 策略 |
|---|---|
| 打开 workspace | 后台扫描 `.md` 文件 |
| 文件保存 | 只解析当前文件 |
| fs.watch 发现变化 | debounce 后刷新受影响文件 |
| 文件删除 | 删除节点和相关边 |
| 文件重命名 / move | 先 path prefix 重写，再重新解析该文件 |
| 图谱打开 | 直接消费缓存，不扫盘 |

大 workspace 可进一步做：

- 扫描分批，避免卡 UI。
- 每个文件记录 `mtime` / `size` / `contentHash`。
- 索引持久化到 `appDataDir`，例如 `velo-knowledge-index.json`。
- 初期不必做全文 SQLite；先内存 + JSON cache 足够。

---

### 4. 图可视化依赖对比

> 下表「包大小」为 `npm view <pkg> dist.unpackedSize` 抓取的时间戳对应归档解压体积（开发用，运行时 + tree-shaking 后实际体积会大幅低于该值；评估时仅用于横向对比）。所有包 license 均 MIT，可直接引入 Velo（项目 license 见 `package.json`）。

| 包 | 当前版本 | license | dist.unpackedSize | 渲染后端 | 推荐度 |
|---|---|---|---|---|---|
| [`force-graph`](https://github.com/vasturiano/force-graph) | `1.51.4`（2026-04-16 更新） | MIT | 6.46 MB | HTML5 Canvas + `d3-force` | MVP 首选 |
| [`sigma`](https://github.com/jacomyal/sigma.js) | `3.0.3`（2026-06-09 更新） | MIT | 0.97 MB | WebGL | 二期推荐 |
| [`graphology`](https://github.com/graphology/graphology) | `0.26.0`（2025-01-26 更新） | MIT | 2.73 MB | — | 与 sigma 配套 |
| [`graphology-layout-forceatlas2`](https://github.com/graphology/graphology) | `0.10.1` | MIT | 78.8 KB | — | sigma 配套布局 |
| [`graphology-layout-noverlap`](https://github.com/graphology/graphology) | `0.4.2` | MIT | 26.9 KB | — | sigma 配套抗重叠 |
| [`cytoscape`](https://github.com/cytoscape/cytoscape.js) | `3.34.0` | MIT | 5.70 MB | Canvas / WebGL | 备选（图算法强） |
| [`@antv/g6`](https://github.com/antvis/G6) | `5.1.1` | MIT | 7.60 MB | Canvas / SVG / WebGL | 不建议 Velo MVP |
| [`d3-force`](https://github.com/d3/d3-force) | `3.0.0`（2023-07-28 更新） | ISC | — | — | 仅当自渲染时引入 |

#### 4.1 `force-graph`（MVP 首选）

- 维护活跃度：最近发布 `1.51.4`（2026-04）。
- 底层 `d3-force`（ISC），加上 `d3-array` / `d3-drag` / `d3-zoom` / `d3-scale*` / `d3-selection` / `d3-force-3d`（注意是 3D 版本，但是 2D 渲染核心也共享部分模块）。
- 优点：Canvas 性能好、API 简单（`new ForceGraph(el).graphData(...)` 风格），README 列出的样例覆盖 medium graph ~4k、large graph ~75k elements。
- 缺点：自带 3D 版本可分拆为 `3d-force-graph`，但 2D 版强制带 `d3-force-3d`，会增加打包体积；交互深度增加时比 `sigma` 工程化弱。
- Vue 集成：直接当作组件 mount 到 `ref<HTMLDivElement>`，onUnmounted 调 `.pauseAnimation()` + 解除引用即可。
- 适合：先做一个「能看、能点、能 hover 高亮」的 Obsidian 风格图。

#### 4.2 `sigma + graphology`（二期推荐）

- `sigma` 包仅 `0.97 MB` unzip + 依赖 `events` + `graphology-utils`，渲染走 WebGL。
- 配合 `graphology`（`0.26.0`，维护中）和 `graphology-layout-forceatlas2` / `graphology-layout-noverlap` 可获得稳定的力导向布局 + 防重叠。
- 优点：数据 / 渲染解耦（`graphology` 自带 layout / metrics / traversal / operators / communities 等算法包），后续要做中央性、群组、过滤、路径查询都顺手；WebGL 适合大图。
- 缺点：Vue 3 集成需要自己写薄包装；初版工作量比 `force-graph` 多。
- 适合：图谱作为长期核心功能时。

#### 4.3 `@antv/g6`（不建议 MVP）

- 包体积大，依赖链路深（`@antv/g` / `@antv/algorithm` / `@antv/component` / `@antv/graphlib` / `@antv/hierarchy` / `@antv/layout` / `bubblesets-js`）。
- 视觉和交互默认偏「企业图分析」，与 Obsidian 风格 PKM 不匹配。
- 适合：未来真要做「图分析面板 / 中央性 / 群组聚类 / 复杂筛选」时再考虑；当前阶段引入会抬高 Velo 的包体和心智负担。

#### 4.4 `cytoscape`（备选）

- `3.34.0` 维护活跃，文档 / 案例齐全。
- 图算法支持非常强（布局、metrics、selector、event、COSE/BFS 等）。
- 缺点：默认交互没有 Obsidian 那种轻量力导向的质感，要手动挑 layout（`cose` / `cose-bilkent` / `cola` / `dagre` 等）。
- 适合：希望图谱功能深（路径分析 / 子图选择）而不是「漂漂亮亮地漂」。

#### 4.5 `d3-force`（仅自渲染时用）

- ISC license、版本 `3.0.0`（2023-07 已停止主动更新，但 API 稳定）。
- Quartz 的图谱实现是 `d3-force + pixi.js` 的自渲染路线，可参考但不适合 Velo MVP。
- 不建议 Velo MVP 直接画，除非想做完全自定义渲染层。

---

### 5. 可参考开源项目

#### 5.1 Foam

Repo：[`foambubble/foam`](https://github.com/foambubble/foam)

重点参考：

- Graph Visualization
- Backlinks Panel
- Link Autocompletion
- Sync links on file rename
- Placeholder / orphan panel
- ambiguous wikilink 处理
- section link：`[[resource#Section Title]]`
- alias：`[[wikilink|alias]]`

Foam 是 VS Code 扩展，但它对「本地 Markdown workspace 如何维护知识关系」非常贴近 Velo。License MIT。

#### 5.2 Quartz v4

Repo：[`jackyzha0/quartz`](https://github.com/jackyzha0/quartz)

重点参考：

- Obsidian Flavored Markdown 解析：[`ofm.ts`](https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts)
- local graph / global graph 配置：[`Graph.tsx`](https://github.com/jackyzha0/quartz/blob/v4/quartz/components/Graph.tsx)
- d3-force + Pixi 渲染图谱：[`graph.inline.ts`](https://github.com/jackyzha0/quartz/blob/v4/quartz/components/scripts/graph.inline.ts)

Quartz 是静态站点生成器，不是编辑器，但它的图谱实现简洁，特别适合作为 Velo 的 UI / 参数设计参考。License MIT：[`LICENSE.txt`](https://github.com/jackyzha0/quartz/blob/v4/LICENSE.txt)。

#### 5.3 Logseq

Repo：[`logseq/logseq`](https://github.com/logseq/logseq)

Logseq 是 privacy-first、open-source knowledge management platform，支持 Markdown / Org-mode，强调本地知识图谱、插件、任务、PDF annotation 等。README 提到 DB graphs / graph export / SQLite DB backups 等方向：[`README`](https://github.com/logseq/logseq/blob/master/README.md)。

License AGPL-3.0：[`LICENSE.md`](https://github.com/logseq/logseq/blob/master/LICENSE.md)。适合作产品形态参考，不建议直接复用代码，AGPL 传染性对 Velo 项目不一定合适。

#### 5.4 Dendron

Repo：[`dendronhq/dendron`](https://github.com/dendronhq/dendron)

Dendron 是 local-first、markdown-based note-taking tool，README 明确说当前 active development has ceased / maintenance only；它支持 backlinks、navigation、graph view、refactor links 等：[`README`](https://github.com/dendronhq/dendron/blob/master/README.md)。

适合参考「大知识库 / 层级笔记 / refactor」理念，但不建议作为依赖或深度复用目标。

---

### 5.5 Velo 现有可借鉴的代码段

> **待复核**：本节基于 `docs/ARCHITECTURE.md`、仓库内 `Sidebar.vue` / `workspace.ts` / `persistence.ts` / `outlineFilter.ts` 等可见信息整理；具体行号需在实现期再次 grep 确认。

- `Sidebar.vue` 的 `v-if` 互斥渲染 + tab 状态由 `workspaceStore.sidebarTab` 管理：图谱 tab 应作为第三个 tab 走同套模式（不要破坏现有 2-tab 持久化约定）。
- `workspaceStore.renamePathPrefix`：已经能处理「跨目录拖拽 move 后，旧路径在工作区记忆里的 prefix 重写」。知识图谱 store 必须复用同款约定，不要自起一套 path 缓存；否则文件树 / 工作区 / 图谱三套 state 会脱节。
- `persistence.ts`：已经形成 `appDataDir/velo-{name}.json` + `version` 字段 + load/save 配对函数 + 失败降级不阻塞 UI 的范式。**如果**图谱要落盘持久化，沿用这套约定（命名 `velo-knowledge-index.json`），不要造新形态。
- `EditorOutline.vue`（在 `Sidebar.vue` 内 mount）有 scroll-spy / 渲染策略的现成模式；新增图谱 / 反链面板如需复用其 `outlineStore` 的派生范式，可照抄「computed visible + filter query」结构。
- `documentStore.save()` 后 fs.watch 会再触发一次 `checkExternalChange`，图谱 store 应基于「save 成功后再主动调一次 `refreshFile(currentFilePath)`」补足延迟，不要依赖 fs.watch 的延迟路径。
- 现有「Ctrl+P 工作区模糊打开」（`workspaceStore` / `outlineFilter` 同款 fuzzy 算法，详见 `src/utils/outlineFilter.ts`）如果将来合并到同一 sidebar tab 设计，可以共用同一套 fuzzyMatch。**待复核**：是否真有 `quickOpenIndex.ts` 索引文件，目前仓库中未定位到，存在 outlineFilter 但未必服务 Ctrl+P。

---

### 6. 推荐技术路线

#### 6.1 MVP：反向链接 + 图谱基础

建议新增：

```txt
src/stores/knowledgeGraph.ts
src/lib/knowledge/scanWorkspace.ts
src/lib/knowledge/extractLinks.ts
src/lib/knowledge/resolveLinks.ts
src/components/Sidebar/KnowledgeGraph.vue
src/components/Sidebar/BacklinksPanel.vue  // 可选，或先合在 Graph tab
```

功能：

- 扫描 workspace 下 `.md`
- 提取 Markdown links + Wikilinks
- 生成 backlinks
- Sidebar 新增「图谱」tab
- 图谱显示：
  - 当前文件局部图 depth=1
  - 切换全局图
  - 点击节点打开文件
  - hover 高亮邻居
  - 搜索节点
  - 过滤 missing / isolated

依赖建议：

```bash
npm install force-graph
```

如果想更长期稳健：

```bash
npm install sigma graphology graphology-layout-forceatlas2
```

#### 6.2 二期：Obsidian 风格 Wikilink 正式编辑支持

这就不只是图谱了，会触发 CLAUDE.md 的「新增语法支持 checklist」。

需要考虑：

- schema 新增 `wiki_link` mark 或 inline atom node？
- markdownIO from / to 双向
- syntax/inline 实时输入 `[[...]]` 转换
- link click / open behavior
- missing link click 创建文件
- rename 文件后是否批量更新 links
- tests：happy path + alias + heading + missing + round-trip

这里要谨慎，因为 Velo 当前标准链接已有 `linkClickPlugin`，Wikilink 应尽量复用「链接源码编辑态」语义，避免又做一套交互。

#### 6.3 三期：性能和索引持久化

适合用户 workspace 达到几千文件后做：

- `velo-knowledge-index.json`
- 文件 `mtime` / `size` / `hash`
- 扫描进度 UI
- worker 化解析，避免 UI 卡顿
- orphan / placeholder 面板
- ambiguous wikilink diagnostics
- tag graph
- link rename sync

#### 6.4 关键复用与新增点（与 Velo 现有架构对齐）

| 行为 | 复用 / 改造 | 新增 |
|---|---|---|
| 切换 workspace 触发扫描 | `workspaceStore.setActiveRoot` | `knowledgeGraphStore.scanWorkspace(root)` |
| 当前文件保存后立即刷新 | `documentStore.save()` 成功后 | `knowledgeGraphStore.refreshFile(path)` |
| 文件树 move 后路径重写 | `workspaceStore.renamePathPrefix` 已存在 | `knowledgeGraphStore.renamePathPrefix` 同款实现 |
| 工作区根 fs.watch 脏目录 | `workspaceStore` / `App.vue` 的 120ms debounce | 共享给图谱 store，让 `loadDirChildren` + 图谱增量刷新同 microtask |
| 持久化约定 | `persistence.ts` 已有的 `velo-*.json` + `version` + 失败降级 | 沿用相同范式新增 `velo-knowledge-index.json`（如果选择持久化） |
| Sidebar tab 容器 | `Sidebar.vue` 已有 2 tab（文件 / 大纲），`v-if` 互斥 | 扩成 3 tab，新增 `KnowledgeGraph` 组件 + `workspaceStore.sidebarTab` 增 `'graph'` |
| Link click 源码编辑态 | `linkClickPlugin` + `linkEditEscapeKeymap` | Wikilink 二期尽量复用同套源码编辑语义 |
| search fuzzy 算法 | `src/utils/outlineFilter.ts` 子序列匹配 | 图谱 / 反链面板的节点搜索直接复用 |

---

### 7. 建议排期

如果排进 ROADMAP，建议拆为：

1. `knowledgeGraphStore` + backlink panel。  
   这是图谱的地基，也最容易验证价值。
2. 图渲染选 `force-graph` 起步。  
   对 Velo 当前体量最合适，Canvas、交互够用、接入快。后续如果性能或功能不够，再换 `sigma + graphology`，因为数据层已经独立，替换渲染层代价可控。
3. Wikilink 解析先自写 extractor，不马上改 markdownIO。  
   先让 `[[Note]]` 能参与图谱；等确定要在编辑器中视觉化 / 可点击 / round-trip 后，再正式纳入 Markdown 语法管线。
4. 图谱 UI 放 Sidebar 第三个 tab。  
   和现有大纲 / 文件树结构一致，不打断编辑器主区域。全局图以后可加按钮弹出大图模式。

---

### 8. 风险点

- 路径解析 / 同名文件歧义是最大复杂度，建议一开始就把 ambiguous 状态建模出来。
- Wikilink 正式语法支持会牵涉 schema、markdownIO、syntax、link click、测试，不建议和图谱 MVP 混在一个 PR。
- 大 workspace 性能不要用「每次打开图谱全量读盘」；必须有 store 缓存和增量刷新。
- license：Foam / Quartz / graph libs 多数 MIT 可参考；Logseq 是 AGPL，只建议看设计，不建议复制实现。
- 工作区根 fs.watch 与图谱增量刷新要协调：单 recursive 句柄已有 150ms (Tauri) + 120ms (前端) 两级 debounce，必须保证图谱 store 复用同一事件源，否则会出现「文件树更新了但图谱没跟上 / 反之」的双源脱节。
- ROADMAP v0.5.6 与 v0.5.5 资产面板（`fs:allow-copy`）在 capability 依赖上有交集；新增图谱依赖前先确认 capability 没漏。

---

### 9. 验证计划（实现阶段执行）

> 这是「实现时」要走的最小验证集，不是研究阶段的任务。

- **包兼容**：新建 `/tmp/probe` 项目临时装 `remark-wiki-link@2.0.1` + Velo 同版本 `unified/remark-parse/mdast-util-from-markdown`，跑一个 `[[Note]]` 输入 → mdast `wikiLink` → `toMarkdown` 反向 round-trip，确认无报错再决定采纳。
- **图渲染 smoke**：在 `force-graph` 一个 200 节点 demo 上确认 Vite build 成功、首屏 < 500ms、点击节点 → emit 事件可被 Vue 端订阅；再换 `sigma + graphology` 跑同 demo。
- **大 workspace 性能**：构造 1000 / 5000 / 10000 个 `.md` 的合成 workspace（脚本生成，不入库），测首扫时间 + 增量刷新（修改 / 删除 / 重命名 1 个文件后图谱收敛时间）。
- **Wikilink round-trip**：`markdownIO` 添加 wikilink 节点后必须 round-trip：`[[Note]]` 写入文件 → 重新加载 → 输出仍是 `[[Note]]`；`[[Note|Alias]]`、`[[Note#Heading]]`、`[[a/b]]`、`![[img.png]]` 各自一组用例。
- **路径歧义**：合成 workspace 内放两个 `note.md` 在不同目录，写 `[[note]]` 验证：当前是 ambiguous，编辑器标红 / tooltip 「多个匹配」，不自动猜。
- **rename 联动**：重命名一个被引用的文件，验证所有指向它的 source 文本保持 `[[Old]]`（MVP 不重写）；图谱 store 节点路径同步更新；用户主动「refactor 全部引用」时再批量重写（FOAM 行为，可作为后期 feature）。

---

### 10. 待后续 deep research 验证的问题

- `remark-wiki-link` / `mdast-util-wiki-link` 与当前 Velo unified / remark 版本的实际兼容性 round-trip 是否通过（实现前必须跑过；本调研不替代）。
- `force-graph` 在 Tauri WebView2 下的大图性能和内存表现（无现成数据；需在实现期跑 demo 采样）。
- `sigma + graphology` 在 Vue 3 中的最小封装方式与包体影响（待 plan 阶段对照示例代码）。
- Foam 对 ambiguous wikilinks / rename sync 的具体实现细节是否可借鉴到 Velo（需进一步读 Foam 源码，本调研仅基于 README 描述）。
- 是否需要把「反向链接」从 ROADMAP 未规划功能提前并入 v0.5.6 双链（产品决策，需用户拍板）。
- 是否合并到 Ctrl+P 工作区模糊打开（共用一个 `.md` 索引器，避免三套独立枚举）。
- Velo 当前是否真有 `quickOpenIndex.ts` 等共享索引文件（在本机 WebSearch 不可用条件下，仓库 grep 暂未定位到明确文件；实现前需在源码中再确认一遍）。

---

### 11. 定稿时要去哪

- 重大取舍（如渲染库选定、wikilink parser 路线、是否引入 `remark-wiki-link`、index 所有权 / 持久化策略）→ 进 `DECISIONS.md` ADR。
- 最终架构（数据流 / 索引层 / Sidebar 改造 / wikilink 渲染）→ 进 `ARCHITECTURE.md`。
- ROADMAP 同步：v0.5.6 子条目按实际落地情况勾选 / 删除 / 调整；新版本条目按需要追加。
- 本文档随对应功能实现后删除。

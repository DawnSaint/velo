# 资产面板 —— 工程级未引用扫描调研

> **性质**：pre-implementation 设计研究，候选方案尚未拍板。后续若决定实现，重大取舍进 `DECISIONS.md` ADR，最终架构同步 `ARCHITECTURE.md`。
> **缘起**：v0.6.4 资产面板的「未被引用图片文件」当前只对比 assets/ 目录下的文件与**当前文档** `markdown` 里的 image src 列表，导致被其他工作区文档引用的图片在本 markdown 下被显示为孤儿，易引发误删。
> **对应 ROADMAP**：「资产面板工程级未引用」章节。
> **调研日期**：2026-07-08。
> **当前状态**：初版，与知识图谱索引层（`docs/Research/knowledge-graph.md` 第 1.4 / 3.3 / 6 节）共用数据层讨论。

---

## 1. 问题

当前 v0.6.4 (`src/components/Sidebar/AssetPanel.vue`) 扫描流程：

1. `scanMarkdownImages(props.modelValue)` → `referencedAbsPaths = Set<本 markdown 引用的磁盘绝对路径>`。
2. `scanOrphans()` → `readDir(docDir/assets)` 减去 `referencedAbsPaths` → 渲染成「未引用」组。

**缺陷**：`referencedAbsPaths` 只看当前 markdown。打开 A.md 时会把 B/C/D 中引用的资产标灰，用户一看 56/62 标灰 → 可能触发「清理孤儿」→ 实际上其他文档还在引用 → 破坏其他文件的图片。

**误解**：从"当前文档没引用过" 升级到 "整个工程没被任何 markdown 引用过"。

**工程级未引用的完整定义**：

| 状态 | 语义 |
|---|---|
| 本 markdown 引用 | 当前 `props.modelValue` 里有 → 正常条目，可点击定位 |
| 本 markdown 未引用 但 其他 markdown 引用 | 跨文档引用，标灰 + 标签「在 N 个其他文件引用」 |
| 工程级未引用 | 没有任何工作区 markdown 引用 → 真正孤儿候选 |

---

## 2. 「不是问题」的候选方案

### ❌ 方案 1：切文档时扫全工程

每次 `filePath` 变化时一次性 `readDir(workspacRoot) + 读每个 .md 的 image src`。

**拒绝理由**：
- 打开切文档即卡顿：1000 个 .md × 几 KB/文件 → 秒级阻塞。
- 重复劳动：用户经常反复切文档，每次扫是浪费。
- 与「工程级缓存 + 增量」相比没优点。

### ❌ 方案 2：文档级 VNode + 引用计数

让每个 asset absPath 维护「总引用数」，类似 `BacklinksPanel`。

**接受条件**：前面一个缓存层方案已经天然持有这个信息（`Map<asset, Set<md>>`），不必另起炉灶；`size()` 就是总引用数。本调研不单独立项。

---

## 3. 「推荐」的工程级索引缓存

### 3.1 缓存数据模型

```ts
// 模块级单例，整个 shell 生命周期内复用
// key: 资产文件磁盘绝对路径（forward-slash 归一化）
// value: 引用过该资产的 markdown 文件绝对路径集合
const assetRefCount = new Map<string, Set<string>>()
```

### 3.2 缓存入口

| 触发场景 | 动作 |
|---|---|
| 打开 workspace 一次 | 后台全扫（spawnIdle/分批）；持久化 JSON 反序列化（可选） |
| 当前文档保存成功 | `refreshFile(currentFilePath)` → 重算该 md 的所有 image src → 更新引用 |
| 当前文档切换 | `refreshFile(newPath)` + 脏文件暂存 |
| fs.watch 发现 .md 变化 | debounce 后 `refreshFile(path)`（当前未保存的脏内容用 fs.readFile 取盘上版本，但更好的方式是跳过，等保存时再算） |
| FileTree 文件重命名 / move | `renamePathPrefix(oldPrefix, newPrefix)` |
| FileTree 文件删除 | `removeFile(path)` → 从所有 asset 引用集合里删掉该 md |

### 3.3 模块归属

推荐新增 `src/stores/assetRefGraph.ts`（不要直接挂在 v0.6.4 的 `AssetPanel.vue` 组件内），原因：

- **单例缓存**：组件 ref 随销毁丢失，`watch` 重扫开销又大。
- **事件与文件树 / workspace 多绑定**：模块级 store 能订阅 App.vue 已有的 `fs.watch` 信号。
- **知识图谱基础设施复用**：0.5.x 之后要做 `[[wikilink]]` 时，`knowledge-graph.md 6.1` 的 `GraphNode / GraphEdge` 设计天然覆盖"文件-引用"关系。当前 v0.6.x 阶段只索引 image，保留 `GraphNode` 字段即可后续合并。

### 3.4 扫描开销

- **首扫**：1000 个 .md × 用 `String.match` 拿 image src(O(n)) → 几十 ms 内完成，比 IPC 延迟小。
- **增量**：单文件保存 / fs.watch 一个 .md → 单 regex pass → <1ms。
- **读文件**：从 `documentStore.content` 拿（已经是内存字符串）而不是 readFile 重复读盘，与现有资源一致。

---

## 4. Rust vs JS —— 工程级扫描选型

**结论：JS 更合适。**

| 维度 | JS | Rust |
|---|---|---|
| 解析 image src | `String.match` 几十 KB/ms，足够 | `regex` crate 更快，但瓶颈不在解析 |
| Tauri IPC | `invoke` 单次几 ms,可忽略 | 省去 invoke,但 IPC 是小头 |
| 大 workspace 并发 | Node 主线程足够,Worker 按需 | `rayon` 真并行,但工程 <10K .ms 文件用不上 |
| 字符串 IPC 边界 | `string` + serde(默认),零拷贝 | 仍走 serde_json 或 IPC frame,无优势 |
| 代码量 | 单 store ~200 行 TS | command + serde + TS 三份改动 ~600 行 |
| 与现有索引层共享 | 复用 `documentStore.content`、`markdownIO` | 独立维护一份文件内容 + 解析规则 |

Rust 仅在真正大文件(>1MB)/工程 10K+ .ms 文件/要求亚 ms 增量响应时考虑。当前 Velo 体量 JS 完全够，**未来**若做持久化全工程全文索引（+ SQLite）再迁 Rust。

---

## 5. 与知识图谱索引层合并

`knowledge-graph.md` 第 1.4（索引与更新）/ 3.3（性能）/ 6.4（复用与新增点）已经规划了扫全工程 + 事件驱动 + 模块级缓存维护的索引层：

| 知识图谱章节 | 资产索引对接 |
|---|---|
| §1.4 索引更新：workspace scan / per-file refresh / fs.watch | 资产索引相同事件 -> 同一份代码 |
| §3.3 性能：打开 workspace 扫一次 + 增量 + 持久化 | 资产扫描复用同份机制 |
| §6.4 表格「切换 workspace」「fs.watch」「保存后刷新」 | 资产同触发路径 |

**建议**：v0.6.x 阶段先用 TS 模块 store 实现资产引用图（`assetRefGraph`），作为「全工程索引」的一个 MVP 输出；0.5.x 做 Wikilink 时再合并成完整的 `KnowledgeGraphStore`。这样双链设计时不用另建一套缓存基础设施。

**当前(0.6.x)阶段不合并的原因**：知识图谱更复杂（[[wikilink]] / heading anchor / alias），工作量远大于单一 image src 索引；资产工程级未引用是独立可交付的小功能，先做小步快跑。

---

## 6. 实施路线

### 6.1 MVP：模块级缓存 + 本仓库增量刷新

**新增**：

```txt
src/stores/assetRefGraph.ts   // 单例 store：引用 Map + refreshFile / rename / remove
```

**改动**：

- `documentStore.save()` 成功后调 `assetRefGraph.refreshFile(path)`。
- `workspaceStore.setActiveRoot` 重建缓存（初始为空 + 前 3 个 .md 文件预热即可）。
- `FileTree` 的 rename / move / delete 事件 → `assetRefGraph.renamePathPrefix` / `removeFile`。
- `App.vue` `fs.watch` debounce flush → `assetRefGraph.refreshFile(path)`。

`assetRefGraph` 模块 API：

```ts
// 读
isReferenced(absPath: string): boolean
referencingFiles(absPath: string): string[]  // 引用过该资产的 md 文件列表
isReferencedByCurrentFile(absPath: string, currentFilePath: string | null): boolean

// 写（事件驱动）
refreshFile(mdAbsPath: string, markdown?: string): void  // 默认从 documentStore.content 读
renamePathPrefix(oldPrefix: string, newPrefix: string): void
removeFile(mdAbsPath: string): void
clear(): void  // workspace 切换时
```

### 6.2 UI：三维度分组

- AssetPanel 新增引用来源维度。
- 「未引用」分组拆成：
  - 「其他文件引用」(`otherRefs`)：本 md 未引用 但 len(referencingFiles) > 0 → 灰色 + 标签「N 个文件引用」。
  - `trulyOrphaned`：无任何 md 引用 → 保持现有标灰孤儿样式。

交互调整：
- 其他文件引用条目点击 → 提示"其他文件引用，不在本 markdown 定位"，或新开 tooltip 列引用文件列表。
- 真正孤儿条目加「删除」右键入口（按 ROADMAP 资产面板 v0.6.4 剩余 `fs:allow-copy` capability）。

### 6.3 二期：跨工程缓存持久化

可选（仅当 workspace 文件数 >500 首扫 >500ms 时）：

- 导出 `velo-asset-refs.json` 到 `appDataDir`。
- 每条 asset 记录 `mtime + size + hash`，增量更新。

**当前阶段不做**：Velo 目标用户工程体量暂小；首扫 JS 轻松应付。

---

## 7. 风险点

- **缓存失效**：外部进程改 .md（git checkout 等）通过 fs.watch 刷新，延迟 ≤ 150+120 ms debounce，可接受。
- **文件名大小写**：Windows 路径大小写不敏感，引用计算需 `path.toLowerCase()` 归一（所有读写 assetRefGraph 都归一）。
- **本 markdown 脏内容未保存**：`documentStore.save()` 后才刷新，编辑态中途引用不计入（与知识图谱章节 3.3 同款取舍）。
- **`markdown` 参数可选**：默认从 `documentStore.content` 取；若 store 还没，fallback readFile（仅当 fs.watch 触发外部进程改且本 md 未打开时）。

---

## 8. 当前进度对应 ROADMAP

### ROADMAP 待完成项

- 输出本调研 ✅（本节 9 完成）
- `assetRefGraph` 模块实现（待 0.5.x 双链之前）
- UI 三维度分组（同上）

---

## 9. 调研落点

- 取舍记录进 `docs/DECISIONS.md` ADR（仅当决定实施且 rust/TS 选型有转折时；当前选 TS 直接记本节 4 即可，不必特立 ADR）。
- 实施完成时本节随对应 ROADMAP 条目勾选同步删除。
- 架构文档 `docs/architecture/editor.md` / 新 `docs/architecture/asset-ref-graph.md`（等资产索引 store 落地后再写）。

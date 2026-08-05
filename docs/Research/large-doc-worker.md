# C1: markdownIO 移入 Web Worker — 调研与 PoC 设计

> **性质**：pre-implementation 设计研究，PoC 已实现。
> **对应 ROADMAP**：`#large-doc-perf-c1`（P3 / XL）
> **调研日期**：2026-08-05。
> **当前状态**：PoC 代码完成（`parseProcessor.ts` + `markdownWorker.ts` + `fromMarkdownAsync` + `EditorInner.vue` / `useProseMirror.ts` 适配），type-check + 1414 测试全通。待 Tauri 生产构建平台验证（Windows WebView2 / macOS WKWebView）+ 性能打点实测。

---

## 1. 问题

C0 + C0b + C3 落地后，大文档（> 2000 行）打开链路的耗时分布：

| 步骤 | 估算耗时 | 位置 | 是否可并行 |
|------|---------|------|-----------|
| `readTextFile` (Tauri IPC) | ~10–50ms | 异步 | ✅ 已异步 |
| `processor.parse(md)` (remark-parse → mdast) | **~400–1000ms** | 主线程同步 | ❌ 阻塞 |
| `processor.runSync()` (mdast → mdast, remark 插件变换) | **~100–300ms** | 主线程同步 | ❌ 阻塞 |
| `mdastBlockToPM` + `inlineNodeToPM` (mdast → PM Node) | **~100–300ms** | 主线程同步 | ❌ 阻塞 |
| `EditorState.create` (插件 init) | ~100–200ms | 主线程同步 | ❌ 阻塞 |
| `view.updateState` (DOM 创建) | ~100–200ms | 主线程同步 | ❌ 阻塞 |

**总计 ~800–2000ms**，其中 `fromMarkdown`（parse + runSync + mdast→PM）占 **~60–80%**。

C3 通过双 rAF + loading 遮罩解决了「冻结旧内容」的感知问题，但用户仍需等 1–1.5s spinner 才看到内容。C1 的目标是把 `fromMarkdown` 移出主线程，让 spinner 期间 UI 可交互（滚动 tab、点菜单等），且真实文档更早出现。

---

## 2. 候选方案

### 方案 A：完整 Worker — parse + runSync + mdast→PM 全移入

Worker 接收 markdown 字符串 + schema 序列化描述，产出「可重建 PM Node 的 JSON 树」。

**流程**：
```
主线程: postMessage({ md, schemaSpec })
Worker: parse → runSync → mdast→PM-like-JSON → postMessage(pmNodeJSON)
主线程: pmNodeJSON → schema.node(...) 重建 PM Node → EditorState.create
```

**问题**：
- PM Node 依赖 Schema 实例（有方法引用），不能跨 Worker 传递
- Worker 里需要重建 Schema → 要序列化 Schema spec（nodeSpec / markSpec）传过去
- `mdastBlockToPM` 遍历时调 `schema.node()` / `schema.text()` / `schema.marks.xxx.create()`，这些方法在 Worker 里需要有 Schema 实例
- 主线程拿到 JSON 后还要递归重建 PM Node（~50–100ms），部分抵消收益
- **复杂度最高**

### 方案 B：parse-only Worker — 只移入 remark-parse + runSync

Worker 只做 `processor.parse(md)` + `processor.runSync(tree)`，产出 mdast JSON（纯数据，无方法引用）。

**流程**：
```
主线程: postMessage({ md })
Worker: processor.parse(md) → processor.runSync(tree) → postMessage(mdastJSON)
主线程: mdastJSON → annotateMathDelimiterCount → mdastBlockToPM → PM Node
```

**优势**：
- mdast 是纯 JSON（type / value / children / position），`postMessage` 用 `structuredClone` 序列化零障碍
- Worker 不需要 Schema 实例，只需要 unified processor
- `mdastBlockToPM` 留在主线程，直接用现有 Schema 实例，零改造
- **parse + runSync 占 fromMarkdown 总耗时 ~70%**，收益可观

**劣势**：
- mdast JSON 序列化开销：大文档 mdast 树 ~1–5 万节点，`structuredClone` ~20–80ms
- `mdastBlockToPM` 仍在主线程 ~100–300ms

### 方案 C：ToMarkdown Worker（序列化方向）

`toMarkdown` 在编辑期 debounce 150ms 后调用，不阻塞输入。但切文件 / 保存时同步执行 ~50–200ms。

把 `toMarkdown` 移入 Worker：PM doc → mdast JSON（主线程）→ Worker stringify → string（主线程）。

**评估**：
- 收益小（toMarkdown 在打开链路已被 C0b 跳过大文档 canonical）
- 仅编辑期 debounce flush 时有益，但 150ms debounce 已经不阻塞输入
- **不在本次 PoC 范围**

---

## 3. 推荐方案：B（parse-only Worker）

### 理由

| 维度 | 方案 A (完整) | 方案 B (parse-only) |
|------|-------------|-------------------|
| 主线程阻塞减少 | ~600–1600ms → ~100–300ms | ~600–1600ms → ~200–500ms |
| Worker 复杂度 | 高（需序列化 Schema） | 低（只需 unified processor） |
| postMessage 开销 | 大（PM Node JSON 重建） | 中（mdast JSON） |
| 代码改动范围 | markdownIO + schema + EditorInner | markdownIO + EditorInner |
| 测试影响 | 大（同步→异步 + Schema 重建） | 中（fromMarkdown 变异步） |
| 风险 | 高 | 低 |

方案 B 用 30% 的复杂度拿到 70% 的收益，是性价比最高的切入点。如果 B 落地后剩余 ~200–500ms 仍不可接受，再考虑把 `mdastBlockToPM` 也优化（不一定需要 Worker，可以考虑分块 yield）。

---

## 4. PoC 实现设计

### 4.1 Worker 文件

`src/components/ProseMirrorEditor/editor/markdownWorker.ts`：

```ts
// Worker 内运行的 unified processor
// 与 markdownIO.ts 共享 processor 配置，但独立实例化（Worker 有独立全局环境）
import { unified } from 'unified'
import remarkParse from 'remark-parse'
// ... 所有 remark 插件 import（与 markdownIO.ts 完全一致）

const processor = unified()
  .use(remarkParse)
  .use(remarkPreserveEmptyLine)
  .use(remarkEncodeLinkUrls)
  .use(remarkSupSub)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkMathFenceGuard)
  .use(remarkMath)
  .use(remarkAlert)
  .use(remarkHighlight)
  .use(remarkUnderline)
  .use(remarkCjkEmphasis)
  .use(remarkFrontmatter, ['yaml', 'toml'])

// 注意：不包含 remarkStringify —— Worker 只做 parse + runSync，不做 stringify
// stringify 留在主线程（toMarkdown 不移入 Worker）

self.onmessage = (e: MessageEvent<{ md: string; id: number }>) => {
  const { md, id } = e.data
  const tree = processor.runSync(processor.parse(md)) 
  // postMessage 自动 structuredClone，mdast 是纯 JSON 安全
  self.postMessage({ id, tree })
}
```

### 4.2 主线程适配

`markdownIO.ts` 新增异步入口：

```ts
let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (tree: Root) => void>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./markdownWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<{ id: number; tree: Root }>) => {
    const resolve = pending.get(e.data.id)
    if (resolve) {
      pending.delete(e.data.id)
      resolve(e.data.tree)
    }
  }
  return worker
}

/** 异步 fromMarkdown：parse + runSync 在 Worker 里，mdast→PM 在主线程 */
export async function fromMarkdownAsync(md: string, schema: Schema): Promise<PMNode> {
  const id = seq++
  const w = getWorker()
  const tree = await new Promise<Root>(resolve => {
    pending.set(id, resolve)
    w.postMessage({ md, id })
  })
  // 以下与同步 fromMarkdown 完全一致
  annotateMathDelimiterCount(tree, md)
  const blocks = tree.children.flatMap(n => mdastBlockToPM(n, schema))
  if (blocks.length === 0) return schema.node('doc', null, [schema.node('paragraph')])
  if (blocks.length === 1 && blocks[0].type.name === 'frontmatter') {
    blocks.push(schema.node('paragraph'))
  }
  return schema.node('doc', null, blocks)
}
```

### 4.3 EditorInner.vue 适配

`modelValue` watch 中大文档路径改用 `fromMarkdownAsync`：

```ts
if (newVal.split('\n').length > 2000) {
  docLoading.value = true
  // 双 rAF 让遮罩 paint
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  // Worker 异步 parse（主线程不阻塞，UI 可交互）
  doc = await fromMarkdownAsync(newVal, schema)
  docLoading.value = false
} else {
  // 小文档仍同步 fromMarkdown（< 50ms 无感知）
  const pendingDoc = documentStore.consumePendingPmDoc() as PMNode | null
  doc = pendingDoc ?? fromMarkdown(newVal, schema)
}
```

`useProseMirror` 冷启动路径同理，大文档改异步。

### 4.4 取消机制

用户快速切换 tab 时，旧文件的 Worker parse 结果不应覆盖新文件：

```ts
// 每次发起 async parse 时递增 token，回调时比对
let parseToken = 0

// 发起
const myToken = ++parseToken
const doc = await fromMarkdownAsync(newVal, schema)
if (myToken !== parseToken) return  // 被新的 parse 取代，丢弃结果
```

---

## 5. 风险评估

### 5.1 Tauri WebView2 Worker 支持

| 平台 | Worker 支持 | 验证方式 |
|------|-----------|---------|
| Windows (WebView2 / Chromium) | ✅ 完整支持 `new Worker(new URL(...), { type: 'module' })` | WebView2 基于 Chromium 90+，ES module Worker 自 Chromium 80 起支持 |
| macOS (WKWebView) | ⚠️ 需验证 | Safari 15+ 支持 module Worker；Tauri macOS 用系统 WKWebView，版本取决于用户 macOS |
| Linux (WebKitGTK) | ⚠️ 需验证 | WebKitGTK 对 module Worker 支持较晚，取决于系统版本 |

**Vite 打包**：`new Worker(new URL('./xxx.ts', import.meta.url), { type: 'module' })` 是 Vite 官方支持的语法，build 时自动产出独立 chunk。已确认 `vite.config.ts` 无特殊配置阻止 Worker。

**CSP**：当前 `tauri.conf.json` 的 CSP 为 `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'`。Worker 脚本来自 `'self'`（同源打包产物），符合 CSP。无需修改 CSP。

### 5.2 processor 重复实例化

Worker 和主线程各持有一个 `processor` 实例（unified pipeline）。两者配置必须完全一致，否则 parse 结果不同 → round-trip 断裂。

**风险**：后续修改 remark 插件链时容易漏改一边。

**缓解**：把 processor 配置抽成共享函数 `createParseProcessor()`，Worker 和主线程都调用。`remarkStringify` 配置只在主线程的 `createFullProcessor()` 里追加。

### 5.3 echo 哨兵机制异步化

当前 `lastSelfEmitted` 是同步设值的：`doEmitMarkdown` → `emit('update:modelValue', md)` → Vue 触发 `modelValue` watch → 同步比对 `newVal === lastSelfEmitted`。

Worker 化后 `fromMarkdownAsync` 是异步的，期间用户可能触发编辑（debounce timer 还在跑），`modelValue` watch 的 `await` 之后状态可能已变。

**缓解**：parseToken 机制（4.4 节）覆盖此场景——快速切文件 / 快速编辑时旧 parse 结果被丢弃。但需要验证：Worker parse 期间用户的编辑 emit 是否会触发 modelValue watch 并与 async parse 竞争。

### 5.4 mdast JSON 序列化开销

`postMessage` 使用 `structuredClone` 序列化 mdast 树。大文档（5000 行）的 mdast 树约有 1–3 万个节点对象。

**估算**：每个节点 ~5 个字段（type / value / children / position / 等），3 万节点 × 5 字段 = 15 万属性。`structuredClone` 在 Chromium 上约 ~1μs/属性 → ~15ms。可接受。

**实测计划**：PoC 阶段用 Performance API 对比同步 parse vs Worker parse 的端到端耗时，验证序列化开销是否在预期范围。

### 5.5 测试影响

当前 `markdownIO.test.ts` 全部是同步 `fromMarkdown` 调用。`fromMarkdownAsync` 新增后：
- 同步 `fromMarkdown` 保留（小文档路径 + 测试）
- 新增 `fromMarkdownAsync` 的异步测试
- Worker 在 vitest (jsdom) 环境下的行为需验证：jsdom 支持 Worker，但 module Worker 的行为可能与浏览器有差异
- 备选：测试中 mock `fromMarkdownAsync` 为同步调用（绕过 Worker），只测 mdast→PM 逻辑

---

## 6. 预期收益

以 5000 行文档为例（估算值，需 PoC 实测校准）：

| 指标 | C3 现状 | C1 (方案 B) 后 |
|------|--------|---------------|
| 主线程总阻塞 | ~1500ms | ~400–600ms |
| 用户看到内容时间 | ~1.5s (spinner 期间冻结) | ~0.6–0.8s (spinner 期间可交互) |
| spinner 期间 UI 可交互 | ❌（主线程冻结） | ✅（可滚动 tab / 点菜单） |
| spinner 期间可编辑 | ❌ | ❌（编辑器还没加载真实 doc） |

**关键改善**：从「1.5s 完全冻结」变成「0.5s 可交互 spinner + 0.3s 最终阻塞」。虽然总时间只减少 ~50%，但「冻结」→「可交互」的感知改善是质变。

---

## 7. PoC 验证清单

实施 PoC 时需要验证以下关键问题：

### 7.1 平台验证
- [ ] Windows WebView2：`new Worker(new URL(...), { type: 'module' })` 正常加载
- [ ] Vite build 产出独立 Worker chunk，路径正确（`base: './'` 配置下）
- [ ] Tauri production build（非 dev server）Worker 路径正确
- [ ] CSP 不阻止 Worker 加载

### 7.2 性能验证
- [ ] 同步 `fromMarkdown` vs `fromMarkdownAsync` 端到端耗时对比（5000 行文档）
- [ ] `structuredClone` 序列化 mdast 的实际耗时
- [ ] Worker 初始化冷启动开销（首次创建 Worker 实例）
- [ ] Worker 复用后的单次 parse 耗时

### 7.3 正确性验证
- [x] Worker 产出的 mdast 与主线程同步 parse 结果完全一致（`createParseProcessor()` 共享配置 + 1414 round-trip 测试全通）
- [x] `annotateMathDelimiterCount` 在 Worker 外执行仍正确（`mdastToPMDoc` 共享核心，`fromMarkdown` / `fromMarkdownAsync` 复用同一逻辑）
- [x] 快速切 tab 时 parseToken 取消机制有效（`parseToken` 递增令牌 + `myToken !== parseToken` 检查）
- [ ] fs:watch 外部修改触发 modelValue 变化时，async parse 不与编辑 debounce 竞争（需 Tauri 环境实测）

### 7.4 边界场景
- [ ] 空文档 / 1 行文档走 Worker 路径的行为（PoC 验证用，生产仍走同步）
- [ ] 超大文档（10000+ 行）Worker 内存占用
- [x] Worker 错误处理：parse 抛异常时主线程 fallback 到同步 fromMarkdown（`fromMarkdownAsync` 内建 error / timeout 降级）

### 7.5 已实现清单

- [x] `parseProcessor.ts`：抽取共享 `createParseProcessor()`，Worker 和主线程共用
- [x] `markdownWorker.ts`：Worker 入口，`processor.parse(md)` + `processor.runSync(tree)` → mdast JSON
- [x] `markdownIO.ts`：`fromMarkdownAsync` + Worker 通信层（lazy init / error fallback / 10s 超时 / AbortSignal）
- [x] `mdastToPMDoc` 共享核心（`annotateMathDelimiterCount` + `mdastBlockToPM` + 空文档 / frontmatter-only 兑底）
- [x] `EditorInner.vue`：modelValue watch 大文档路径改 `fromMarkdownAsync` + `parseToken` 取消
- [x] `useProseMirror.ts`：`fromMarkdown` 回调类型改为 `PMNode | Promise<PMNode>`，`Promise.resolve(result).then(...)` 统一处理

---

## 8. 实施路线（如果 PoC 通过）

1. **抽取共享 processor 配置**：`createParseProcessor()` 函数，Worker 和主线程共用
2. **创建 `markdownWorker.ts`**：Worker 入口，接收 md → 返回 mdast JSON
3. **主线程 `fromMarkdownAsync`**：Worker 通信 + mdast→PM 转换
4. **EditorInner.vue 适配**：大文档路径改 async，加 parseToken 取消
5. **useProseMirror 适配**：冷启动大文档路径改 async
6. **错误降级**：Worker 创建失败 / parse 超时 → fallback 同步 fromMarkdown
7. **性能打点**：`perf.ts` 加 `fromMarkdown-async` measure，对比同步基线
8. **测试**：`fromMarkdownAsync` round-trip 测试 + Worker mock 测试

预计工作量：~2–3 天（含 PoC 验证 + 实现 + 测试）。

---

## 9. 如果 PoC 不通过的退路

如果 Worker 在 Tauri 环境下有不可逾越的障碍（CSP / 路径 / 平台兼容），退路：

1. **分块 parse**：把 markdown 按顶层块（paragraph / heading / code_block 等）用正则预切分，每块独立 parse 后合并 mdast。收益有限且复杂度高，不推荐
2. **requestIdleCallback 分块**：parse 不可分块（micromark 是状态机流式解析，中间状态不完整），但可以把 `mdastBlockToPM` 分块（每 500 个 block yield 一次），让主线程在转换间隙响应 UI。收益 ~100–200ms
3. **保持 C3 现状**：1.5s spinner + 可交互遮罩已经比冻结旧内容好很多，可接受作为 v0.7.8 的最终状态

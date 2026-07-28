# ProseMirror 大文档性能优化调研

> **背景**: WYSIWYG 模式（ProseMirror）在加载/浏览 5000+ 行文档时出现明显卡顿。源码模式（CodeMirror 6）因内置 viewport 渲染无此问题。本调研聚焦 PM 侧的可落地优化方案。

## 瓶颈定位

通过代码审查，当前 PM 编辑器在处理大文档时存在以下性能瓶颈，按影响程度排列：

### 瓶颈 1：多插件全量 `doc.descendants()` 遍历（最大瓶颈）

每次 `docChanged` transaction 后，以下插件的 `decorations(state)` 都会独立执行一次完整的 `doc.descendants()` 遍历：

| 插件 | 遍历目标 | 产物 |
|------|---------|------|
| `codeHighlightPlugin` | code_block + frontmatter | per-token `Decoration.inline` + header `Decoration.widget` |
| `codeLineNumberPlugin` | code_block | per-line `Decoration.widget`（行号） |
| `foldDecoration` | heading + list_item + code_block + frontmatter | toggle widget + `Decoration.node`（velo-folded） |
| `mermaidDecoration` | code_block(mermaid) | `Decoration.node` + SVG `Decoration.widget` |
| `tocDecoration` | toc 节点 + 全部 heading（widget 内再遍历一次） | `Decoration.widget` |
| `codeWrapPlugin` | code_block | `Decoration.node` |
| `findHighlight` | 全文搜索匹配 | `Decoration.inline` |

一个 5000 行文档约有 200-500 个顶层 block 节点，7 个插件各跑一次 `descendants` = **7 次全量遍历**。其中 `codeHighlightPlugin` 还对每个 code_block 调 `getTokensCached` 做 shiki 分词，生成大量 `Decoration.inline`（一个 100 行代码块约产生 300-600 个 inline decoration）。

当前所有插件均采用 **全量重建** 模式：`DecorationSet.create(state.doc, decos)`，而非 `DecorationSet` 的增量 `add` / `remove` / `map` API。

### 瓶颈 2：DOM 全量渲染（架构性限制）

ProseMirror 会为整个文档的每个节点创建 DOM 元素。5000+ 行文档意味着数千个 `<p>` / `<h1>` / `<pre>` 等 DOM 节点同时存在于 DOM 树中。这与 CM6 形成鲜明对比——CM6 内置 viewport 渲染，只创建可见区域的 DOM。

PM 的 `EditorView` 不支持 viewport 化渲染。其 `docView` → `ViewDesc` 树会完整同步到 DOM，没有"跳过不可见区域"的机制。

### 瓶颈 3：`toMarkdown` 同步序列化

`useProseMirror.ts` 的 `dispatchTransaction` 在每次 `docChanged` 时同步调 `opts.onChange(next.doc, tr)`，`EditorInner.vue` 的 `onChange` 回调执行 `toMarkdown(doc)` 走 unified pipeline（remark-stringify + 多个 remark 插件）。5000+ 行文档的序列化在主线程同步执行，每次按键都产生延迟。

### 瓶颈 4：`fromMarkdown` 同步解析

文档加载时 `fromMarkdown(md, schema)` 走 unified pipeline（remark-parse + remark-gfm + remark-math + 7 个自定义 remark 插件 + mdast→PM 转换），5000+ 行文档的解析在主线程同步执行，导致打开文件时明显卡顿。

### 瓶颈 5：NodeView 创建开销

每个 image / hr / frontmatter / html / math_block / math_inline / tasklist / footnote 节点都会创建 NodeView 实例（DOM 创建 + 事件监听 + 可能的异步渲染如 KaTeX / Mermaid）。大文档中如果有大量此类节点，初始渲染开销显著。

### 瓶颈 6：`syntaxAutoFormatPlugin` 的 dirty-range 扫描

该插件已做了 dirty-range 优化（只扫被波及的 textblock），是好的设计。但每次 transaction 仍需从 `tr.mapping.maps` 抽取 dirty ranges 并对相关 textblock 跑全部 block + inline 正则。在大文档中编辑时这本身开销可接受，但与其他插件叠加加剧了每次 transaction 的总开销。

---

## 优化方案

按 **投入产出比** 分三档。推荐从 Tier 1 开始，逐步推进。

### Tier 1：低风险高收益（不改架构）

#### 方案 A1：`content-visibility: auto` CSS 虚拟化

**原理**：CSS `content-visibility: auto` 让浏览器跳过不可见区域元素的布局和绘制，相当于浏览器原生的"虚拟化"。元素仍然在 DOM 中（不影响 PM 的 selection / scroll / decoration 机制），但浏览器不为它们计算布局。

**实施**：

```scss
// 在 .velo-editor 下，为 PM 的块级子元素应用 content-visibility
.velo-editor .ProseMirror > * {
  content-visibility: auto;
  contain-intrinsic-size: auto 1.5em; // 预估高度，避免滚动条抖动
}
```

对 code_block 等高度差异大的块，可用 `contain-intrinsic-size` 给一个更合理的默认值（如 `auto 100px`），或通过 `content-visibility` 配合 `contain-intrinsic-size` 的 `auto` 关键字让浏览器记住已渲染过的元素高度。

**优点**：
- 零 JS 改动，纯 CSS
- WebView2（Chromium 83+）原生支持
- 不影响 PM 的任何内部机制（selection / decoration / scroll / NodeView）
- 对"浏览大文档"场景（用户不编辑、只滚动）效果最显著

**风险**：
- `contain-intrinsic-size` 估算不准会导致滚动条长度跳动（可接受，渐进改善）
- 需要验证 `content-visibility: auto` 是否影响 `coordsAtPos`（PM 用它定位光标）——需实测
- 对 `content-visibility: hidden` 子树内的 decoration widget（如 code header）可能不渲染——但 `auto` 模式下进入视口会自动渲染，影响可控

**预估收益**：浏览大文档时的滚动/绘制性能可提升 3-5 倍（浏览器跳过 90%+ 的不可见节点布局）。

#### 方案 A2：合并 `doc.descendants()` 遍历

**原理**：当前 6-7 个 decoration 插件各跑一次 `doc.descendants()`。可引入一个共享的 "doc scan" 层，单次遍历收集所有插件需要的节点信息，分发给各插件。

**实施思路**：

方案一（保守）：创建一个 "scan cache" plugin，在 `apply` 阶段做一次 `doc.descendants()` 遍历，把结果按节点类型分组存入 plugin state。其他 decoration 插件读这个 cache 而非自己遍历。

方案二（激进）：把 code-related 的 4 个插件（codeHighlight + codeLineNumber + codeWrap + mermaid）合并为单个 `codeBlockPlugin`，一次遍历产出全部 code_block 相关 decoration。fold + toc 合并为 `structurePlugin`。

**优点**：
- 从 7 次遍历降到 1-2 次
- 不改变任何 decoration 的行为语义

**风险**：
- 合并插件会打乱 `allPlugins` 顺序契约（editor.md 文档要求同步）
- 方案一引入插件间耦合（decoration 插件依赖 scan cache plugin 的 state）
- 需要保证 scan cache 在 decoration 之前完成（plugin apply 顺序 = allPlugins 数组顺序）

**预估收益**：decoration 构建阶段减少约 60-70% 的遍历开销。

#### 方案 A3：`toMarkdown` 去抖

**原理**：当前每次 `docChanged` 同步执行 `toMarkdown(doc)`。对于大文档，序列化耗时可达数十毫秒，直接拖慢每次按键的响应。

**实施**：在 `EditorInner.vue` 的 `onChange` 回调中，对 `toMarkdown` 加 debounce（如 150ms）。`documentStore.content` 的更新和自动保存判断都基于 `toMarkdown` 的输出，因此 debounce 后 dirty 检测会有短暂延迟，但不影响编辑体验。

需注意 `lastSelfEmitted` echo 哨兵机制：debounce 后 `lastSelfEmitted` 的更新时机要对应调整——在 `toMarkdown` 实际执行时才设 `lastSelfEmitted`，而非在 `onChange` 触发时。

**优点**：
- 改动极小（几行代码）
- 直接改善大文档下的打字延迟

**风险**：
- debounce 期间如果外部 `modelValue` 变化（如 fs:watch），echo 检测可能误判——需要在 debounce flush 前检查
- 草稿自动保存（30s 间隔）在 debounce 窗口内可能拿到旧 content——可接受，下次 flush 会修正

**预估收益**：大文档下每次按键的同步开销降低到接近 0（序列化被推迟）。

#### 方案 A4：`fromMarkdown` 分块解析

**原理**：大文档的 unified pipeline 解析（remark-parse + 多个 remark 插件 + mdast→PM 转换）在主线程同步执行，阻塞 UI。

**实施**：对大文档（如 > 2000 行）采用分块策略：
1. 先按 markdown 结构（标题/空行）把原文切成 chunk
2. 同步解析第一个 chunk（首屏内容），立即 `view.updateState`
3. 用 `requestIdleCallback` 分批解析剩余 chunk，逐步拼接到 PM doc
4. 解析期间显示 loading 占位

**优点**：
- 首屏渲染从"等全文解析完"变成"等首屏解析完"
- 不改变 PM 架构

**风险**：
- markdown 语法可能跨 chunk（如代码块跨多行、列表跨段落），切分点需谨慎
- 分批拼接 PM doc 需要多次 `tr.replaceWith`，可能触发多次 decoration rebuild
- 实现复杂度中等

**预估收益**：大文档打开时间从"卡 N 秒"变成"首屏立即可见，后台逐步加载"。

---

### Tier 2：中等工作量，显著收益

#### 方案 B1：viewport 感知的 decoration 构建

**原理**：只为视口内（及附近）的节点构建 decoration，视口外的节点跳过。滚动时增量补充。

**实施**：
1. 在滚动容器上监听 scroll 事件（debounce 100ms），记录当前可见的 doc pos 范围（用 `view.posAtDOM(scrollTop)` 和 `view.posAtDOM(scrollTop + clientHeight)` 计算）
2. decoration 插件的 `buildDecorations` 只处理 `[visibleStart - buffer, visibleEnd + buffer]` 范围内的节点
3. 滚动时 dispatch 一个 `setMeta(viewportKey, { from, to })` 触发受影响插件 rebuild decoration
4. 用 `DecorationSet` 的增量 API（`add` / `remove`）而非全量 `create`

**关键影响插件**：
- `codeHighlightPlugin`：只高亮可见 code_block——最大收益点
- `codeLineNumberPlugin`：只为可见 code_block 生成行号
- `mermaidDecoration`：只渲染可见 mermaid 的 SVG
- `foldDecoration`：只为可见 heading/list_item 挂 toggle（注意：fold 的 `Decoration.node`（velo-folded）需要始终生效，不能因滚出视口而展开）
- `tocDecoration`：TOC 本身通常是少量节点，可全量

**优点**：
- decoration 数量从 O(全文档) 降到 O(视口)
- shiki 分词开销从 O(全部 code_block) 降到 O(可见 code_block)
- 滚动流畅度显著提升

**风险**：
- PM 的 `decorations(state)` 在 `view.update` 时同步调用，无法知道"当前视口"——需要通过 plugin state 传递 viewport 信息
- 快速滚动时可能出现 decoration 空白闪烁（buffer 区域需足够大，如上下各 1000px）
- `findHighlight` 的搜索高亮需要覆盖全文档（不能只高亮可见区域），需排除
- fold 的 `velo-folded` class 如果因滚出视口而丢失，折叠区段会"展开"——需特殊处理：fold 的 `Decoration.node` 始终全量，只有 toggle widget 走 viewport
- 跨模式同步（crossModeSync）的 `coordsAtPos` 可能在视口外节点上调用——需确保 buffer 足够

**预估收益**：decoration 构建从 O(全文档) 降到 O(视口)，对 code-heavy 的大文档可减少 80-95% 的 decoration 开销。

#### 方案 B2：增量 DecorationSet 更新

**原理**：当前所有插件在 `decorations(state)` 中全量重建 `DecorationSet`。PM 的 `DecorationSet` 支持 `add()` / `remove()` / `map()` 增量操作。利用 `tr.mapping` 只更新受影响范围的 decoration。

**实施**：
1. plugin state 缓存上一次的 `DecorationSet`
2. `apply(tr, oldState, newState)` 中：
   - 如果 `tr.docChanged`：用 `tr.mapping` 映射旧 decoration 的 pos，只对 dirty range（从 `tr.mapping.maps` 提取）重建 decoration，`add` / `remove` 到旧 set
   - 如果 `tr` 只是 selection 变化：`DecorationSet.map(tr.mapping)` 平移即可
3. `decorations(state)` 直接返回缓存的 `DecorationSet`

**优点**：
- 消除全量重建——只处理变化部分
- 对"局部编辑"场景（打字、删除几行）效果最佳

**风险**：
- 增量更新逻辑复杂，容易出错（pos 映射、decoration 过期判断等）
- 某些 decoration 的 key 含文本 hash（如 code header widget），文本变化时需要精确移除旧 widget 再添加新的——增量逻辑需感知 key 语义
- fold 的 `collapsedSet` 变化时需要同步更新 decoration——增量逻辑需处理 fold toggle 场景
- 初始实现 bug 风险高，需要充分的 round-trip 测试

**预估收益**：局部编辑时 decoration 构建从 O(全文档) 降到 O(dirty range)，对打字延迟改善显著。

#### 方案 B3：NodeView 延迟创建

**原理**：对昂贵的 NodeView（mermaid SVG 渲染、KaTeX 公式渲染），延迟到节点进入视口时才创建。

**实施**：
1. 初始渲染时，为视口外的 mermaid/math_block 节点创建轻量占位 NodeView（只显示"加载中"或语言标签）
2. 滚动到视口时，用 `IntersectionObserver` 或手动 scroll 检测触发真正的渲染
3. 滚出视口后可选地销毁昂贵资源（SVG / KaTeX DOM），保留占位

**优点**：
- 减少 NodeView 初始创建的 DOM 操作和异步渲染开销
- 对含大量公式/图表的大文档效果显著

**风险**：
- NodeView 的 `update` / `destroy` 生命周期需要仔细管理
- mermaid 的 `Decoration.widget` 模式（非 NodeView）无法直接用此方案——需改为 NodeView 或在 widget 侧也做延迟
- KaTeX 渲染是 async 的，已有 stale-check 机制，延迟创建需与之协调
- `coordsAtPos` / `scrollIntoView` 可能定位到未渲染的节点——需确保占位有正确高度

**预估收益**：含大量公式/图表的文档初始加载提速明显。

---

### Tier 3：高工作量，架构级改动

#### 方案 C1：`toMarkdown` / `fromMarkdown` 移入 Web Worker

**原理**：unified pipeline（remark-parse / remark-stringify + 自定义插件）是纯函数式转换，不依赖 DOM，可移入 Web Worker。

**实施**：
1. 把 `markdownIO.ts` 的 `fromMarkdown` / `toMarkdown` 包装为 Worker 消息
2. PM doc 是普通 JS 对象（可序列化），但 PM 的 `Node` 实例有 `type` 指向 `Schema` 引用——不能直接 postMessage。需要在 Worker 侧重建一个等价 Schema，或传输 mdast JSON 在主线程做 mdast→PM 转换
3. `toMarkdown`：主线程 `doc → mdast JSON`（同步，快）→ Worker `mdast JSON → markdown string`（异步，慢）
4. `fromMarkdown`：Worker `markdown string → mdast JSON`（异步，慢）→ 主线程 `mdast JSON → PM doc`（同步，快）

**优点**：
- 解析/序列化不阻塞主线程
- 打字延迟不再受 `toMarkdown` 影响
- 文档打开不再卡 UI

**风险**：
- Worker 通信有序列化开销（大文档的 mdast JSON 可达数 MB）
- `fromMarkdown` 的结果需要同步用于 `view.updateState`——异步等待期间 UI 需显示 loading
- `toMarkdown` 异步化后，`lastSelfEmitted` echo 机制需重新设计（emit 和 content 更新不再同步）
- Tauri WebView2 支持 Web Worker，但需验证 Worker 内能否 import unified 相关包（Vite 需配 worker format）
- 跨模式同步（crossModeSync）依赖实时 `toMarkdown` 输出做 token 对齐——异步化后需调整

**预估收益**：彻底消除解析/序列化的主线程阻塞，大文档打字/加载体验接近小文档。

#### 方案 C2：DOM 虚拟化（高度实验性）

**原理**：只渲染视口内的 DOM 节点，用占位元素替代视口外的节点。

**实施思路**：
- 自定义 `EditorView` 的 `docView`，拦截 `ViewDesc` 的 `sync` 方法，跳过不可见子节点的 DOM 创建
- 或在 `view.dom` 和 `view.docView` 之间注入一个"虚拟滚动层"，监听 scroll 事件动态增删 DOM 节点

**风险**：
- **极高**。PM 的 `EditorView` 内部（`viewdesc.ts`、`input.ts`、`selection.ts` 等）假设 DOM 与 doc 完全同步。虚拟化后 selection 映射、IME 处理、拖放、粘贴等都会出错
- 没有社区先例（Tiptap / Atlassian Editor 等基于 PM 的编辑器均未做 DOM 虚拟化）
- 维护成本极高，每次升级 prosemirror-view 都可能 break

**不推荐**：除非有专职团队长期维护，否则 ROI 过低。方案 A1（`content-visibility: auto`）能以 1% 的成本获得 80% 的收益。

#### 方案 C3：文档分块加载

**原理**：超大文档（10000+ 行）只加载首屏部分到 PM，滚动时动态加载更多。

**风险**：
- PM 的位置模型要求完整 doc 在内存中——分块加载意味着 doc 是"不完整"的，selection / decoration / search / export 全部受影响
- 需要在 PM 之上做一层"虚拟 doc"代理，拦截所有 pos 相关操作
- 复杂度极高，且与现有的 fold / find-replace / crossModeSync / 导出等功能深度冲突

**不推荐**：对于 Velo 的目标用户场景（本地 markdown 编辑器，单文档通常 < 10000 行），方案 A1 + B1 已足够。

---

## 推荐实施路线

```
Phase 1（立即可做，1-2 天）:
  ├── A1: content-visibility: auto CSS 虚拟化
  ├── A3: toMarkdown debounce
  └── 验证：用 tauri build 出包后在 WebView2 测 5000+ 行文档

Phase 2（1-2 周）:
  ├── A2: 合并 doc.descendants() 遍历（先做 scan cache 方案）
  ├── A4: fromMarkdown 分块解析（对 >2000 行文档）
  └── 验证：对比 Phase 1 的性能指标

Phase 3（2-4 周，视 Phase 1-2 效果决定是否需要）:
  ├── B1: viewport 感知 decoration 构建
  ├── B2: 增量 DecorationSet 更新
  └── B3: NodeView 延迟创建

Phase 4（远期，如有需要）:
  └── C1: markdownIO 移入 Web Worker
```

### 优先级判断依据

- **A1（content-visibility）是性价比最高的方案**：纯 CSS、零风险、不碰 PM 内部机制。WebView2 的 Chromium 内核完整支持 `content-visibility: auto`。这是应该立即实施的第一步。
- **A3（toMarkdown debounce）是改善打字延迟的最低成本方案**：几行代码，立即见效。
- **A2（合并遍历）和 B1/B2（viewport decoration / 增量 DecorationSet）是中长期的核心优化**：它们解决的是"每次 transaction 的 decoration 构建开销"问题，A1 无法覆盖这个维度（A1 只解决 DOM 布局/绘制开销）。
- **C1（Web Worker）是终极方案**：如果 Phase 1-3 后大文档体验仍不理想，再考虑。但 A3 的 debounce 已经能在很大程度上缓解 `toMarkdown` 的阻塞问题。

### 性能测量方法

按 editor.md 的既有约定，性能指标必须用 `tauri build` 出包后在 WebView2 测，不能看 `npm run dev`。

建议测量维度：
1. **文档打开时间**：从点击文件到编辑器可交互的时间
2. **打字延迟**：按键到字符出现在屏幕上的延迟（可用 Performance API 的 `performance.now()` 在 keydown → requestAnimationFrame 中测量）
3. **滚动 FPS**：用 `requestAnimationFrame` 帧率统计
4. **内存占用**：WebView2 的 `performance.memory`（如可用）或 Tauri 的进程内存

测试文档：准备一份 5000 行的 markdown 文件（混合 heading / paragraph / code_block / table / list / math / mermaid），作为性能回归基准。

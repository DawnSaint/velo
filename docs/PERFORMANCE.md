# 输入性能瓶颈调查报告

> 调研日期：2026-06-24
> 范围：行数 ~1000 时单字符输入出现可感知延迟
> 状态：**待整改** —— 文中所有 file:line 引用为调查当时位置，整改时以最新代码为准

---

## TL;DR

每键输入串行叠加 **6 次独立全树遍历**，分布在 PM 装饰管线、`toMarkdown` 序列化、Vue 大纲解析三段。最严重的是 4 个 Decoration plugin 无差别全树重建 + `codeHighlightPlugin` 内嵌的同步 shiki 分词。

| Tier | 数量 | 每次 keystroke 做什么 |
|------|------|----------------------|
| 🔴 1 | 4 个 Decoration plugin | `doc.descendants` 全树 + 装饰对象分配 |
| 🔴 2 | 1 次 `toMarkdown(doc)` | PM doc → mdast → string 全树序列化 |
| 🟠 3 | 1 次 `parseHeadings(content)` + 2 个 outline computed | markdown 全串 regex 重解析 + outline 树 walk |
| 🟡 4 | `syntaxAutoFormatPlugin` | dirty-range 内 ~11 条 inline regex（**已有合理过滤**） |

**首选怀疑对象**：`codeHighlightPlugin` 的 shiki `codeToTokensWithThemes` 同步分词（单键成本最高），但需埋点实测确认。**建议先加埋点再决定优化顺序**。

---

## 一、每次输入字符会发生什么

`src/components/ProseMirrorEditor/EditorInner.vue:303` 注册 28 个 ProseMirror plugin。PM `view.updateState` 在**每一次 dispatch**（含单字符输入）跑所有 plugin 的 `apply` + 所有 `props.decorations(state)`。每条按键的下游链路：

```
按键 → dispatchTransaction
  ├─ tr.docChanged 触发下列 apply（plugin state 重算）
  ├─ 所有 props.decorations(state) 跑一遍  ← ★ Decoration 重算
  ├─ onChange(doc) → toMarkdown(doc)        ← ★ 全树序列化
  └─ emit('update:modelValue', md)
       └─ App.vue 写 documentStore.content
            └─ EditorOutline watch → parseHeadings(content)  ← ★ 全 markdown 重解析
                 └─ flatList / headingIndex computed 触发
```

每键至少 **6 次独立全树遍历**（4 个 Decoration plugin + toMarkdown + parseHeadings），全部同步串行。

---

## 二、按严重度排序的瓶颈

### 🔴 Tier 1 — 每个 keystroke 完整遍历 doc 的 Decoration plugin

4 个 plugin 都实现 `props.decorations(state)`，PM 在 `view.updateState` 阶段**无条件**调用，无 dirty-range 检查，无装饰集缓存。

| # | Plugin | 文件 | 每次 keystroke 做什么 | 关键引用 |
|---|--------|------|---------------------|---------|
| 1 | `codeHighlightPlugin` | `src/components/ProseMirrorEditor/nodes/CodeHighlightWidget.ts:404` | `state.doc.descendants(...)` 找所有 `code_block` → 每块调 shiki `codeToTokensWithThemes` 同步分词 → 逐 token 建 `Decoration.inline` + toolbar widget | line 411 全树遍历，line 493 shiki tokenize 每块都跑 |
| 2 | `mermaidDecoration` | `src/components/ProseMirrorEditor/nodes/MermaidDecoration.ts:139` | `state.doc.descendants(...)` 找 `code_block[lang=mermaid]` → 每块建 SVG widget（async mermaid render） | line 141 全树遍历 |
| 3 | `tocDecoration` | `src/components/ProseMirrorEditor/nodes/TocDecoration.ts:190` | **两次** `doc.descendants` —— 一次 `collectHeadings(state.doc)`（line 192）建 heading 树；一次 `doc.descendants`（line 197）挂 widget。`apply`（line 218）`tr.docChanged` 时再跑一次 `collectHeadings` 重算 hash | line 224 `if (tr.docChanged)` 无条件重算 |
| 4 | `footnoteEditPlugin` | `src/components/ProseMirrorEditor/nodes/FootnoteNodeViews.ts:55-57` 的 `computeNumbering` 被 `apply` 每个 `tr.docChanged` 调一遍 → `doc.descendants` 收所有 footnote ref/def | line 22 全树遍历 |

**共性根因**：`doc.descendants` 本身是 O(N)，N = 节点数 + 文本长度。1000 行 markdown 经 `fromMarkdown` 展开后 doc 节点数典型为行数的 3-5 倍。再叠上每节点建 Decoration 对象（每个 token 一个 Decoration.inline），装饰集构造本身是 O(N) 内存分配。

`codeHighlightPlugin` 是**单键成本最高的**：shiki `codeToTokensWithThemes` 是同步、CPU 密集的语法分词。文档里有 10 个代码块、每块 50 行 → 每键 10 次完整 shiki 分词。

### 🔴 Tier 2 — `toMarkdown` 每次按键全树序列化

- `EditorInner.vue:352`（onChange callback）每次按键 `const md = toMarkdown(doc)`
- `src/components/ProseMirrorEditor/editor/markdownIO.ts:413` 入口：`pmBlocksToMdast(doc)` → 逐节点 `pmBlockToMdast` + `pmInlineToMdast` → 拼 mdast → `processor.stringify(tree).toString()`
- unified `stringify` 是另一道全树遍历（mdast visitor 状态机）

1000 行输入，toMarkdown 一遍典型复杂度：~5000 节点遍历 + ~3000 字符串拼接 + remark-stringify visitor 全量。**无 debounce**——和 keystroke 1:1 同步。

### 🟠 Tier 3 — Outline `parseHeadings` 每次 emit 重解析 markdown

- `src/components/Sidebar/EditorOutline.vue:95-122` `watch(() => props.modelValue, ...)` 无防抖，每次 emit 都 `tree.value = parseHeadings(v)`
- `parseHeadings`（`src/utils/outline.ts:49`）：先 `stripFencedCodeBlocks`（全串 regex replace）→ 再用 `/(#{1,6})\s+(.+)$/gm` 扫全串 → 每个 heading 跑 8 次 regex strip 格式字符
- 触发链：每次 PM 输入 → `toMarkdown` → `emit('update:modelValue')` → `documentStore.content` → 父组件 `modelValue` → `parseHeadings` → `flatList` computed（line 125 全树 walk）→ `headingIndex` computed（line 165 全树 walk）

1000 行文档的 markdown 串 ~50KB，每次按键 1 次完整 markdown 解析 + 2 次 outline 树 walk。

> **注**：`src/utils/outlineFilter.ts` 的 `fuzzyMatch` + `filterHeadings` **不是** per-keystroke 瓶颈——它只在 `query` 有值时由 `filterResult` computed 触发（`EditorOutline.vue:38`），用户空 query 时短路。

### 🟡 Tier 4 — 监听 / 位置计算相关

| 来源 | 文件 | 每次按键做什么 | 评估 |
|------|------|--------------|------|
| `syntaxAutoFormatPlugin` | `src/components/ProseMirrorEditor/plugins/syntaxAutoFormat.ts:262-301` | `appendTransaction` 从 `tr.mapping.maps` 提 dirty range → `nodesBetween` 走 dirty 段 → 每 dirty textblock 跑 ~11 条 inline regex `exec` 循环 | **OK**，已用 dirty-range 局部扫，未扫全 doc |
| `findHighlight` | `src/components/ProseMirrorEditor/findreplace/findHighlight.ts:45-64` | 仅 `tr.mapping.map` 重映射 match positions，**仅在 find 面板打开时活** | OK |
| `linkClickPlugin` | `src/components/ProseMirrorEditor/plugins/linkClick.ts:106-124` | 链接源码编辑态才走 Decoration + click handler | OK |
| EditorOutline scroll-spy | `src/components/Sidebar/EditorOutline.vue:216-270` | 监听 outline 容器 `scroll`，rAF debounce，DOM rect 测量 | OK（非 keystroke 路径） |

`syntaxAutoFormatPlugin` 的 dirty-range 机制本身是合理的，未踩坑。重点是它和 Tier 1 的"无差别全树遍历"形成对比 —— 一个用 dirty range，一个没用。

### 🟢 已正确处理（不需要动）

- **自动保存**：`src/App.vue:127-139` debounce 1000ms，非 per-keystroke
- **草稿**：`src/App.vue:471-507` `setInterval` 30s
- **`lastSavedContent` / `dirty`**：`computed(() => content !== lastSavedContent)`，纯字符串 `===` 比较
- **`fs:watch`**：Tauri `delayMs: 100` + 前端 120ms 防抖
- **Tauri 命令**：`save()` 写 `content.value`（已是字符串），不二次序列化
- **`fromMarkdown`**：仅在外部 `modelValue` 变化或粘贴时调
- **scroll-spy**：rAF debounce

---

## 三、跨切面观察

1. **Decoration plugin 缺乏 dirty-range / cache 机制**
   4 个 plugin 都没利用 `tr.docChanged` + `tr.mapping` 做"只重建受影响区间"。统一做法是全树重建 + 用 Decoration key 哈希让 PM DOM diff 决定实际挂载。即便 DecorationSet 创建便宜，**遍历 + 装饰对象分配** 仍是 N 输入字符 × N 节点的纯成本。

2. **`codeHighlightPlugin` 复用了 shiki 双主题管线，但牺牲了重建频率**
   ARCHITECTURE 维护者注意点 #5 已经写了"懒加载 lang / 主题切换走 `setDecorationRebuildCallback` 钩子让 plugin 自己 rAF rebuild"，但**普通 keystroke 路径没接 rAF**——`buildDecorations` 在 `props.decorations(state)` 里同步跑 shiki。

3. **`tocDecoration` 维护了缓存却没用上**
   `apply` 已经维护了 `headingsHash`，但 `props.decorations` 又调 `buildDecorations`，里面**重跑** `collectHeadings(state.doc)`。即使 hash 没变，descendants 也跑——典型的"维护了缓存却没用上"。

4. **`toMarkdown` 无防抖 + emit 透传**
   `emit('update:modelValue')` 在 onChange 内**同步**触发，`documentStore.content` 同步更新，`EditorOutline` watch 同步跑——三段串行无任何 `requestAnimationFrame` / `setTimeout` / `nextTick` 缓冲。哪怕各段都不重，串起来也是 N×3 的同步工作。

5. **缺乏 profiling / 计时埋点**
   当前没有 keystroke → end-of-frame 时长统计，没有 plugin 级 timing logs。后续优化前应先加埋点定位真实热点（理论上 `codeHighlightPlugin.buildDecorations` 应是首要嫌疑，但需实测）。

---

## 四、优化方向（仅作方向建议，未实现）

按 ROI 排序：

1. **`codeHighlightPlugin` 引入 dirty-range + 防抖**：shiki 分词是单键最大成本。在 `apply` 里从 `tr.mapping` 提取 dirty range，只对命中的 `code_block` 重跑 tokenize；不命中走 `DecorationSet.create(state.doc, prevDecos.find())`。或学 ARCHITECTURE #5 那套 `setDecorationRebuildCallback` 走 rAF debounce。
2. **其他 3 个 Decoration plugin 同样接入 dirty-range**：`footnoteEditPlugin` / `mermaidDecoration` / `tocDecoration` 都该走 "tr.docChanged + 节点类型白名单" 守卫，脏 range 内没有目标节点类型时跳过。
3. **`tocDecoration` 用上自己维护的 hash**：cache `headingsHash`，未变时复用 prev DecorationSet；只 hash 变了才 `buildDecorations`。
4. **`parseHeadings` 加防抖**：`EditorOutline.vue:95` `watch` 改 `watchDebounced`（或自带 150-300ms 防抖）。Outline 不需要按键级实时，输入延迟几乎无感。
5. **`toMarkdown` 加防抖 / 异步化**：emit 的 markdown 串可以走 rAF / 微任务合并；甚至考虑 PM doc 局部 dirty → 局部 markdown 串 diff 替换 `content.value`。当前每次按键全树 serialize 是显眼的浪费（除非有什么下游强一致需求，目前未发现）。
6. **先加埋点再优化**：在 4 个 Decoration plugin 的 `props.decorations` 入口 + `toMarkdown` 入口 + `parseHeadings` 入口加 `console.time` / `performance.mark`，用真实数据定位 Tier 1 中谁是单键成本冠军，再决定优化顺序。

---

## 五、附录：被排查但**不是**瓶颈的路径

- 撤销栈 `history` plugin：PM 内部实现，已是 O(step)，合理
- `inputRulesPlugin`：只跑 `ellipsis` 一条规则，且只在输入匹配时触发
- `tabIndent` / `dollarEnterToMathBlock` / `imageKeymap` / `markdownPaste`：只在对应键位触发，不在普通字符输入路径
- `imageUploadPlugin`：只在 paste/drop image/* 触发
- `taskListPlugin`：NodeView 复用，只 checkbox 状态变时跑
- 源代码模式（`SourceModeEditor`）：不在本调研范围，走 CM6 而非 PM 路径
- 跨模式 `crossModeSync`：仅在切模式那一帧跑

---

## 调研方法

- 读 `docs/ARCHITECTURE.md`（必读）确认架构终态
- 派 Explore agent 全量摸 `EditorInner.vue` `allPlugins` 数组 + 每个 plugin 的实现 + outline 链路 + markdownIO 调用点
- 抽样读 `CodeHighlightWidget.ts`、`MermaidDecoration.ts`、`TocDecoration.ts`、`FootnoteNodeViews.ts`、`EditorOutline.vue`、`markdownIO.ts`、`EditorInner.vue` 关键行段确认 Explore 报告的引用与算法描述
- 未跑实际 profiling —— 所有"单键成本"判断为算法复杂度推理，未实测

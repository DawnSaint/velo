# Find / Replace

> **本文件负责**：Ctrl+F / Ctrl+H 的浮层 UI、用户意图保存、PM / CM6 双后端、替换与高亮语义。
>
> **何时阅读**：改 `findreplace/*`、搜索选区定位、替换行为或 mermaid 源码搜索定位时。
>
> **代码入口**：`src/components/ProseMirrorEditor/findreplace/{FindReplace.vue,backend.ts,findIntent.ts,findMatches.ts,findHighlight.ts,cmFindHighlight.ts,cmDocChange.ts,cmLineHighlight.ts}`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [编辑器](./editor.md) · [工作区搜索](./workspace-search.md)

## 红线

- **`FindReplace.vue` 只经 `FindReplaceBackend` 抽象驱动**，不直接依赖 PM / CM6 API。
- **query / 选项 / 替换文 / showReplace 是用户意图，必须上提 App.vue `provide(findIntentKey)`**；`matches` / `currentIndex` 不上提（模式相关）。
- **`replaceAll` 必须倒序遍历 matches**，避免前面的替换污染后续坐标。
- **matches 坐标只属于产出它的那份 doc**：PM 的源码编辑态会改文档，拿坐标前必须统一 doc 形态（`flushMarkSourceEdit` + `flushCharRefReveal`）。
- **`char_ref` 查找要同时搜「解码文本」与「实体字面量」**，且面板打开期间不改 doc（用纯装饰显示命中）。
- **`replaceRange` 空 replacement 必须走 `tr.delete`**（PM 不允许空 text 节点）。
- **PM `apply` 区间过 `tr.mapping` 时 from 用 assoc=-1、to 用 assoc=1**。

## 架构

### 双后端与意图上提

`FindReplace.vue` 经 `FindReplaceBackend` 抽象驱动，`createPmBackend` / `createCmBackend` 两份实现，`v-if / v-else` 互斥（同一时刻只有一份活着）。

- **意图上提**：`findIntent.ts` 的 `FindIntent`（query / replacement / caseSensitive / wholeWord / regex / showReplace）由 `App.vue` provide，两份 `FindReplace` inject 共享 —— 切模式时 PM 那份卸载、CM6 那份新挂载，本地 ref 会丢，上提后 query 跨模式保留。
- **matches / currentIndex 不上提**：PM 走 prose 文本不跨块，CM6 在原始 markdown 全串（含 `**` / `|` / `[]()` 可跨行），命中位置与数量都不同，新挂载时用当前后端 recompute。
- **高亮**：PM 走 `findHighlight` plugin（`setMeta`），CM6 走 `cmFindHighlightField` + `cmFindHighlightEffect`（镜像 PM 侧）。CSS `.velo-find-match` / `.velo-find-current` 全局共用。

### 替换

- `replaceAll` 倒序遍历 matches，每个 `getRangeText` → `replaceInText`（全局正则在 match 子串重跑，支持 `$1` / `$2`）→ `replaceRange`。
- PM match 不跨文本节点、CM6 match 可跨行，两边统一成立。
- CM6 文档即原始 markdown，无源码编辑态切换，装饰由 `deco.map(tr.changes)` 自行跟住。

## 关键取舍

- **PM 后端 `setSelection → scrollMatchIntoView` 跨方法标记（WeakMap）**：mermaid 源码 `display:none` 切到 block + widget 重建会让 layout 抖，`scrollMatchIntoView` 必须 rAF 等下一帧再 `coordsAtPos`，否则跨文件搜索冷启动会偏（同文件 Ctrl+F 多半撞上已展开 mermaid，layout 立刻稳，所以一直没暴露）。helper `ensureMermaidSourceVisibleAt` 是幂等的，串联调用第二次必返 false，**不能**在 `scrollMatchIntoView` 里靠「再调 helper 当信号」判要不要 rAF —— 等于把「刚展开」的事实丢了。正确做法：`setSelection` 展开时往 `WeakMap<PmEditorView, boolean>` 写 true，`scrollMatchIntoView` 读取并立即 delete；没标记时才再调一次 helper 兜底（测试 / 直接调 `scrollMatchIntoView` 的场景）。这是两方法的隐性契约，改任一都要保留。
- **PM `matches` 坐标稳定性：源码编辑态与查找面板的契约**：`markSourceEdit` / `emojiSourceEdit` / `charRefSourceEdit` 都是「把视图状态写进 doc」的插件（行内 `` `code` `` 展开净 +2；实体源码态 1 个解码字符 → 6 个字符），两份 doc 坐标系不通用，而 `FindReplace.vue` 缓存了 `matches`，表现为「搜 `itemCount` 定位成 `temCount `」。三层防线：
  1. `createPmBackend.findMatches()` 先 `flushMarkSourceEdit(view)` + `flushCharRefReveal(view)`，再在稳定的渲染态 doc 上算坐标。
  2. `findHighlight` plugin state 带 `active`，面板打开时 `isFindReplaceActive(state)` 让三个 source edit 插件不再改 doc；`setFindActive(true)` 还会 flush 已有会话。charRef 的**退避不等于不显示**：面板期间用纯 inline 装饰（`.velo-char-ref-inline` + `data-char-ref`，CSS `::after` 读属性）把命中到的实体 segment 原位显示成字面量，doc 形态不变 → 高亮坐标不漂（机制见 [editor.md](./editor.md)）。
  3. 兜底：`findHighlight` 的 `view().update` 比较 doc 引用，docChanged 后经 `subscribeFindDocChange`（CM6 走 `subscribeCmDocChange`，120ms trailing debounce）微任务通知 `FindReplace.resyncMatches()` 重算 + 重推高亮（不重设选区）。

  关闭面板时 `clearHighlight` 翻回 `active=false` 并调 `recheckCharRefReveal` 按当前选区重判实体源码态。`apply` 里区间过 `tr.mapping` 时 **from 用 assoc=-1、to 用 assoc=1** —— 两端都用默认 assoc=1 时，命中区间被整体替换会一起被推到插入内容之后，区间塌缩成尾部一个字符甚至消失。
- **`replaceRange` 空 replacement 走 `tr.delete` 兜底**：PM `schema.text('')` 直接抛 `RangeError('Empty text nodes are not allowed')` —— ProseMirror 不允许构造空 text 节点（无论是否带 mark），所以「替换为」空串的「删 match」场景在 PM 侧会整条链爆掉，表现为「替换 / 全部替换」点下去没反应。修法：PM 后端 `replaceRange` 中 newText 为空时改走 `tr.delete(from, to)`（光标停在 from，后续 findNext 拿到的 cursorPos = from + 0 与 length=0 一致）；CM6 `changes.insert=''` 没限制、正常 work。两边契约分叉但语义对齐 —— 都是「区间消失、光标停在原 from」。后续若新增文本替换路径（如「插入到光标」），同样要在 entry 处判空再选 replaceWith / delete。
- **字符实体在 PM 侧搜两份文本**：`findMatchesInDoc` 对带 `char_ref` mark 的 text 节点各跑一遍「解码文本」与「展开的实体字面量」，按 `from:to` 去重后排序（机制见 [editor.md](./editor.md)）。搜空格仍命中解码字符、搜 `&#x20;` 命中同一区间 → Ctrl+Shift+F 的 ordinal 与 raw 逐行扫描对齐（见 [workspace-search.md](./workspace-search.md)）。只覆盖字面量一部分的查询（如 `x20`）夹到整个实体区间，不产零宽 match。CM6 文档即原始 markdown，只需原文一份，无此分支。

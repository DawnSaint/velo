# Find / Replace

> **本文件负责**: Ctrl+F / Ctrl+H 的浮层 UI、用户意图保存、PM/CM6 双后端、替换与高亮语义。
>
> **何时阅读**: 改 `components/ProseMirrorEditor/findreplace/*`、搜索选区定位、替换行为或 mermaid 源码搜索定位时。
>
> **先记住**:
> - `FindReplace.vue` 只经 `FindReplaceBackend` 抽象驱动，不直接依赖 PM/CM6 API。
> - query/选项/替换文/showReplace 是用户意图，上提到 App.vue；matches/currentIndex 是模式相关状态。
> - `replaceAll` 倒序遍历 matches，避免前面的替换污染后续坐标。
> - **matches 坐标只属于产出它的那份 doc**：PM 的源码编辑态会改文档，拿坐标前必须统一 doc 形态。
> - `char_ref` 节点在 PM doc 里只有一个解码字符：查找要同时搜「解码文本」与「实体字面量」，命中才算得到 `&#x20;`；算 matches 前先 `flushCharRefReveal`。
> - PM 命中隐藏 mermaid 源码时，setSelection 与 scrollMatchIntoView 之间靠 WeakMap 传递“刚展开”事实。
>
> **相关文件**: [架构索引](../ARCHITECTURE.md) / [编辑器](./editor.md) / [工作区搜索](./workspace-search.md)


## 设计要点

- **PM 后端 `setSelection → scrollMatchIntoView` 跨方法标记(WeakMap)**: mermaid 源码 display:none 切到 block + widget 重建会让 layout 抖,scrollMatchIntoView 必须 rAF 等下一帧再 `coordsAtPos`,否则跨文件搜索冷启动会偏(同文件 Ctrl+F 多半撞上已展开 mermaid,layout 立刻稳,所以一直没暴露)。helper `ensureMermaidSourceVisibleAt` 是幂等的,串联调用第二次必返 false,**不能**在 scrollMatchIntoView 里靠"再调 helper 当信号"判要不要 rAF —— 等于把"刚展开"的事实丢了。正确做法:setSelection 展开时往 `WeakMap<EditorView, boolean>` 写 true,scrollMatchIntoView 读取并立即 delete;没标记时才再调一次 helper 兜底(测试 / 直接调 scrollMatchIntoView 的场景)。这是 setSelection 与 scrollMatchIntoView 的隐性契约,改任一方法都要保留
- **查找替换双后端 (PM / CM6 共用)**: `FindReplace.vue` 经 `FindReplaceBackend` 抽象驱动,`createPmBackend`/`createCmBackend` 两份实现,`v-if/v-else` 互斥同一时刻一份活着。**用户意图(query/选项/替换文/showReplace)上提到 App.vue `provide(findIntentKey)`**,切模式时意图在 App.vue 存活 → query 跨模式保留;`matches`/`currentIndex` 模式相关,新挂载时 recompute。`replaceAll` 编辑器无关化:倒序遍历 matches,每个 `getRangeText` → `replaceInText`(全局正则在 match 子串重跑)→ `replaceRange`,逆序避免位置错位。两后端语义差异各自符合该模式所见文本(PM 走 prose 文本不跨块;CM6 在原始 markdown 全串含 `**`/`|`/`[]()` 可跨行);highlight PM 走 PM plugin setMeta、CM6 走 StateField + effect(镜像 PM 侧)。高亮 CSS `.velo-find-match`/`.velo-find-current` 全局共用
- **PM `matches` 坐标稳定性:源码编辑态与查找面板的契约**: `markSourceEdit` / `emojiSourceEdit` 是「把视图状态写进 doc」的插件 —— 光标进入行内 `` `code` `` 时,整个 mark 范围被换成字面量 `` `itemCount` ``(净 +2),移出光标再 commit 还原。两份 doc 的坐标系不通用,而 `FindReplace.vue` 缓存了 `matches`,表现为「搜 `itemCount` 定位成 `temCount `」「点击行内代码展开反引号后只剩尾部空格高亮」。三层防线:① `createPmBackend.findMatches()` 先 `flushMarkSourceEdit(view)` commit 会话 + `flushCharRefReveal(view)` 还原实体源码态(1 个解码字符 → 6 个字符,同样会漂坐标),再在稳定的渲染态 doc 上算坐标;② `findHighlight` 插件 state 带 `active`,面板打开时 `isFindReplaceActive(state)` 让三个 source edit 插件(mark / emoji / charRef)不再改 doc(关闭时 `clearHighlight` 翻回 false,并调 `recheckCharRefReveal` 按当前选区重判实体源码态),`setFindActive(true)` 还会 flush 已有会话(含 charRef reveal);charRef 的**退避不等于不显示**:面板期间用纯 inline 装饰(`.velo-char-ref-inline` + `data-char-ref`,CSS `::after` 读属性)把命中到的实体 segment 原位显示成字面量,doc 形态不变 → 高亮坐标不漂(见 [编辑器](./editor.md));③ 兜底 `findHighlight` 的 `view().update` 比较 doc 引用,docChanged 后经 `subscribeFindDocChange` 微任务通知 `FindReplace.resyncMatches()` 重算 + 重推高亮(不重设选区)。`apply` 里区间过 `tr.mapping` 时 **from 用 assoc=-1、to 用 assoc=1** —— 两端都用默认 assoc=1 时,命中区间被整体替换会一起被推到插入内容之后,区间塌缩成尾部一个字符甚至消失。CM6 文档即原始 markdown,无此形态切换,装饰由 `deco.map(tr.changes)` 自行跟住,两方法为空实现
- **`replaceRange` 空 replacement 走 `tr.delete` 兜底(replacement=' ' 删 match 的 PM 坑)**: PM `schema.text('')` 直接抛 `RangeError('Empty text nodes are not allowed')` —— ProseMirror 不允许构造空 text 节点(无论是否带 mark),所以「替换为」空串的"删 match"场景在 PM 侧会整条链爆掉,表现为「替换 / 全部替换」点下去没反应。修法在 PM 后端 `replaceRange`:newText 为空时改走 `tr.delete(from, to)`(光标停在 from,后续 findNext 拿到的 cursorPos = from + 0 与 length=0 一致);CM6 `changes.insert=''` 没限制、正常 work。两边契约分叉但语义对齐 —— 都是"区间消失、光标停在原 from"。后续若新增文本替换路径(比如"插入到光标"),同样要在 entry 处判空再选 replaceWith / delete

- **字符实体在 PM 侧搜两份文本**:`findMatchesInDoc` 对带 `char_ref` mark 的 text 节点各跑一遍「解码文本」(`node.text`)与「展开的实体字面量」(`expandCharRefText`,下标经 `buildCharRefIndexMap` 映回 doc 坐标),按 `from:to` 去重后排序。搜空格仍命中解码字符、搜 `&#x20;` 命中同一区间 → Ctrl+Shift+F 的 ordinal 与 raw 逐行扫描对齐,点击结果能定位并触发实体源码态(见 [工作区搜索](./workspace-search.md))。只覆盖字面量一部分的查询(如 `x20`)夹到整个实体区间,不产零宽 match;CM6 文档即原始 markdown,只需原文一份,无此分支。**面板内命中也显示字面量**:Ctrl+F 打开期间 charRef 插件不改 doc,改由 `collectFindMatchDecorations` 按 match × segment 生成 `.velo-char-ref-inline` 装饰(未命中的实体不展开),所以「搜 `&#x20;` 只看到一个高亮空格」不再出现;关闭面板后 `clearHighlight` 的 `recheckCharRefReveal` 把选区所在实体切成常规源码态(光标移出即还原)

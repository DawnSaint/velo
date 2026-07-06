# Find / Replace

> **本文件负责**: Ctrl+F / Ctrl+H 的浮层 UI、用户意图保存、PM/CM6 双后端、替换与高亮语义。
>
> **何时阅读**: 改 `components/ProseMirrorEditor/findreplace/*`、搜索选区定位、替换行为或 mermaid 源码搜索定位时。
>
> **先记住**:
> - `FindReplace.vue` 只经 `FindReplaceBackend` 抽象驱动，不直接依赖 PM/CM6 API。
> - query/选项/替换文/showReplace 是用户意图，上提到 App.vue；matches/currentIndex 是模式相关状态。
> - `replaceAll` 倒序遍历 matches，避免前面的替换污染后续坐标。
> - PM 命中隐藏 mermaid 源码时，setSelection 与 scrollMatchIntoView 之间靠 WeakMap 传递“刚展开”事实。
>
> **相关文件**: [架构索引](../ARCHITECTURE.md) / [编辑器](./editor.md) / [工作区搜索](./workspace-search.md)


## 设计要点

- **PM 后端 `setSelection → scrollMatchIntoView` 跨方法标记(WeakMap)**: mermaid 源码 display:none 切到 block + widget 重建会让 layout 抖,scrollMatchIntoView 必须 rAF 等下一帧再 `coordsAtPos`,否则跨文件搜索冷启动会偏(同文件 Ctrl+F 多半撞上已展开 mermaid,layout 立刻稳,所以一直没暴露)。helper `ensureMermaidSourceVisibleAt` 是幂等的,串联调用第二次必返 false,**不能**在 scrollMatchIntoView 里靠"再调 helper 当信号"判要不要 rAF —— 等于把"刚展开"的事实丢了。正确做法:setSelection 展开时往 `WeakMap<EditorView, boolean>` 写 true,scrollMatchIntoView 读取并立即 delete;没标记时才再调一次 helper 兜底(测试 / 直接调 scrollMatchIntoView 的场景)。这是 setSelection 与 scrollMatchIntoView 的隐性契约,改任一方法都要保留
- **查找替换双后端 (PM / CM6 共用)**: `FindReplace.vue` 经 `FindReplaceBackend` 抽象驱动,`createPmBackend`/`createCmBackend` 两份实现,`v-if/v-else` 互斥同一时刻一份活着。**用户意图(query/选项/替换文/showReplace)上提到 App.vue `provide(findIntentKey)`**,切模式时意图在 App.vue 存活 → query 跨模式保留;`matches`/`currentIndex` 模式相关,新挂载时 recompute。`replaceAll` 编辑器无关化:倒序遍历 matches,每个 `getRangeText` → `replaceInText`(全局正则在 match 子串重跑)→ `replaceRange`,逆序避免位置错位。两后端语义差异各自符合该模式所见文本(PM 走 prose 文本不跨块;CM6 在原始 markdown 全串含 `**`/`|`/`[]()` 可跨行);highlight PM 走 PM plugin setMeta、CM6 走 StateField + effect(镜像 PM 侧)。高亮 CSS `.velo-find-match`/`.velo-find-current` 全局共用
- **`replaceRange` 空 replacement 走 `tr.delete` 兜底(replacement=' ' 删 match 的 PM 坑)**: PM `schema.text('')` 直接抛 `RangeError('Empty text nodes are not allowed')` —— ProseMirror 不允许构造空 text 节点(无论是否带 mark),所以「替换为」空串的"删 match"场景在 PM 侧会整条链爆掉,表现为「替换 / 全部替换」点下去没反应。修法在 PM 后端 `replaceRange`:newText 为空时改走 `tr.delete(from, to)`(光标停在 from,后续 findNext 拿到的 cursorPos = from + 0 与 length=0 一致);CM6 `changes.insert=''` 没限制、正常 work。两边契约分叉但语义对齐 —— 都是"区间消失、光标停在原 from"。后续若新增文本替换路径(比如"插入到光标"),同样要在 entry 处判空再选 replaceWith / delete

# 段落拖拽重排（hover gutter 拽手）调研

> **性质**：pre-implementation 设计研究，候选方案尚未拍板。后续若决定实现，重大取舍进 `DECISIONS.md` ADR，最终架构同步 `ARCHITECTURE.md`。
> **对应 ROADMAP**：段落拖拽重排（hover gutter 拽手）
> **调研日期**：2026-07-04。
> **当前状态**：初版调研完成；待 PoC 验证后再决定是否投入全量。

---

## 1. 功能定义

**块级拖拽重排**：以整个文档结构单元（段落、标题、列表、图片、代码块等 PM `node`）为鼠标拖拽原子单位，调整它们在文档中的顺序。与纯文本编辑器（拖拽选中字符串）或桌面文件管理器（拖拽图标）不同，块级拖拽以整个文档结构单元为单位。

关键特征：
- **原子性**：拖拽的最小单位是 Node（PM schema 里的 node），不能只拖段落的某几个字
- **结构保留**：拖进去的节点在 doc 树里的身份不变（同一 Node 引用）
- **位置语义**：结果是新 doc 树 + slice 内容在新位置 re-render

**hover gutter handle** 交互流：
1. 鼠标 hover 某个块 → **主内容区左侧 gutter 区域**出现 `⋮⋮`（六点 / grip / dragger）图标
2. 光标移动到图标上 → 变成 `grab` / `grabbing`
3. 按住 → 拖拽 → 释放 → 块插入新位置

gutter 类似代码编辑器的"行号区"——hover 才出现是为了不让常驻 chrome 让文档看起来 cluttered。与之对比，Typora 早期用常驻 handle，被用户吐槽视觉噪音。

---

## 2. 主流编辑器实现情况

| 编辑器 | 是否支持 | 手柄形式 | 位置 | 跨嵌套层级 | 视觉反馈 |
|---|---|---|---|---|---|
| **Notion** | ✅ | `⋮⋮` / `⠿` | 左 gutter, hover 出现 | ✅（列表、toggle、子树） | 蓝色 drop indicator line + 源块半透明 |
| **Craft** | ✅ | `⋮⋮` | 左, hover 出现, 新板常驻 | ✅ | 蓝线; 手柄不隐藏 |
| **Logseq** | ✅ | `⠿` | bullet 左侧, hover | ✅ DAG 树感知 | 蓝色高亮 |
| **Typora** | ✅ | `⋮⋮` | 左 gutter, hover | ✅ 列表项 | 插入位 drop line |
| **Obsidian** | ❌ 原生不支持 | — | 仅 Library 整文件拖拽 | 社区插件 Various Complements | — |
| **iA Writer** | ❌ | — | — | ✅ 仅 `⌘+⌥+↑/↓` 快捷键 | — |
| **Bear** | ❌ | — | — | ✅ 仅快捷键 | — |
| **BlockNote** | ✅ | Grip + `+` | 左 gutter, hover | ✅ 子块跟着动 | Dropline |
| **Lexical** | ✅ 官方 playground | Grip | 左, hover | ✅ | 蓝线 dropline |
| **TipTap** | ✅ Pro 扩展 `@tiptap-pro/extension-drag-handle` | Grip + `+` | 左 gutter, hover | ✅ 嵌套 / 列表 / callout | 蓝线 |
| **Plate (Slate)** | ✅ `@udecode/plate-dnd` | Grip | hover | ✅ | 蓝线 + 源半透明 |

**行业趋势**：hover 出现 + 六点 grip + 蓝线 dropline 是事实标准（Notion、Linear、Craft 一致）。最大差异在**嵌套树**处理上：有些只能同层重排（Typora），有些支持跨级（Notion、Logseq、BlockNote、Lexical）。

---

## 3. UX 最佳实践

### 3.1 手柄触发方式

| 方式 | 优点 | 缺点 |
|---|---|---|
| **Hover + delay 出现** (Notion、BlockNote) | 不 clutter；发现性强（hover 把意图外化） | 需要设计合理的出现延迟（100-300ms）防 flutter；touch 设备需要 long-press |
| **常驻 Grip**（老版 Typora、Slate Plate 默认） | 发现性最高 | 视觉噪音大，复杂文档眼花 |
| **Mouse down on block left margin 即触发**（iA Writer 类） | 无需找 handle | 与文本选择冲突 |

**实践建议**：Hover + 100–300ms 延迟出现 + 只在 hover 在 block 左 12-20px gutter 区才出现。用 `pointerenter` + 单次 `setTimeout` 而非 `mouseover` 来避免 child 元素触发的 flutter。

### 3.2 拖拽时视觉反馈

Triple-feedback 模式（三信号重叠）：
1. **源块半透明 / dim**（opacity 0.5） – 告诉用户"这是被移动的那个"
2. **Dropline indicator**（蓝色横线） – 告诉用户"块会被插在这两个块之间"
3. **Drop target block 高亮 / 边框 highlight** – 当插入到嵌套容器（比如列表项后）时，边界要清楚

Dropline 工程要点：
- 插入位置精度要落在**两个 block 之间**（block-boundary），不要落到 block 中间
- 渲染为 `position: absolute` 的 `<div>` 内嵌于 editor view DOM，`z-index` 足够高
- 颜色：品牌蓝（Notion #2383E2、Linear purple/blue 渐变）
- 宽度 2px，左右出 block 边界 4-8px

### 3.3 嵌套块处理

- **子块跟随父块**：拖拽 list_item 时，所有 children 跟着走——这是 slice 语义保证的
- **嵌套层级感知**：drop 时看 mouse X 坐标相对 block 左边距，判断要嵌进几级
- **不允许跨 schema 边界插入**：比如不能把 paragraph 拖到 table_cell 外面（schema 验证）
- **List item 降级警示**：从 list_item 拖到 list 外面时，PM 会自动 schema 检查失败（list_item 的 content 要求 bullet_list 包裹） → 需要 `tr.setNodeMarkup` 转成 paragraph 再插入，或干脆拒绝 drop

### 3.4 与文本选择、选区拖拽的冲突

这是 ProseMirror 体系里最大的工程难点：

**冲突源**：ProseMirror 默认行为：
- `view.dom` 上 mousedown 后 mousemove → 启动文本选择
- draggable + dragstart → OS-level DnD

如果 handle 是 block DOM 的一部分（contentDOM child），按住 handle 会被 PM 解释成"在块内选文本"。

**业界解法**：
1. **Handle 放在 contentDOM 外**（Decoration.widget / Portal overlay），完全与 PM 文本流解耦。BlockNote、Lexical、TipTap Pro drag handle 都用这方案。好处：mousedown 在 handle 上时 PM 不会 selection 进入；坏处：定位要自己算。
2. **Handle 在 contentDOM 内但 `draggable=true` + `dragstart` 拦截 + `stopPropagation`**：优点 crisp，缺点阻止 normal text selection 当用户在 handle 隔壁开始 drag-select 时。
3. **两段触发**：mousedown 在 block 左侧 16px gutter 区才处理成 drag；其他区域走 PM 默认选择行为。

**推荐组合**：Decoration.widget (absolute overlay) + mousedown 自处理（不用 HTML5 DnD API），因为 HTML5 DnD 在 PM 里有 selection race 和跨 view focus-loss 的已知坑。

---

## 4. ProseMirror 生态实现参考

### 4.1 官方示例

- **ProseMirror 官方 drag 示例**：<https://prosemirror.net/examples/drag/>
- 只做"外部源 → 编辑器"的插入，**不含"行内块拖拽重排"**，也没有可见的 drag handle。是"最小可行"参考起点，不是生产级方案。

### 4.2 第三方库

| 库 | 作用 | 能直接用吗？ |
|---|---|---|
| `prosemirror-dropcursor` | 拖拽时画线，不改文档（DecorationSet） | ❌ 仅 decorations，不负责 move |
| `prosemirror-drag-drop` | 修正默认 drop 偏移 | ❌ 辅助 |
| `prosemirror-draggable-node` | 给任意 block 挂 draggable + plugin | ⚠️ 社区最小可用 |
| `@tiptap-pro/extension-drag-handle` | floating-ui 拖拽手柄，最成熟 | ❌ 引入整个 Tiptap 抽象层过重 |

### 4.3 真实工程参考

- **Zotero note-editor**（[deepwiki 参考](https://deepwiki.com/zotero/note-editor/7.5-drag-and-drop-for-blocks)）：最完整的 PM 原生块级 DnD；手柄 24×24 SVG `position: absolute`，`:before` 伪元素做 64px 不可见热区；`dragstart` 转 `NodeSelection` + `serializeForClipboard` 写 `dataTransfer`；`drop` 用 `dropPoint()` 解析落点并执行 move tr；50ms 节流。
- **Novel Editor**（Tiptap 封装）：CSS `:hover` bullet/⋮⋮，`tr.insert(pos, removedNode)` + `tr.delete(from, to)`。

### 4.4 推荐方案（PM 原生）

```
全局 Plugin（状态 + 事件 + Transaction）
├─ handleDOMEvents: dragstart / dragover / drop
├─ Decoration.widget(pos, makeHandle, {side: -1, stopEvent: ()=>true})
└─ prosemirror-dropcursor（画蓝线）
```

关键 API：
- `view.posAtCoords({left, top})` 像素→文档 pos
- `doc.resolve(pos)` → `ResolvedPos`，`$pos.start(depth)`/`end(depth)`/`before(depth)`/`after(depth)` 取块边界
- `doc.slice(from, to)` 取闭 Slice
- `tr.move(from, to)` 单步移动 **或** `tr.replaceWith` + `tr.insert`（注意先删后插的 pos 偏移）
- `setDragImage` 替换 PM 默认拖影
- `view.dragging = { slice, move: true }` 标记内部拖拽

### 4.5 需要避开的坑

1. ❌ 不要用 `vuedraggable` / SortableJS 直接接管 PM 子元素（幽灵 DOM 坑）
2. ❌ 不要用 `editorView.dom.addEventListener`（跟 PM 内部事件调度冲突，见 issue #1572）
3. ❌ 不要用 `tr.insertText` 做块级移动
4. ❌ 不要只用 NodeView 做跨节点拖拽（拖出边界就丢失）
5. ⚠️ Tauri 必须设 `dragDropEnabled: false`，否则 webview 吃掉 drag 事件
6. ⚠️ 先删后插时注意 pos 偏移（中间 tr 会改变索引）
7. ⚠️ `dragover` 必须 `preventDefault` 否则 `drop` 不会触发

---

## 5. Velo 实现复杂度评估

### 5.1 与现有架构的一致性 — 高

schema 不需要改（同 morph、list、嵌套走现有 schema 约束），不动 markdownIO。Decoration.widget 与现有 fold / mermaid / toc、line-number 完全同族范式。根据架构文档沉淀过的"mermaid 走 Decoration.widget 不走 NodeView"、"TOC 走 Decoration.widget"的决策，**block handle 也应走 Decoration.widget，不要造 NodeView**。

```ts
Decoration.widget(pos + 1, makeHandle, {
  side: -1,
  ignoreSelection: true,
  stopEvent: () => true,   // 不让 PM 接管事件进入 selection
})
```

配合 SCSS `position:absolute; left:-28px; top:..;` 与 fold chevron 同形。

### 5.2 底层基础设施 — 中等完备

- `dropCursorPlugin` 已在 `allPlugins` ✓
- `handleDOMEvents` 范式在 `imageUploadPlugin.ts` 验证 ✓
- ResizeObserver / widget 同步机制在 `lineNumber Plugin` 验证 ✓
- 折叠展开 `ensureFoldExpandedAt` 幂等接口已有 ✓
- **缺**的是 block pickup + 列表语义 + 折叠区段三个模块

### 5.3 单点风险

| 风险点 | 说明 |
|---|---|
| **fold chevron 像素竞争** | 手柄 ⋮⋮ 和折叠 chevron 都在左侧 gutter，需要共享 gutter 或错开位置 |
| **列表 cross-list 搬移** | `list_item → list_item` 跨 list 搬移时 `DropError` 要处理；`list_item` 拖出 list 边界要转 paragraph |
| **imageUpload drop 的 MIME 握手** | 外部 drop 内部 drop 共用一个 drop 入口时要区分 MIME |
| **折叠块 coordsAtPos** | `coordsAtPos` 在 `display:none` block 上返回 `(0,0)`，必须先展开所有 fold |
| **原子节点 widget 不跟 slice** | mermaid SVG widget 和 codeLineNumber 是 side:-1 decoration，不跟 slice 走，drag 期间必须暂停 rebuild |

### 5.4 推荐状态机（对齐 FoldDecoration、markSourceEdit 范式）

```ts
state = {
  draggingBlockStart: number | null,
  draggingBlockEnd:   number | null,
  dragSession: 'idle' | 'pending' | 'dragging' | 'animating',
  hoveredBlock:       number | null,
  mode:               'move' | 'copy',   // Shift 键可选
}
```

**关键约束**：不要 live drag（拖时源块不动），pointermove 只画 dropline，pointerup 一次性 dispatch delete+insert 单 transaction。分两次 dispatch 会让 widget 引用的旧 pos 全错 1–2。Esc 监听 keymap cancel；drop 出 `view.dom` 外接 `document.dragend` 兜底 cancel（与 `FileTree.vue` 同范式）。

### 5.5 集成面评估

涉及的 block 类型 ≥ 13 种，要兼容的既有机制 ≥ 7 套（fold、mermaid、lineNumber、imageUpload、findHighlight、gapCursor、dropcursor）。

---

## 6. 综合结论

| 维度 | 评级 | 备注 |
|---|---|---|
| 与现有架构一致性 | **高** | 复用 fold / lineNumber / toc Decoration.widget 范式 |
| 底层基础设施 | **中等完备** | dropCursor + handleDOMEvents + ResizeObserver 已有；缺 3 个新模块 |
| 单点风险 | **中偏高** | 3 处工程难点（列表语义、fold 展开、widget 暂停） |
| 整体复杂度 | **中偏高** | 插件 500–800 行 TS + 200 行 SCSS，但集成面太广，测试矩阵爆炸 |

**建议先做 PoC**：先单独抽 `BlockDragHandle.ts` 做"仅 paragraph 之间"的简单 case（跳过 list / fold / 跨区段），把状态机 + drop preview overlay + 鼠标事件三条流水线跑通再扩到列表语义。3–4 天时间可完成 PoC 验证最难的几何同步 + drop preview 可行性，再决定是否投入全量。

PoC 跑通后再补足：列表 nested 搬移、折叠块展开、与 imageUpload 共 drop 入口的 MIME 握手、Shift-copy 模式、触屏 long-press。

---

## 7. Sources

- [ProseMirror 官方 Drag 示例](https://prosemirror.net/examples/drag/)
- [prosemirror-dropcursor (npm)](https://www.npmjs.com/package/prosemirror-dropcursor)
- [prosemirror-dropcursor (GitHub)](https://github.com/prosemirror/prosemirror-dropcursor)
- [prosemirror-drag-drop (GitHub)](https://github.com/prosemirror/prosemirror-drag-drop)
- [prosemirror-draggable-node (npm)](https://www.npmjs.com/package/prosemirror-draggable-node)
- [prosemirror-draggable-node (GitHub)](https://github.com/TeemuKoivisto/prosemirror-draggable-node)
- [@tiptap/extension-drag-handle 文档](https://tiptap.dev/docs/editor/extensions/functionality/drag-handle)
- [ProseMirror issue #628 — draggable=true](https://github.com/ProseMirror/prosemirror/issues/628)
- [ProseMirror issue #1208 — dropping creates copy](https://github.com/ProseMirror/prosemirror/issues/1208)
- [ProseMirror issue #1572 — dropcursor addEventListener vs handleDOMEvents](https://code.haverbeke.berlin/prosemirror/prosemirror/issues/1572)
- [How to implement drag and drop for block node with pos](https://discuss.prosemirror.net/t/how-to-implement-drag-and-drop-for-block-node-with-pos/5349)
- [Drag and drop block node into inline content](https://discuss.prosemirror.net/t/drag-and-drop-block-node-into-inline-content/6223)
- [聂骁骏 — 如何在 Prosemirror 中实现块级节点的拖拽](https://nxjniexiao.github.io/2023/03/13/drag-and-drop-block-in-prosemirror/)
- [Dev Log: Custom drag and drop in ProseMirror](https://ventureunknown.xyz/p/dev-log-custom-drag-drop-prosemirror)
- [Zotero note-editor — Drag and Drop for Blocks](https://deepwiki.com/zotero/note-editor/7.5-drag-and-drop-for-blocks)
- [Novel Editor GitHub](https://github.com/steven-tey/novel)
- [ProseMirror posAtCoords docs](https://prosemirror.net/docs/ref/#view.EditorView.posAtCoords)
- [ProseMirror Transform API Reference](https://prosemirror.net/docs/ref/#transform.Transform)
- [ProseMirror Decoration.widget Reference](https://prosemirror.net/docs/ref/#view.Decoration.widget)
- [BlockNote GitHub (TypeCellOS/BlockNote)](https://github.com/TypeCellOS/BlockNote)
- [Lexical Draggable Block Plugin (facebook/lexical)](https://github.com/facebook/lexical/tree/main/packages/lexical-draggable-block-plugin)
- [Slate.js Plate DnD 插件](https://github.com/udecode/plate)
- [dnd-kit (React DnD 库)](https://dnd-kit.com)
- [react-beautiful-dnd (Atlassian)](https://github.com/atlassian/react-beautiful-dnd)

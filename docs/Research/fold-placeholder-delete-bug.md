# 折叠占位符删除吞字符 + 编辑器未感知变更 —— 排查调研

> **性质**：pre-implementation 问题排查记录，根因尚未确认，修复方案待定。
> **对应模块**：`src/components/ProseMirrorEditor/nodes/FoldDecoration.ts` — `foldDeleteCommand`
> **调研日期**：2026-07-19。
> **当前状态**：排查中。已排除若干假设，剩余怀疑方向见第 5 节。

---

## 1. 问题描述

### 1.1 用户报告的现象

文档结构（已保存的 .md 文件，非新建）：

```markdown
1232

### Head

content
```

操作步骤：
1. 点击折叠 `### Head` → heading 末尾出现 `...` 占位符（`fold_placeholder` 真实节点）
2. 鼠标拖选 `Head` 文本 + `...` 占位符
3. 按 Backspace

**预期**：`Head` + 折叠的 `content` 一起删除，`1232` 完整保留。

**实际**：
- `1232` 末尾被吞掉一个字符 → 变成 `123`
- `Head` 和折叠内容被删除
- **编辑器没有感知到变更**（dirty 标记未出现 / 切换源代码模式发现内容还在）

### 1.2 关键复现条件

| 条件 | 能否复现 |
|------|---------|
| **已保存的 .md 文档** | ✅ 能复现 |
| **新建文档手动输入相同内容** | ❌ 不能复现，删除正常 |
| jsdom 单元测试模拟 | ❌ 不能复现（PM selection 由代码直接设置，不存在浏览器偏移） |

**"只有已保存文档能复现"是最关键的线索**，说明问题与文档加载路径（`loadContentInto` 的 canonical 规范化）或由此产生的 DOM 结构差异有关。

### 1.3 涉及的代码路径

```
用户按 Backspace
  → keymap 链（EditorInner.vue allPlugins）
    → foldDeleteCommand（链首，检查选区是否覆盖 fold_placeholder）
    → frontmatterBackspaceCommand
    → codeBlockBackspaceCommand
    → headingToParagraph
    → baseKeymap['Backspace']（deleteSelection + joinBackward）
```

`foldDeleteCommand` 如果返回 `true`，后续命令不执行；如果返回 `false`，fall through 到 `baseKeymap['Backspace']`。

---

## 2. 数据流分析

### 2.1 内容回写链路

```
PM dispatchTransaction(tr)
  → view.state.apply(tr)          // 应用 tr + appendTransaction
  → view.updateState(next)
  → if (tr.docChanged && !tr.getMeta(SKIP_CONTENT_EMIT))
      → opts.onChange(next.doc)   // useProseMirror.ts
        → EditorInner.vue emit('update:modelValue', toMarkdown(doc))
          → App.vue @update:model-value="documentStore.setContent"
            → d.content = v       // documentStore 更新
              → dirty = (content !== lastSavedContent)
```

**"编辑器没有感知到变更"** 意味着以下之一：
- (A) `tr.docChanged === false` — transaction 没有改变 doc
- (B) `tr.getMeta(SKIP_CONTENT_EMIT) === true` — transaction 被标记跳过回写
- (C) `foldDeleteCommand` 返回 `false`，没有 dispatch 任何 tr，浏览器原生 Backspace 执行了 DOM 删除

### 2.2 已保存文档加载路径

`documentStore.loadContentInto`（`src/stores/document.ts`）：

```typescript
const canonical = toMarkdown(fromMarkdown(c, pmSchema))
d.content = canonical
d.lastSavedContent = canonical
```

磁盘内容经过 `fromMarkdown → toMarkdown` 规范化后灌入 `content` 和 `lastSavedContent`。

EditorInner.vue 的 `modelValue` watch：

```typescript
const doc = fromMarkdown(newVal, schema)
view.updateState(EditorState.create({ schema, doc, plugins: allPlugins, ... }))
```

**新建文档**则是从空字符串 `''` 开始，用户手动输入内容，doc 结构由 PM inputRules / Enter 处理产生。

两者 doc 结构可能有微妙差异（trailing break / 空段落 / 文本节点拆分方式），导致 DOM 渲染和选区行为不同。

---

## 3. `fold_placeholder` 节点分析

### 3.1 Schema 定义

```typescript
// src/components/ProseMirrorEditor/editor/schema.ts
fold_placeholder: {
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,
  marks: '',
  toDOM: () => ['span', {
    'data-type': 'fold-placeholder',
    class: 'velo-fold-placeholder',
    contenteditable: 'false'   // ← 关键
  }, '...'],
}
```

`fold_placeholder` 是 `contenteditable="false"` 的 inline atom 节点，与 image 节点同类型。

### 3.2 Chrome/WebView2 的 addTextblockHacks 行为

根据 `docs/architecture/editor.md` 中 image 的踩坑记录：

> image 是 inline atom 但 NodeView `display:block`，当图片是段落末子时，PM 的 `addTextblockHacks`（prosemirror-view `viewdesc.ts`）规则"末子非 `TextViewDesc` 即补 `<br class="ProseMirror-trailingBreak">`"命中。**Chrome/Safari/WebView2 上还会额外补一个零宽 `<img class="ProseMirror-separator">`**（因末子 `contentEditable == "false"`）。

`fold_placeholder` 同样是 `contenteditable="false"` 的 inline atom。当它作为 heading 的末子时（折叠后 heading 内容 = `text("head") + fold_placeholder`），PM 会：
1. 补 `<br class="ProseMirror-trailingBreak">`
2. **Chrome/WebView2 额外补零宽 `<img class="ProseMirror-separator">`**

DOM 结构：
```html
<h3>
  <button class="velo-fold-toggle">▼</button>
  head
  <span class="velo-fold-placeholder" contenteditable="false">...</span>
  <img class="ProseMirror-separator">     <!-- Chrome/WebView2 额外补 -->
  <br class="ProseMirror-trailingBreak">  <!-- PM 补 -->
</h3>
```

**image 有 SCSS 隐藏这些元素，但 `fold_placeholder` 没有**：

```scss
// _editor-image.scss — image 有这两条规则
.velo-image-inline + .ProseMirror-trailingBreak,
.velo-image-inline + .ProseMirror-separator + .ProseMirror-trailingBreak {
  display: none;
}

// _editor-fold.scss — fold_placeholder 没有对应规则！
```

### 3.3 可能的影响

这些额外的 separator / trailingBreak DOM 元素可能干扰浏览器的选区行为：
- 用户拖选 "head" + "..." 时，DOM selection 的边界可能落在 separator/trailingBreak 上
- PM 的 `selectionObserver` → `readDOMChange` 把 DOM selection 映射到 PM selection 时，可能产生与预期不同的范围
- 如果 PM selection 没有正确覆盖 `fold_placeholder`，`foldDeleteCommand` 的 `nodesBetween` 扫不到它 → 返回 `false` → fall through 到 `baseKeymap['Backspace']` 或浏览器原生删除

**但此假设无法解释"只有已保存文档能复现"** — 新建文档折叠后 heading 末子同样是 `fold_placeholder`，separator/trailingBreak 应该同样存在。除非已保存文档的 DOM 结构有其他差异。

---

## 4. 已排除的假设

### 4.1 ❌ `SKIP_CONTENT_EMIT` 被误设置

`foldDeleteCommand` dispatch 的 `tr` **没有**设置 `SKIP_CONTENT_EMIT` meta。`appendTransaction` 产生的 `nodeSync` tr 也没有。grep 确认 `FoldDecoration.ts` 中不出现 `SKIP_CONTENT_EMIT`。

`SKIP_CONTENT_EMIT` 只在以下场景使用（`markSourceEdit` / `linkClick` / `htmlSourceEdit` / `imageEditPlugin` 的 trigger 事务），与折叠删除无关。

### 4.2 ❌ `tr.docChanged === false`

`foldDeleteCommand` 执行 `tr.delete(deleteFrom, deleteEnd)`，只要 `deleteFrom < deleteEnd`，`tr.docChanged` 必为 `true`。除非 `deleteFrom === deleteEnd`（空删除），但这在选区覆盖 fold_placeholder 的场景下不太可能。

### 4.3 ❌ `appendTransaction` 产生额外 tr 吞掉了变更

`appendTransaction` 的 `nodeSync` tr 设置了 `addToHistory: false`，但没有设置 `SKIP_CONTENT_EMIT`。而且 `useProseMirror.ts` 的 `dispatchTransaction` 检查的是**原始 tr** 的 `docChanged`，不是 apply 后的最终结果。所以即使 appendTransaction 产生了额外 tr，原始 tr 的 `docChanged` 仍为 `true`，onChange 仍会触发。

### 4.4 ❌ jsdom 单元测试能复现

jsdom 下无法复现，因为 PM selection 由测试代码直接 `TextSelection.create` 设置，不存在浏览器 DOM selection → PM selection 的同步偏移问题。PROBE 测试显示 `foldDeleteCommand` 在各种 selection 下都能正确 dispatch `tr.delete` 且 `docChanged === true`。

### 4.5 ❌ 已保存文档的 fold 状态恢复导致问题

用户明确说"点击折叠head"——是手动折叠，不是 `initCollapsed` 恢复。`foldStore.getKeysFor(path)` 对新建文档（path=null）返回空数组，对已保存文档可能有恢复的 key，但用户是手动点击折叠，不受此影响。

### 4.6 ❌ `loadContentInto` 的 canonical 规范化导致 doc 结构根本性不同

canonical 规范化 `toMarkdown(fromMarkdown(c))` 主要影响多空行 / HTML inline 等 round-trip 不稳定的语法。对于 `1232\n\n### head\n\ncontent` 这种简单内容，canonical 与原文基本一致，doc 结构不会有根本性差异。

---

## 5. 剩余怀疑方向

### 5.1 🔬 浏览器 DOM selection → PM selection 的映射偏移（最可能）

**核心假设**：在真实 Chrome/WebView2 中，用户拖选 "head" + "..." 时，由于 `fold_placeholder` 是 `contenteditable="false"` 的 atom，浏览器产生的 DOM selection 与 PM 期望的 selection 不一致。PM 的 `selectionObserver` → `readDOMChange` 把 DOM selection 映射到 PM selection 时，`sel.from` 可能偏移到上一段（"1232" 内部）。

如果 `sel.from` 偏移到上一段：
1. `foldDeleteCommand` 的 `nodesBetween(sel.from, sel.to)` 可能扫不到 `fold_placeholder`（如果 `sel.from` 在 fold_placeholder 之前很远）→ 返回 `false`
2. 或者扫到了 fold_placeholder，但 `deleteFrom = sel.from`（偏移到上一段）→ `tr.delete(sel.from, range[1])` 吞掉了上一段末尾字符

**当前代码的缺陷**（`FoldDecoration.ts` 第 978 行）：
```typescript
if (nodeStart < deleteFrom) deleteFrom = nodeStart
// 只在 nodeStart 更小时才扩展 deleteFrom
// 如果 sel.from 偏移到上一段（比 nodeStart 更小），此条件不成立
// deleteFrom 维持在错误的 sel.from 位置
```

**为什么"只有已保存文档能复现"**：可能是因为已保存文档经过 `view.updateState(EditorState.create({...}))` 加载（modelValue watch 触发），而新建文档是从空文档开始用户手动输入。两种路径产生的 DOM 结构（特别是 PM 的 ViewDesc 树）可能有微妙差异，导致浏览器选区行为不同。

**验证方法**：在真实浏览器中用 DevTools 打断点，检查 Backspace 触发时 `view.state.selection` 的 `from` / `to` 值。

### 5.2 🔬 separator / trailingBreak 干扰选区（次可能）

`fold_placeholder` 作为 heading 末子时，Chrome/WebView2 补的 `<img class="ProseMirror-separator">` 和 `<br class="ProseMirror-trailingBreak">` 可能干扰选区边界。

**验证方法**：在真实浏览器 DevTools 中检查折叠后 heading 的 DOM 结构，确认 separator/trailingBreak 是否存在。如果存在，添加 SCSS `display: none` 规则（同 image 范式）后再测试。

### 5.3 🔬 浏览器原生 Backspace 绕过 PM keymap（待确认）

如果 `foldDeleteCommand` 返回 `false`（因为 PM selection 没有覆盖 fold_placeholder），且 `baseKeymap['Backspace']` 也因为某种原因没有正确处理，浏览器可能执行原生 Backspace。浏览器原生删除只改 DOM，PM 的 DOMObserver 会尝试反向解析，但可能解析失败或部分解析，导致 doc 不变或部分变化。

**验证方法**：在 `useProseMirror.ts` 的 `dispatchTransaction` 中打日志，确认 Backspace 时是否有 tr 被 dispatch。如果没有任何 tr，说明 PM keymap 全部返回 false，浏览器原生 Backspace 执行了。

### 5.4 🔬 已保存文档 vs 新建文档的 ViewDesc 树差异

已保存文档通过 `view.updateState(EditorState.create({...}))` 一次性加载，新建文档从空文档开始用户逐字输入。两种路径产生的 PM ViewDesc 树（`prosemirror-view` 内部数据结构）可能有差异，影响 `addTextblockHacks` 的行为和选区映射。

**验证方法**：在真实浏览器中对两种文档分别检查折叠后 heading 的完整 DOM 结构（含 separator/trailingBreak），对比差异。

---

## 6. 尝试过的修复（未生效）

### 6.1 修复 `foldDeleteCommand` 的 `deleteFrom` 逻辑

**改动**：将 `if (nodeStart < deleteFrom) deleteFrom = nodeStart` 改为首次命中 fold_placeholder 时无条件 `deleteFrom = nodeStart`。

**结果**：jsdom 测试通过，但用户反馈真实浏览器上未修复。说明问题不在 `deleteFrom` 的计算逻辑，而在更上游 — `foldDeleteCommand` 可能根本没有被执行（返回 `false`），或者 PM selection 与预期完全不同。

### 6.2 添加 SCSS 隐藏 separator/trailingBreak

**改动**：在 `_editor-fold.scss` 中添加：
```scss
.velo-fold-placeholder + .ProseMirror-trailingBreak,
.velo-fold-placeholder + .ProseMirror-separator + .ProseMirror-trailingBreak {
  display: none;
}
```

**结果**：用户反馈未修复。CSS `display: none` 可能不足以消除选区偏移（separator 是零宽的，trailingBreak 在隐藏后可能仍有选区行为），或者 separator/trailingBreak 不是根因。

### 6.3 添加路径 (a) 空选区 / 恰好覆盖 fold_placeholder 的折叠删除

**改动**：新增 `findPlaceholderFold` 函数 + 路径 (a)，处理空选区光标停在 `...` 之后、选区恰好覆盖 `...` 两条路径。

**结果**：jsdom 测试通过，但用户反馈真实浏览器上未修复。说明真实浏览器的 PM selection 既不是空选区，也不是恰好覆盖 fold_placeholder，而是某种其他范围。

---

## 7. 下一步排查建议

### 7.1 在真实浏览器中采集 PM selection 快照

在 `useProseMirror.ts` 的 `dispatchTransaction` 入口添加临时日志：

```typescript
dispatchTransaction(tr) {
  console.log('[fold-debug] tr.docChanged:', tr.docChanged,
               'sel:', tr.selection.from, tr.selection.to,
               'meta keys:', Object.keys(tr.meta || {}))
  // ...
}
```

同时在 `foldDeleteCommand` 入口添加日志：

```typescript
export function foldDeleteCommand(state, dispatch) {
  const sel = state.selection
  console.log('[fold-debug] foldDeleteCommand sel:', sel.from, sel.to, 'empty:', sel.empty)
  // ...
}
```

让用户在已保存文档上复现问题，收集 Backspace 时的 selection 值和 foldDeleteCommand 是否被调用。

### 7.2 检查 Backspace 时是否有 tr 被 dispatch

如果 `dispatchTransaction` 日志没有输出，说明 PM keymap 全部返回 `false`，浏览器原生 Backspace 执行了。此时需要在 keymap 链的每个命令中添加日志，确认哪个命令返回了 `false`。

### 7.3 对比已保存文档 vs 新建文档的 DOM 结构

在真实浏览器 DevTools 中，对两种文档分别折叠 head 后，检查 heading 元素的完整 DOM（含子元素、separator、trailingBreak）。对比两者是否有差异。

### 7.4 考虑换实现方式

如果根因确认是 `contenteditable="false"` atom 节点的选区问题，可以考虑：

**方案 A：回到 Decoration.widget + 智能删除检测**
- `...` 用 `Decoration.widget`（`side: 0`，光标可停两侧）
- `foldDeleteCommand` 不再依赖 doc 中的 fold_placeholder 节点，而是检查选区是否覆盖了 `collapsedSet` 中的折叠点位置
- 选区覆盖折叠点时（光标从 heading 内部延伸到折叠区段），扩展删除范围
- 代价：widget 无法被 TextSelection "选中"，但可以通过 `Decoration.node` 高亮模拟选中效果

**方案 B：用 `content: 'text*'` 的非 atom 节点**
- `...` 是可编辑文本节点（PM 接管），光标自然进入，选区自然覆盖
- 通过 `handleTextInput` / `beforeinput` 阻止用户编辑 `...` 文本
- 代价：实现复杂，需要防止用户修改占位符文本

**方案 C：保持 atom 节点 + 添加 `handleKeyDown` / `handleTextInput` 拦截**
- 参考 `imageEditPlugin` 的两道闸：`handleKeyDown` 吞可打印字符，`handleTextInput` 兜底
- 但 Backspace/Delete 不吞（需要正常删除），所以此方案可能不适用

---

## 8. 关键文件索引

| 文件 | 相关内容 |
|------|---------|
| `src/components/ProseMirrorEditor/nodes/FoldDecoration.ts` | `foldDeleteCommand`（第 953 行）、`appendTransaction`（第 738 行）、`buildDecorations`（第 450 行） |
| `src/components/ProseMirrorEditor/editor/schema.ts` | `fold_placeholder` schema 定义（第 258 行） |
| `src/components/ProseMirrorEditor/composables/useProseMirror.ts` | `dispatchTransaction` + onChange 触发逻辑（第 137 行） |
| `src/stores/document.ts` | `loadContentInto` canonical 规范化（第 354 行）、`setContent`（第 332 行） |
| `src/components/ProseMirrorEditor/EditorInner.vue` | `modelValue` watch → `view.updateState`（第 629 行）、keymap 链组装 |
| `src/styles/_editor-fold.scss` | `fold_placeholder` 样式（第 138 行），缺少 separator/trailingBreak 隐藏规则 |
| `src/styles/_editor-image.scss` | image 的 separator/trailingBreak 隐藏规则（第 166 行，参照范式） |
| `docs/architecture/editor.md` | image 的 trailingBreak/separator 踩坑记录（第 88 行）、fold 折叠删除说明（第 116 行） |
| `docs/DECISIONS.md` | ADR-20260717-003: fold placeholder 从 widget 改为真实节点（第 121 行） |

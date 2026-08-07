# Emoji 短码语法支持调研

> **性质**：pre-implementation 设计研究，方案已拍板（方案 B：自定义 inline atom 节点），已实现。架构同步见 `docs/architecture/editor.md`。
> **对应 ROADMAP**：编辑器增强 / Emoji 短码
> **调研日期**：2026-08-07
> **当前状态**：已实现，按方案 B 落地。

---

## 一、需求定义

在 Markdown 中支持 emoji 短码（shortcode）语法：用户输入 `:smile:` 自动渲染为 😄、`:rocket:` 渲染为 🚀。这是 GitHub Flavored Markdown、Obsidian、Slack 等主流编辑器的标配功能。

**两种输入路径**：

| 路径 | 说明 | 当前状态 |
|------|------|----------|
| **直接输入 Unicode emoji** | 用户通过系统输入法（Win+.）或复制粘贴直接输入 emoji 字符 | ✅ 已天然支持（emoji 是合法的 Unicode 文本字符，ProseMirror / CodeMirror / 导出管线均无需适配） |
| **短码语法 `:shortcode:`** | 用户输入 `:smile:` 文本，编辑器自动渲染为 emoji | ❌ 不支持，本次调研目标 |

**核心约束（Velo 架构特有）**：

Velo 在加载文档时执行 canonical round-trip（`fromMarkdown(md)` → PM doc → `toMarkdown(doc)` → canonical 内容），canonical 同时写入 `content` 和 `lastSavedContent`。**短码必须在 round-trip 中保持不变**，否则 `:smile:` 会在加载时被规范化为 `😄`，导致文件内容被静默修改（下次自动保存写盘时短码消失）。

---

## 二、候选方案

### 方案 A：`remark-emoji` 文本替换（不保留短码）

**思路**：使用 [`remark-emoji`](https://github.com/rhysd/remark-emoji) 插件，在 mdast parse 阶段把 `:smile:` 文本替换为 Unicode emoji 字符。emoji 变成普通 text 节点。

**数据流**：

```
:smile:  →  remark-emoji  →  text "😄"  →  PM text "😄"
PM text "😄"  →  toMarkdown  →  "😄"  （短码丢失）
```

**涉及层**：

| # | 层 | 改动 |
|---|----|------|
| 1 | schema | 无（emoji 就是普通文本） |
| 2 | NodeView | 无 |
| 3 | remark 插件 | `.use(remarkEmoji)` |
| 4 | markdownIO | 无（text 节点天然走 inlineNodeToPM / wrapWithMarks） |
| 5 | syntax registry | 可选（如需实时键入转换） |
| 6 | PM 插件 | 无 |
| 7 | keymap | 无 |
| 8 | 测试 | round-trip 用例 |
| 9 | 导出 | 无（emoji 是文本，导出管线天然透传） |

**依赖**：`remark-emoji`（间接依赖 `node-emoji`）

**优势**：
- **最小改动量**：仅需在 `parseProcessor.ts` 加一行 `.use(remarkEmoji)`，schema / markdownIO / NodeView / 导出全不用动
- WYSIWYG、源码模式、导出三路天然一致
- 社区库成熟，`remark-emoji` 由 rhysd 维护，star 200+

**劣势**：
- **❌ 短码丢失**：`:smile:` 经 canonical round-trip 后变成 `😄`。加载含短码的文件时，`documentStore.content` 被规范化为 `😄`，下次保存写盘短码消失。用户无感知地丢失了原始写法。
- **❌ 不可逆**：Unicode emoji 字符无法反推回短码（一个 emoji 可能有多个短码别名，也可能用户是直接粘贴的 Unicode 而非短码）
- 无 NodeView 支持，无法提供 hover 显示短码名、emoji 选择器等增强 UI
- `remark-emoji` 默认开启 emoticon 转换（`:)` → 😂），过于激进，需要配置关闭

**结论**：❌ **不推荐**。Velo 的 canonical round-trip 机制决定了短码必须可逆，文本替换方案在架构层面行不通。

---

### 方案 B：自定义 inline atom 节点（保留短码）

**思路**：创建自定义 `emoji` inline atom 节点，`attrs.shortcode` 存短码名，NodeView 渲染对应的 Unicode emoji。remark 插件在 parse 阶段把 `:smile:` 文本重写为 `emoji` mdast 节点；toMarkdown 从 `emoji` 节点输出 `:smile:`。

**数据流**：

```
:smile:  →  remarkEmoji  →  emoji mdast node { shortcode: "smile" }
           →  PM emoji node { shortcode: "smile" }
           →  NodeView 查表渲染 😄

PM emoji node  →  toMarkdown  →  emoji mdast node  →  :smile:  （短码保留）
```

**涉及层**：

| # | 层 | 改动 |
|---|----|------|
| 1 | schema | 新增 `emoji` inline atom 节点 |
| 2 | NodeView | `nodes/EmojiNodeView.ts` — 查表渲染 emoji char |
| 3 | remark 插件 | `plugins/remarkEmoji.ts` — 扫描 text 节点中 `:shortcode:` 模式，重写为 `emoji` mdast 节点 |
| 4 | markdownIO | `fromMarkdown`: `emoji` mdast → PM `emoji` node；`toMarkdown`: PM `emoji` → `:shortcode:` text（用 html 节点输出防 escape） |
| 5 | syntax registry | `syntax/inline/emoji.ts` — 实时键入 `:smile:` → emoji node |
| 6 | PM 插件 | 无（NodeView 直接渲染） |
| 7 | keymap | 无 |
| 8 | 测试 | round-trip + 嵌套 + 边界用例 |
| 9 | 导出 | `htmlRenderer.ts` walker 补 `case 'emoji'` — 输出 emoji char |
| 10 | 架构文档 | `editor.md` 新增语法参照条目 |

**依赖**：`node-emoji`（提供 shortcode → Unicode 映射表，约 1800+ 条目）

**schema 定义草案**：

```typescript
emoji: {
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  marks: '',
  attrs: {
    shortcode: { default: '' },
  },
  parseDOM: [{
    tag: 'span[data-type="emoji"]',
    getAttrs: (dom: HTMLElement) => ({
      shortcode: dom.dataset.shortcode ?? '',
    }),
  }],
  toDOM: (node) => [
    'span',
    {
      'data-type': 'emoji',
      'data-shortcode': node.attrs.shortcode as string,
    },
  ],
},
```

**NodeView 草案**：

```typescript
// nodes/EmojiNodeView.ts
// 查 node-emoji 表把 shortcode 转 Unicode emoji char 渲染到 <span>。
// 不需要 contentDOM（atom 不可编辑内部），点击选中后 Backspace 整块删。
// 未来可扩展：hover tooltip 显示 :shortcode: 名、右键菜单替换 emoji。
```

**remark 插件草案**：

```typescript
// plugins/remarkEmoji.ts
// 扫描每个 inline children 数组中的 text 节点，
// 把 :shortcode: 模式切分为 text + emoji 节点 + text。
// 复用 remarkHighlight / remarkSupSub 的"单文本正则 + 跨节点状态机"范式。
// 正则：/:([\w+-]+):/g（shortcode 只允许字母/数字/下划线/连字符/加号）
// 验证：shortcode 在 node-emoji 表中存在才转换为 emoji 节点，
//       不存在则保留为纯文本（避免 `:word:` 被误吞）
```

**syntax inline 草案**：

```typescript
// syntax/inline/emoji.ts
// pattern: /:([\w+-]+):/g
// apply: 删 match 范围，插入 emoji node，shortcode = match[1]
// 复用 highlight / sup 同款 delete + insertText + addMark 范式
```

**优势**：
- **✅ 短码可逆**：round-trip `:smile:` → emoji node → `:smile:` 严格 idempotent，不触发 dirty
- WYSIWYG 显示 emoji 字符，源码模式显示 `:smile:`，与 Obsidian 行为一致
- 未来可扩展 emoji 选择器 / hover tooltip / 短码自动补全
- 与现有 `html_inline` / `image` atom 节点范式完全一致，架构一致性好

**劣势**：
- **改动量大**：需新增 schema + NodeView + remark 插件 + markdownIO 双向 + syntax + 导出 walker + 测试，涉及 8 个文件层
- 新增 `node-emoji` 依赖（~50KB gzipped，含完整 emoji 映射表）
- atom 节点不可内部编辑（用户只能删除后重新键入短码，不能"进入"节点修改短码）—— 但这与 `image` / `html_inline` 行为一致，用户已熟悉

**风险点**：
- **shortcode 表覆盖**：`node-emoji` 基于 [Unicode emoji 数据](https://github.com/omnidan/node-emoji)，覆盖 GitHub 支持的全部短码。但不包含某些平台特有短码（如 Discord 自定义表情）。MVP 够用。
- **`:` 冲突**：Markdown 中 `:` 可出现在时间 `12:30`、键值对 `key: value` 等场景。短码正则 `:([\w+-]+):` 要求两侧 `:` 紧邻且内部只含 `\w+-+`，`12:30` 不匹配（`12` 和 `30` 之间只有一个 `:`）。但 `note: something` 可能匹配吗？不会——`: something:` 中有空格，不匹配 `[\w+-]+`。实测安全。
- **嵌套**：`:a:b:c:` 不应解析为嵌套 emoji。正则惰性匹配 + 逐个消费（`:a:` 匹配后从 `b:c:` 继续），`:a:` 和 `:b:` 分别匹配。`node-emoji` 中无 `a` 和 `b` 短码 → 不转换，保留原文。
- **与 link 的交互**：`[text](https://example.com)` 中的 `:https:` 不会被误匹配——`https` 不是合法 emoji 短码，且 remark 插件在 link 节点内部 text 上跑正则时，URL 已在单独 text 节点中，`https` 不在 emoji 表中。

**结论**：✅ **推荐**。与 Velo 的 WYSIWYG + 源码保真设计哲学完全契合。

---

### 方案 C：文本 + emoji mark（标记式保留短码）

**思路**：parse 时把 `:smile:` 替换为 Unicode emoji 文本 `😄`，同时给它打上 `emoji` mark（`attrs.shortcode = "smile"`）。toMarkdown 时看到 `emoji` mark 就输出 `:shortcode:` 而非 emoji 字符。

**数据流**：

```
:smile:  →  remark 插件  →  text "😄" + emoji mark(shortcode="smile")
PM text "😄" + emoji mark  →  toMarkdown  →  :smile:
```

**优势**：
- 不需要新节点类型（只需新 mark），schema 改动小
- WYSIWYG 天然显示 emoji 字符（mark 无视觉变化）
- 短码可逆

**劣势**：
- **mark 粒度问题**：ProseMirror mark 按"区间"施加到 text，而 emoji 可能是多个 Unicode code point（如 👨‍👩‍👧‍👦 是 7 个 code point + 3 个 ZWJ）。mark 覆盖范围与 emoji 字符边界对不齐 → 编辑时 mark 可能断裂
- **继承问题**：mark 可被相邻文本继承（`inclusive` 行为），用户在 emoji 后面打字会继承 emoji mark → toMarkdown 误把普通文本也序列化为短码
- **与现有 mark 范式不一致**：`highlight` / `underline` 等 mark 是"包裹"语义（`==text==` → mark 覆盖 text），emoji 是"替换"语义（`:smile:` → emoji 字符，原文消失），mark 范式不适合

**结论**：❌ **不推荐**。mark 语义与 emoji 替换语义不匹配，编辑时 mark 边界管理脆弱。

---

### 方案 D：纯 syntax 实时转换（无 remark 插件）

**思路**：不做 parse 阶段转换，只在 syntax registry 注册 inline 语法，用户在 WYSIWYG 中键入 `:smile:` 时实时转换为 emoji 文本 `😄`。fromMarkdown 不识别短码（`:smile:` 保持纯文本）。

**优势**：
- 改动最小（只加 syntax/inline/emoji.ts + 注册）
- 用户键入的短码实时转换

**劣势**：
- **❌ 不处理已存在文件**：打开一个含 `:smile:` 的 .md 文件，WYSIWYG 中 `:smile:` 显示为字面文本而非 emoji（因为 fromMarkdown 不转换）
- **❌ 短码丢失**：转换后 `😄` 是纯文本，toMarkdown 输出 `😄` 而非 `:smile:`
- 源码模式下 `:smile:` 无法转换（syntax 只在 PM 中跑）

**结论**：❌ **不推荐**。无法处理已有短码文件，且短码不可逆。

---

## 三、方案对比

| 维度 | A. remark-emoji 文本替换 | B. 自定义 atom 节点 | C. text + mark | D. 纯 syntax |
|------|--------------------------|---------------------|------------------|---------------|
| **短码可逆** | ❌ 丢失 | ✅ 保留 | ✅ 保留 | ❌ 丢失 |
| **canonical dirty** | ❌ 会 dirty | ✅ 不 dirty | ✅ 不 dirty | ✅ 不 dirty |
| **已有文件短码** | ✅ 渲染 | ✅ 渲染 | ✅ 渲染 | ❌ 不渲染 |
| **实时键入转换** | 需额外 syntax | 需额外 syntax | 需额外 syntax | ✅ 天然支持 |
| **改动量** | 极小（1 行） | 大（8 层） | 中（6 层） | 小（1 层） |
| **UI 可扩展性** | ❌ 无节点 | ✅ NodeView / tooltip | 中 | ❌ |
| **架构一致性** | ❌ 违反 round-trip | ✅ 同 image / html_inline | ❌ mark 语义不匹配 | ❌ 不完整 |
| **新依赖** | remark-emoji | node-emoji | node-emoji | 无 |

---

## 四、推荐路线

**推荐方案 B：自定义 inline atom 节点**。

理由：
1. Velo 的 canonical round-trip 要求严格 idempotent——这是方案 A 的致命缺陷
2. 方案 B 与现有 `image` / `html_inline` atom 节点范式完全一致，架构一致性好
3. 未来可扩展 emoji 选择器 / 短码自动补全 / hover tooltip，方案 A 无此空间
4. 短码在 WYSIWYG 渲染为 emoji、在源码模式保留 `:smile:` 原文，与 Obsidian 体验一致

---

## 五、实施计划（方案 B）

### 5.1 依赖

| 包 | 用途 | 大小 |
|----|------|------|
| `node-emoji` | shortcode → Unicode emoji 映射表（~1800 条目） | ~50KB gzipped |

不需要 `remark-emoji`（它的行为是文本替换，与方案 B 不兼容；自写 remark 插件）。

### 5.2 实施步骤

按「新增语法支持 checklist」分层走：

#### Step 1: schema（`editor/schema.ts`）

新增 `emoji` 节点定义（见方案 B schema 草案）。放在 `html_inline` 之后、`tableNodes` 之前。

#### Step 2: remark 插件（`plugins/remarkEmoji.ts`）

- 扫描每个 inline children 数组
- 正则 `/:([\w+-]+):/g` 匹配 `:shortcode:` 模式
- 查 `node-emoji` 表验证 shortcode 合法性
- 合法 → 切分为 text + `emoji` mdast 节点 + text
- 不合法 → 保留纯文本（`:a:` 如果 `a` 不在 emoji 表中则不转换）
- 复用 `remarkHighlight` 的"单文本正则 + 跨节点状态机"范式
- 注册进 `parseProcessor.ts`（放在 `remarkHighlight` 之后、`remarkCjkEmphasis` 之前）

#### Step 3: markdownIO 双向（`editor/markdownIO.ts`）

- `fromMarkdown` / `inlineNodeToPM`：`case 'emoji'` → `schema.node('emoji', { shortcode: n.shortcode })`
- `toMarkdown` / `pmInlineToMdast`：`emoji` 节点 → `{ type: 'html', value: ':shortcode:' }`（用 html 节点防 `:` 被 remark-stringify escape）
- `processSpans`：新增 `emoji` span kind → 输出 html 节点

#### Step 4: NodeView（`nodes/EmojiNodeView.ts`）

- 查 `node-emoji` 表把 shortcode 转 Unicode char
- 渲染到 `<span data-type="emoji" data-shortcode="...">` 元素
- `stopEvent` / `ignoreMutation` / `selectNode` / `deselectNode` 标准范式
- 在 `EditorInner.vue` 的 `allPlugins` 中注册

#### Step 5: syntax registry（`syntax/inline/emoji.ts`）

- `pattern: /:([\w+-]+):/g`
- `apply`: 删 match → 查 `node-emoji` 表 → 合法则插入 emoji node，不合法则不转换
- 在 `syntax/index.ts` 注册（放在 `htmlTagSyntax` 之前，避免 `:smile:` 被 htmlTag 误吞）
- 需进 `syntaxAutoFormat` 的退避列表（code mark / code_block 内不转换）

#### Step 6: 导出 walker（`lib/export/htmlRenderer.ts`）

- `case 'emoji'` → 输出 emoji Unicode char（纯文本，无需特殊 HTML）
- DOMPurify 不影响（emoji 是合法 Unicode 文本）

#### Step 7: 测试（`__tests__/markdownIO.test.ts`）

round-trip 用例：
- `:smile:` → round-trip → `:smile:`（短码保留）
- `text :rocket: more` → round-trip → `text :rocket: more`
- `:invalidshortcode:` → 不转换（保留原文）
- `:smile: :rocket: :heart:` → 多个 emoji 混排
- `12:30` → 不误匹配
- `[:smile:](url)` → emoji 在 link 内（验证 mark 嵌套）
- `code: :smile:` → code mark 内不转换（syntax 层）

#### Step 8: 源码模式

无需改动。源码模式显示 `documentStore.content` 原文，短码 `:smile:` 原样显示。

#### Step 9: 样式（`styles/_editor-emoji.scss`）

- emoji `<span>` 基础样式：`display: inline` 保证不破坏行内排版
- 可选：选中态 outline（与 image 同范式 `selectable: true`）

---

## 六、风险与边界

### 6.1 `:` 误匹配

Markdown 中 `:` 常见于时间 `12:30`、定义 `key: value`、引用 `> Note: ...` 等。短码正则 `:([\w+-]+):` 要求**两侧紧邻 `:`**：

- `12:30` → 只有一个 `:`，不匹配 ✅
- `key: value` → `: value` 中有空格，不匹配 ✅
- `Note: something` → 同上 ✅
- `http://` → `:` 后跟 `//`，不匹配 ✅
- `::before`（CSS） → 两个连续 `:`，但 `before` 在 emoji 表中不存在 → 不转换 ✅

### 6.2 短码别名

同一个 emoji 可能有多个短码别名（如 `:thumbsup:` 和 `:+1:` 都映射到 👍）。`node-emoji` 的 `which()` 方法支持别名查找。toMarkdown 输出 `attrs.shortcode` 中存储的原始短码（用户输入 `:+1:` 就输出 `:+1:`，输入 `:thumbsup:` 就输出 `:thumbsup:`）。

### 6.3 emoji ZWJ 序列

某些 emoji 是多个 Unicode code point 组合（如 👨‍👩‍👧‍👦 = 👨 + ZWJ + 👩 + ZWJ + 👧 + ZWJ + 👦）。`node-emoji` 正确处理这些序列，NodeView 渲染时用 `textContent` 设置完整序列即可。atom 节点不涉及 mark 粒度问题，无风险。

### 6.4 性能

`node-emoji` 查表是 O(1)（内部是 `Map<string, string>`）。remark 插件对每个 text 节点跑一次正则，与现有 `remarkHighlight` / `remarkSupSub` 同范式，无额外性能负担。大文档（> 2000 行）走 Worker parse，remark 插件在 Worker 内执行，不阻塞主线程。

### 6.5 与现有语法的交互

| 语法 | 交互 | 结论 |
|------|------|------|
| `**bold**` | `:smile:` 在 bold 内 | remark 插件在 strong 的 children 上跑，正常转换 |
| `[link](url)` | `:smile:` 在 link 文本内 | 同上，link children 是 text，正常转换 |
| `` `code` `` | `:smile:` 在 code mark 内 | syntax 层 code mark 是黑名单，不实时转换。但 parse 阶段 remark 插件仍会跑——需在 remark 插件中跳过 `inlineCode` 节点 |
| `$math$` | `:smile:` 在公式内 | math_inline 是独立节点，children 不走 remark 插件 |
| `[^footnote]` | `:` 在 footnote label 内 | `[^note:1]` → label 是 `note:1`，含 `:` 但不在 emoji 表 → 不转换 |
| `<u>underline</u>` | `:smile:` 在 underline 内 | underline 的 children 是 text，正常转换 |

### 6.6 导出

导出走 `htmlRenderer.ts` 的 mdast walker，不走 PM doc。只要 remark 插件在导出管线的 `runSync` 阶段执行（已确认：导出复用同一 pipeline 且 `runSync`），emoji mdast 节点会被正确处理。walker 补 `case 'emoji'` 输出 Unicode char 即可。

---

## 七、未来扩展（非 MVP）

- **Emoji 选择器面板**：快捷键 `Mod+E` 或状态栏按钮弹出 picker，分类浏览 + 搜索 + 点击插入
- **短码自动补全**：用户键入 `:` 后弹出 fuzzy 搜索的短码补全列表（复用命令面板的 fuzzy 引擎）
- **Hover tooltip**：鼠标悬停 emoji 节点显示 `:shortcode:` 名 + emoji 描述
- **Emoticon 支持**：`:)` → 😄、`<3` → ❤️（需单独配置项，默认关闭，过于激进）

# CLAUDE.md

> 每次加载本仓库时，请先读取以下两份文档，作为后续工作的上下文基础：
>
> - [`docs/ROADMAP.md`](./docs/ROADMAP.md) — 版本规划与已完成 / 待办事项清单
> - [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — 技术栈、目录结构、ProseMirror 插件链、数据流与设计要点

## 加载指引

在开始任何任务之前：

1. **必读**：用 Read 工具读取上面两份文档的完整内容（不要只读前若干行）。
2. 把 ROADMAP 当作"现在做到哪了 / 接下来做什么"的 source of truth；把 ARCHITECTURE 当作"代码长什么样 / 为什么这么设计"的 source of truth。
3. 当用户的需求与 ROADMAP 中已规划的某个版本目标相关时，优先沿用该版本的设计意图，不要另起炉灶。
4. 当涉及 ProseMirror 插件链、数据流、NodeView/Decoration 取舍等时，先在 ARCHITECTURE.md 的"设计要点"和"维护者注意点"里查一遍，避免踩已经记录过的坑。

## 文档同步规则（重要）

**任务完成后，必须同步以下文档，否则视为任务未完成：**

### 1. ARCHITECTURE.md — 架构层变动必须同步

满足以下任一情况就要更新 `docs/ARCHITECTURE.md`：

- 新增 / 删除 / 重命名 ProseMirror 插件或 NodeView，调整 `allPlugins` 数组顺序
- 修改 markdown 解析 / 序列化管线（`editor/markdownIO.ts`、unified pipeline、新增 remark 插件）
- 改动 schema（新节点类型 / mark / attrs 语义）
- 修改数据流（`documentStore`、`lastSavedContent` / `echosToAccept` / `lastSelfEmitted` 等同步语义）
- 修改 Tauri 端能力（`capabilities/*.json`、新 command、`tauri.conf.json` 协议）
- 修复一个"非显然"的 bug，并且对应解决方案值得作为踩坑记录沉淀（写进"设计要点"或"维护者注意点"）

更新时对齐已有结构：技术栈表格、目录结构、ProseMirror 插件链表、数据流、设计要点、维护者注意点。**不要新开顶级章节**，能塞进现有段落就塞进去。

### 2. ROADMAP.md — 版本任务推进必须同步

- 完成 ROADMAP 中已列出的某条 `- [ ]` → 改为 `- [x]`，不要删除条目
- 实现过程中发现 ROADMAP 原计划无法落地或方案改了 → 用删除线 + `→` 注明实际走法（参考 v0.4.0 Phase 1 已有写法）
- 临时新增的、原计划没列的功能 / 重要 fix → 追加到对应版本的 `feat` / `fix` / `refactor` 段下
- 不要私自创建新版本号，新版本规划由用户决定；不要修改已发布版本的历史条目

### 3. 新增 markdown 语法支持(完整闭环 checklist)

> 一条新语法(mermaid 升级 / 高亮 mark / 新 callout / 新链接形式等)要落地,
> 看清楚涉及哪些层 — 每层都问自己一遍,缺哪补哪。
>
> 这是 checklist,不是规约每条必做 —— 多数简单语法只碰其中 2-3 个文件,
> 但**用这张表扫一遍**能避免漏。

| # | 涉及层 | 文件 | 何时需要动 |
|---|--------|------|-----------|
| 1 | **schema** | `editor/schema.ts` | 新增节点类型 / mark / attrs |
| 2 | **NodeView / widget** | `nodes/*.ts` 或 `editor/imageNodeView.ts` 等 | 需要特殊视觉(数学渲染 / mermaid SVG / 任务 checkbox / 链接源编辑) |
| 3 | **remark 插件**(外部解析) | `plugins/remark*.ts` + `editor/markdownIO.ts` 里 `.use()` | mdast 树需要重写(如 alert / preserveEmptyLine)或补缺 |
| 4 | **markdownIO 双向** | `editor/markdownIO.ts` | 新节点要进 fromMarkdown / toMarkdown;新 mark 要在 pmInlineToMdast 加分支 |
| 5 | **syntax registry**(实时键入) | `syntax/{block,inline}/*.ts` + `syntax/index.ts` | 用户键入也要转(块级 / 行内带匹配) |
| 6 | **ProseMirror 插件** | `EditorInner.vue` 的 `allPlugins` 数组 | 需要新装饰 / 行为插件(查找高亮 / 自动补全 / 原子保护) |
| 7 | **keymap** | `EditorInner.vue` | 新快捷键(如 `$$` + Enter) |
| 8 | **测试** | `__tests__/*.ts` | 每条语法至少 1 happy + 1 反例;`markdownIO` 改动必加 round-trip |
| 9 | **ROADMAP** | `docs/ROADMAP.md` 当前版本 `feat` 段 | 加 `- [x] 一行说明` |
| 10 | **ARCHITECTURE** | `docs/ARCHITECTURE.md` | 跨节点依赖 / 触发时机反直觉 / 新黑名单维度 / 非显然设计取舍;**纯模板化不需要改** |

**最易漏的项**:
- 第 5 列注册——`syntax/index.ts` 没 `registerXxx` = 不生效,且无警告,纯静默
- 第 4 列双向——`fromMarkdown` 加了,`toMarkdown` 忘了,文件保存再加载会丢数据
- 第 9 列文档——实现完了没留痕,后人不知道
- 第 10 列过度——简单语法也写一段"设计要点"反而稀释文档信号

**已落地的语法参照**:
- `mermaid` 涉及 schema + NodeView + remark(走 mdast code) + markdownIO 双向 + mermaidDecoration plugin(不走 syntax)
- `alert` 涉及 schema + remark(remarkAlert) + markdownIO 双向 + syntax/block/alert + 注册
- `footnote` 涉及 schema + NodeView + FootnoteNumberPlugin + syntax/inline/footnoteRef + 注册
- `_italic` / `~~strike~~` 涉及 schema + syntax/inline + 注册(无 NodeView / 无 remark)



## 工作风格约定

- **改动尽量小而精确**：不顺手重构无关代码；ROADMAP 没列的"清理"先问用户
- **修 bug 先看 ARCHITECTURE 的"设计要点"**：很多看起来是 bug 的行为是有意为之（例如 mermaid 走 widget 不走 NodeView、echo 哨兵机制、写盘前推进 `lastSavedContent` 等）
- **加注释克制**：仓库现有注释密度偏低，匹配现有风格；只在"非显然的设计取舍"处写注释，不要解释代码本身在做什么
- **测试**：`__tests__/` 里有现成的 round-trip / 回归合约测试，改 schema / markdownIO 后跑 `vitest run` 确认全绿
- **类型严格**：TypeScript strict 模式，`vue-tsc --noEmit` 必须 0 错

## 仓库速览

- **项目**：Velo — 基于 Vue 3 + Tauri 2 + ProseMirror 的本地 markdown 编辑器
- **主分支**：`master`
- **目录入口**：`src/App.vue`、`src/components/ProseMirrorEditor/`、`src-tauri/`

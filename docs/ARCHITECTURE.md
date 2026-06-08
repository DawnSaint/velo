# Velo

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 (`<script setup>`) |
| 状态管理 | Pinia |
| 语言 | TypeScript (strict) |
| 构建 | Vite |
| 桌面壳 | Tauri 2.0 |
| 编辑器 | Milkdown (ProseMirror) |
| 数学公式 | KaTeX |
| 图表 | Mermaid |
| CSS | Tailwind 3 + Sass |

具体版本见 `package.json` / `src-tauri/Cargo.toml`。

---

## 目录结构

```
velo/
├── docs/ARCHITECTURE.md
├── src/
│   ├── App.vue                    顶栏 + 大纲 + 编辑器 + 设置
│   ├── stores/                    editor 设置 / document 文件状态 / outline 折叠 / persistence IO
│   ├── styles/                    Tailwind + Sass partial
│   └── components/
│       ├── EditorOutline.vue
│       ├── EditorSettings.vue
│       ├── DraftRecoveryDialog.vue
│       └── MilkdownEditor/
│           ├── index.vue          壳 (CSS 变量 / hljs 加载 / innerKey 控制重挂)
│           ├── EditorInner.vue    useEditor() + <Milkdown />,生命周期交给 @milkdown/vue
│           ├── MathNodeViews.ts   公式 NodeView
│           ├── MermaidSyntax.ts   mermaid remark 插件 + schema
│           ├── MermaidNodeView.ts mermaid NodeView (异步渲染 + 主题事件)
│           ├── TaskListNodeView.ts 任务列表 checkbox NodeView
│           └── FootnoteNodeViews.ts 脚注 NodeView + 位置收集 Plugin + 输入规则
└── src-tauri/
    ├── capabilities/default.json  fs:allow-** (通用文本编辑器,见维护者注意点 4)
    └── src/{main,lib}.rs          set_window_theme / get_cli_args / PendingCliArgs / single-instance
```

---

## Milkdown 插件链

按 `EditorInner.vue` 里 `.use()` 顺序:

| 插件 | 用途 |
|------|------|
| `headingBackspaceToParagraph` | 标题前 Backspace / Delete → 直接转正文(不降级 h2→h1) |
| `tabIndent` | 列表项走 sink/lift;代码类节点 / 段落 / 标题插 4 空格 |
| `safeCommonmark` + `fixedEmphasisUnderscoreInputRule` | 修复上游 markRule bug(详见"已修复的 upstream 问题") |
| `safeGfm` + `fixedStrikethroughInputRule` | 同上 |
| `history` | 撤销 / 重做 |
| `math` + `mathEditPlugin` | LaTeX 行内 / 块级 + KaTeX 实时预览 |
| `mermaidSyntax` + `mermaidEditPlugin` | ```` ```mermaid ```` 转自定义节点 + 异步渲染 |
| `taskListPlugin` | `- [ ]` / `- [x]` 可点 checkbox |
| `footnoteEditPlugin` | 脚注 NodeView + 位置收集 Plugin + `[^id]` 输入规则 |
| `listener` | `markdownUpdated` → 回写 store / hljs class 注入 |

---

## 数据流

**`documentStore.content` 是编辑器文本的唯一来源** —— `<MilkdownEditor :model-value v-model>` 双向同步,`EditorOutline` 只读。`dirty = content !== lastSavedContent`。

**生命周期** 由 `@milkdown/vue` 接管:`EditorInner.vue` 用 `useEditor()` + `<Milkdown />` 自管 create/destroy。外部 modelValue 变化时(切文件 / 新建 / 外部同步),`lastSelfEmitted` 值对比探测,emit `rebuildRequest` 给外层 bump `innerKey` 触发整编辑器重建(优于 `isInternalChange` + `nextTick` 时序标志)。

**文件操作**(都走 `documentStore`):
- **打开** → `confirmDiscardIfDirty` → `openDialog` → `readTextFile` → `loadContent`(设 `echosToAccept=1` 等编辑器首屏 echo)
- **保存** → `writeTextFile`,**写盘前乐观推进** `lastSavedContent`,自己触发的 fs:watch 事件被 `disk === lastSavedContent` 过滤;失败回滚
- **Ctrl+S / 失焦保存 / 关闭拦截** → 同一份 `save()`

**外部改动同步** (`checkExternalChange`,fs:watch + window focus 兜底):
1. `disk === lastSavedContent` → 自己的写,忽略
2. `disk === content` → 别人重写为同样内容,只刷新基线
3. `!dirty` → 静默 `loadContent(disk, path)`
4. `dirty` → 弹确认 → 用户决定 reload 或保留本地

**单实例 + 文件关联**:
- **冷启动**:Rust `setup()` 把 argv 暂存进 `PendingCliArgs`,前端 `onMounted` 调 `invoke('get_cli_args')` 拉一次(直接 emit 会被 webview 漏报)
- **二次启动**:`tauri-plugin-single-instance` 回调 → `app.emit('cli-args')` → 前端 `listen('cli-args')` 接住

**崩溃恢复草稿**:脏盘期间每 30s 把内容写到 `appDataDir/drafts/{id}.json`(ID = path 编码或 `untitled`)。启动时扫描展示给用户选择恢复 / 丢弃。**注意**:`loadRecoverableDrafts` 必须在 `openPath` *之后*调,filter 用 `currentDraftId()` 排除当前文档的草稿。

**持久化**:`appDataDir/{velo-settings.json, velo-outline-state.json, drafts/}`。失败一律不抛,降级到 store 默认值 —— 首次启动 / 配置损坏都不能阻塞 UI。

---

## 设计要点

- **自家写盘不打扰** —— `save()` 写盘前推进 `lastSavedContent`,自己触发的 fs:watch 因此被 `disk === lastSavedContent` 短路
- **写盘抛错回滚** —— `lastSavedContent` 先推到 snapshot,失败回滚到 `previousBaseline`,dirty 不错位
- **focus 兜底** —— `notify-rs` 在网络盘 / 原子 rename / Dropbox 等同步工具下会漏报,`window focus` 主动核一次
- **echo 哨兵** (`echosToAccept`) —— Milkdown 首次 mount 回吐一次"规范化后"的 markdown,store 用这个计数把那次回吐采纳为新基线,dirty 保持 false。`init` / `loadContent` 都要正确设 `echosToAccept = 1`,否则首屏立刻变脏
- **Plan B 模块身份** —— `safeCommonmark = commonmark.filter(p => p !== emphasisUnderscoreInputRule)` 依赖两端 import 指向同一模块实例,upstream 重构破坏等式的话过滤会**静默失效**
- **NodeView 隔离** —— `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror
- **样式分层** —— MilkdownEditor 基础排版内联 `<style>`,公式 / Mermaid / 脚注走 SCSS partial
- **脚注 label 是显示文本** —— `attrs.label` 既是用户可改的原始 id,也是 NodeView 写出的文本;没有 `1.` `2.` `3.` 自动编号(扩展点见"维护者注意点 5")

---

## 已修复的 upstream 问题

### Milkdown `markRule` 越界改写 inline code

`@milkdown/preset-commonmark` / `-gfm` 的 `emphasisUnderscoreInputRule` / `strikethroughInputRule` 正则末尾**没有 `$` 锚点**,会扫到段落里任意位置的 `_x_` / `~~x~~`,包括 inline code 内部(因为 `textBetween` 不带 mark 信息,code 里的字面字符同样被 regex 看到)。`prosemirror-inputrules` 按"匹配紧贴光标"算 `start`,一旦命中 inline code,`tr.delete` / `tr.addMark` 跑到错误位置 —— inline code 里的字被吞,光标附近的字符被错误加 emphasis,当次键入也丢。

**修法**:`commonmark` / `gfm` bundle 里 `.filter()` 掉这两条 rule,再注册一对带 `$` 锚点的修复版(`fixedEmphasisUnderscoreInputRule` / `fixedStrikethroughInputRule`)顶上。其他 markRule(emphasisStar / strong / inlineCodeInputRule)末尾本来就有 `$`,不替换。

**验证**:升级 Milkdown 后打开示例文档,在 `` `_斜体_` `` inline code 后面任意位置敲空格,inline code 内容不应被破坏。等 upstream 修了之后可移除 `safeXxx` 过滤和 `fixedXxx` 替换。

---

## 维护者注意点

1. **路径别名** —— `@/` → `src/`
2. **fs.watch 生命周期 race** —— `startWatchOf` / `stopWatch` 是 fire-and-forget,理论能泄漏旧 watcher;实际 `checkExternalChange` 早退所以无 user-visible 影响。若观察到泄漏 fd,加 sequence number 串行化
3. **`onCloseRequested` 未取消** —— unlisten fn 没存,HMR 重挂会叠加 handler,dev 体验略差;prod 不受影响
4. **Tauri 权限 scope** —— `capabilities/default.json` 把 fs 权限都开 `**`,因为是通用文本编辑器。分发硬化版本时收紧到工作目录
5. **脚注 label 是显示文本** —— 当前没有 `1.` `2.` `3.` 自动编号。扩展点是在 `FootnoteNumberPlugin.state` 加 `numbering: Map<label, number>`,按首次出现顺序在 `state.apply` 里推算 —— **不要**把编号写回 `attrs.label`,否则 markdown 源码会变成 `[^1]` 这种数字 id,失去可读语义,也跟 GFM / CommonMark 约定不符

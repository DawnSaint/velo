# Velo

## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 (`<script setup>`) |
| 状态管理 | Pinia |
| 语言 | TypeScript (strict) |
| 构建 | Vite |
| 桌面壳 | Tauri 2.0 |
| 编辑器 | ProseMirror |
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
│       └── ProseMirrorEditor/
│           ├── index.vue          壳 (CSS 变量 / hljs 加载 / innerKey 控制重挂)
│           ├── EditorInner.vue    useProseMirror() + 裸 ProseMirror EditorView
│           ├── nodes/             自定义 ProseMirror 节点
│           │   ├── MathNodeViews.ts        公式 NodeView (block view 走 TextareaEditor)
│           │   ├── MermaidSyntax.ts        mermaid remark 插件 + schema (toDOM 输出 height:0 占位)
│           │   ├── MermaidDecoration.ts    mermaid widget plugin (SVG 显示 + 编辑态 textarea,详见"设计要点")
│           │   ├── TaskListNodeView.ts     任务列表 checkbox NodeView
│           │   ├── FootnoteNodeViews.ts    脚注 NodeView + 位置收集 Plugin + 输入规则
│           │   └── TextareaEditor.ts       多行 textarea 编辑壳 (math block / mermaid 共用)
│           ├── findreplace/       查找替换
│           │   ├── FindReplace.vue         浮层 UI
│           │   ├── findHighlight.ts        匹配高亮 ProseMirror plugin
│           │   └── findMatches.ts          匹配/替换纯函数
│           ├── image/             图片上传与键盘
│           │   ├── imageUploadPlugin.ts    paste/drop 拦截 + 持盘
│           │   └── imageKeymap.ts          删除原子保护
│           └── plugins/           通用独立插件
│               └── preserveEmptyLine.ts    空行保留
└── src-tauri/
    ├── capabilities/default.json  fs:allow-** (通用文本编辑器,见维护者注意点 4)
    └── src/{main,lib}.rs          set_window_theme / get_cli_args / PendingCliArgs / single-instance
```

---

## ProseMirror 插件链

按 `ProseMirrorEditor/EditorInner.vue` 里 `allPlugins` 数组顺序:

| 插件 | 用途 |
|------|------|
| `keymap(Backspace/Delete → headingToParagraph)` | 标题前退格 / 删除 → 转段落(不降级 h2→h1) |
| `keymap(Mod-z/y/Shift-z)` | 撤销 / 重做 |
| `keymap(Enter → chainCommands(dollarEnterCmd, splitBlock))` | `$$` + Enter → 块级公式进入编辑态;其他 Enter → 换段 |
| `keymap(baseKeymap)` | 接管未自定义的所有基础键 |
| `dropCursor` | 拖动时显示蓝色光标线指示落点 |
| `gapCursor` | 允许光标落在非文本节点之间 |
| `history` | 撤销 / 重做栈 |
| `tabIndent` | 列表项 sink/lift;代码类 / 段落 / 标题按 Tab 插 4 空格;非列表 Shift-Tab 消费(焦点保留) |
| `dollarEnterToMathBlock` | `$$` + Enter keymap 入口 |
| `imageKeymapPlugin` | atom 节点(image / mermaid / math_block)删除保护:Backspace/Delete 紧贴 → 选中而非删除 |
| `imageUploadPlugin` | paste/drop 拦截 → 落盘 → 插入 image 节点 |
| `imageInlineViewPlugin` | image NodeView(Tauri asset:// 协议代理) |
| `mathEditPlugin` | math_inline / math_block NodeView(KaTeX 实时预览) |
| `mermaidDecoration` | mermaid block 用 Decoration.widget 渲染 SVG / 编辑态切换 |
| `taskListPlugin` | `- [ ]` / `- [x]` list_item NodeView(checkbox + 内容区分) |
| `footnoteEditPlugin` | 脚注 NodeView + 位置收集 + `[^id]` 输入规则 |
| `findHighlight` | 查找替换高亮 Decoration |
| `inputRules` | fixedEmphasis_/Strike + inlineMath + footnote + ellipsis/emDash |

**markdown 解析** 不在 ProseMirror 插件链里 —— 走 `editor/markdownIO.ts` 的 unified pipeline(`remark-parse` + `remark-gfm` + `remark-math` + `remarkPreserveEmptyLine`),`fromMarkdown(md, schema)` 装到 EditorState,`onChange(doc) → toMarkdown(doc)` 回写。**键入触发**走 inputRules,不走 unified。

---

## 数据流

**`documentStore.content` 是编辑器文本的唯一来源** —— `<ProseMirrorEditor :model-value v-model>` 双向同步,`EditorOutline` 只读。`dirty = content !== lastSavedContent`。

**生命周期** 由 `useProseMirror` 接管:`EditorInner.vue` 在 onMounted 起裸 `EditorView`,onBeforeUnmount destroy。外部 modelValue 变化时(切文件 / 新建 / 外部同步),`lastSelfEmitted` 值对比探测,emit `rebuildRequest` 给外层 bump `innerKey` 触发整编辑器重建(优于 `isInternalChange` + `nextTick` 时序标志)。

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
- **echo 哨兵** (`lastSelfEmitted`) —— `EditorInner` 自己 dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch modelValue 看到值匹配就跳过(自己 emit 的 echo);不匹配就 emit `rebuildRequest` 重建。比 `isInternalChange + nextTick` 时序标志更稳。
- **NodeView 隔离** —— `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror
- **mermaid 走 widget 不走 NodeView** —— atom NodeView 的 outer dom 改 `innerHTML` 会被 ProseMirror 的 `DOMObserver` 当外部突变 → `readDOMChange` → `view.updateState` → 整个 view tree 重 mount,所有 NodeView destroy + recreate,用户每敲一字符 mermaid 全闪 loader。改用 `Decoration.widget`:`WidgetViewDesc.ignoreMutation` 默认忽略所有非 selection 突变,widget 内部 `dom.innerHTML = svg` 不报警。widget 内部根据 plugin state.editNodePos 切换"显示 SVG"/"显示 textarea"两种渲染,key 设为 `mermaid-widget:${pos}:${isEditing ? 'edit' : 'view'}` 在状态切换时由 ProseMirror 卸载/挂载。完全没有 NodeView,schema toDOM 输出 `height:0` 隐藏占位(atom 节点必须有 dom 用于 posAtCoords / selection 映射,藏掉视觉即可)。**坑**:plugin promise resolve 后**不要** dispatch setMeta 触发 buildDecorations,否则新 Decoration 实例的 `WidgetType.eq` 在比 toDOM/spec 时会失败 → widget 复用失效 → 死循环;直接在 widget 自己的 dom 上写 svg 即可。
- **mermaid 主题切换** —— widget 工厂里直接挂 `velo:theme-change` window listener,自己改 dom;不走 plugin setMeta 路径(同上的死循环)。decoration `spec.destroy` 钩子负责 `removeEventListener` 防泄漏
- **样式分层** —— ProseMirrorEditor 基础排版内联 `<style>`,公式 / Mermaid / 脚注走 SCSS partial
- **脚注 label 是显示文本** —— `attrs.label` 既是用户可改的原始 id,也是 NodeView 写出的文本;没有 `1.` `2.` `3.` 自动编号(扩展点见"维护者注意点 5")

---

## v0.4.0 重构记录

v0.4.0 把编辑器从 `@milkdown/*` 切到裸 ProseMirror + remark / unified。详细评估见 [`MIGRATION_PROSEMIRROR.md`](./MIGRATION_PROSEMIRROR.md),关键变化:

- **不再需要** `safeCommonmark` / `safeGfm` / `fixedXxxInputRule`(修上游 markRule bug 的补丁)—— 上游 Milkdown 封装不存在了,bug 失去存在意义
- **基础键** 现在显式装 `keymap(baseKeymap)`,ProseMirror 不会自动装
- **markdown 解析** 走自写 `markdownIO.ts`(unified pipeline + mdast↔PM 转换),不再依赖 `prosemirror-markdown` 的 `defaultMarkdownParser` / `defaultMarkdownSerializer`
- **新组件目录** `ProseMirrorEditor/`,旧 `MilkdownEditor/` 已删
- **新依赖**:`prosemirror-*` / `remark-*` / `mdast-util-*` / `unified`(全部已是 @milkdown 时代的传递依赖,显式化即可)
- **删除依赖**:`@milkdown/kit` / `@milkdown/plugin-clipboard` / `@milkdown/plugin-math` / `@milkdown/vue`(净减 96 个传递包)

---

## 维护者注意点

1. **路径别名** —— `@/` → `src/`
2. **fs.watch 生命周期 race** —— `startWatchOf` / `stopWatch` 是 fire-and-forget,理论能泄漏旧 watcher;实际 `checkExternalChange` 早退所以无 user-visible 影响。若观察到泄漏 fd,加 sequence number 串行化
3. **`onCloseRequested` 未取消** —— unlisten fn 没存,HMR 重挂会叠加 handler,dev 体验略差;prod 不受影响
4. **Tauri 权限 scope** —— `capabilities/default.json` 把 fs 权限都开 `**`,因为是通用文本编辑器。分发硬化版本时收紧到工作目录
5. **脚注 label 是显示文本** —— 当前没有 `1.` `2.` `3.` 自动编号。扩展点是在 `FootnoteNumberPlugin.state` 加 `numbering: Map<label, number>`,按首次出现顺序在 `state.apply` 里推算 —— **不要**把编号写回 `attrs.label`,否则 markdown 源码会变成 `[^1]` 这种数字 id,失去可读语义,也跟 GFM / CommonMark 约定不符

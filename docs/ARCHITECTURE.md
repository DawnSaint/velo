# Velo



## 技术栈

| 类别 | 技术 |
|------|------|
| 前端框架 | Vue 3 (`<script setup>`) |
| 状态管理 | Pinia |
| 语言 | TypeScript |
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
│           ├── index.vue          壳 (CSS 变量)
│           ├── EditorInner.vue    useProseMirror() + 裸 ProseMirror EditorView
│           ├── nodes/             自定义节点 (公式/mermaid/任务列表/脚注/代码块)
│           │   ├── MathNodeViews.ts
│           │   ├── MermaidSyntax.ts + MermaidDecoration.ts
│           │   ├── TaskListNodeView.ts
│           │   ├── FootnoteNodeViews.ts
│           │   ├── CodeHighlightWidget.ts
│           │   └── TextareaEditor.ts  多行 textarea 编辑壳
│           ├── findreplace/       查找替换 (浮层UI + 高亮plugin + 匹配函数)
│           ├── image/             图片 paste/drop 上传 + 删除保护 keymap
│           ├── plugins/           通用插件
│           │   ├── linkClick.ts        链接点击/源码编辑态 session
│           │   ├── preserveEmptyLine.ts
│           │   ├── remarkAlert.ts      GFM alert remark 插件
│           │   └── syntaxAutoFormat.ts 语法实时转换框架
│           └── syntax/            实时语法注册表
│               ├── index.ts            注册入口
│               ├── block/              段首: heading / codeBlock / blockquote / list / hr
│               └── inline/             段内: emphasis / strike / inlineMath / footnoteRef / link
└── src-tauri/
    ├── capabilities/default.json  fs:allow-** (通用文本编辑器)
    └── src/{main,lib}.rs          窗口主题 / CLI args / single-instance
```

---

## ProseMirror 插件链

按 `EditorInner.vue` 里 `allPlugins` 数组顺序:

| 插件 | 用途 |
|------|------|
| keymap(Backspace/Delete → headingToParagraph) | 标题退格/删除转段落 (不降级 h2→h1) |
| keymap(Mod-z/y/Shift-z) | 撤销/重做 |
| keymap(Enter → dollarEnterCmd) | `$$`+Enter 进块级公式编辑态 |
| keymap(baseKeymap) | 接管基础键 |
| dropCursor / gapCursor | 拖放光标 + 跨非文本节点光标 |
| history | 撤销/重做栈 |
| tabIndent | Tab 缩进/反缩进;代码/段落插4空格;非列表 Shift-Tab 消费 |
| imageKeymapPlugin | atom 节点删除保护 (Backspace/Delete 紧贴先选中不直接删) |
| imageUploadPlugin | paste/drop 拦截 → 落盘 → 插入 image 节点 |
| linkClickPlugin + linkEditEscapeKeymap | 链接单击进源码编辑 / Cmd 跳转 / Escape 还原 |
| syntaxAutoFormatPlugin | dirty-range 局部扫,registry 驱动 (见设计要点) |
| codeHighlightPlugin | shiki dual-theme 代码高亮 + toolbar widget (见设计要点) |
| imageInlineViewPlugin | image NodeView (Tauri asset:// 代理) |
| mathEditPlugin | math_inline/block NodeView (KaTeX 实时预览) |
| mermaidDecoration | Decoration.widget 渲染 SVG / 编辑态切换 (见设计要点) |
| taskListPlugin | `- [ ]` / `- [x]` checkbox NodeView |
| footnoteEditPlugin | 脚注 NodeView + 位置收集 |
| findHighlight | 查找替换高亮 |
| inputRules | ellipsis/emDash 纯文本快速路径 (其余语法走 syntaxAutoFormat) |

**markdown 解析**走 `editor/markdownIO.ts` 的 unified pipeline (remark-parse + remark-gfm + remark-math + preserveEmptyLine)。`fromMarkdown(md)` → EditorState,`toMarkdown(doc)` 回写。**键入触发**走 syntaxAutoFormat,不走 unified。

---

## 数据流

**`documentStore.content` 是编辑器文本的唯一来源**,`dirty = content !== lastSavedContent`。

**生命周期**: `EditorInner.vue` onMounted 起裸 `EditorView`,onBeforeUnmount destroy。外部 modelValue 变化时用 `lastSelfEmitted` 值对比探测自 emit 的 echo,非 echo 则 `view.updateState(EditorState.create(...))` 替换内部 state。

**文件操作**:

- 打开: `confirmDiscardIfDirty` → `openDialog` → `readTextFile` → `loadContent` (设 `echosToAccept=1`)
- 保存: `writeTextFile`,**写盘前乐观推进** `lastSavedContent` 过滤自己的 fs:watch 事件;失败回滚
- Ctrl+S / 失焦 / 关闭拦截走同一 `save()`

**外部改动同步** (`checkExternalChange`, fs:watch + window focus 兜底):

1. `disk === lastSavedContent` → 自己的写,忽略
2. `disk === content` → 别人重写为同样内容,刷新基线
3. `!dirty` → 静默 reload
4. `dirty` → 弹确认

**单实例 + 文件关联**: 冷启动走 `PendingCliArgs` + `get_cli_args`;二次启动走 `tauri-plugin-single-instance` → `cli-args` 事件。

**崩溃恢复**: 脏盘每 30s 写草稿到 `appDataDir/drafts/`;启动时 `loadRecoverableDrafts` 必须在 `openPath` *之后*调,排除当前文档草稿。

**持久化**: `appDataDir/{velo-settings.json, velo-outline-state.json, drafts/}`,失败降级不阻塞 UI。

---

## 设计要点

- **自家写盘不打扰**: `save()` 写盘前推进 `lastSavedContent`,自己触发的 fs:watch 被 `disk === lastSavedContent` 短路
- **echo 哨兵** (`lastSelfEmitted`): EditorInner dispatch 时先把 markdown 写进 `lastSelfEmitted`,父级 watch 看到匹配则跳过 echo
- **mermaid 走 Decoration.widget 不走 NodeView**: atom NodeView 的 outer dom `innerHTML` 变更会被 ProseMirror DOMObserver 当外部突变 → 全量 remount + 每字符 loader 闪烁。widget 的 `WidgetViewDesc.ignoreMutation` 默认忽略非 selection 突变。widget 根据 plugin state 切换 SVG/textarea,key 用 `mermaid-widget:${pos}:${isEditing}` 让 ProseMirror 自行卸载/挂载。schema toDOM 输出 `height:0` 隐藏占位。**坑**: plugin promise resolve 后不要 dispatch setMeta 触发 rebuild decorations,直接在 widget dom 上写 svg;否则新 Decoration 实例 `WidgetType.eq` 失败 → widget 复用失效 → 死循环
- **mermaid 主题切换**: widget 工厂直接挂 `velo:theme-change` window listener 自己改 dom;`spec.destroy` 钩子 removeEventListener 防泄漏。不走 plugin setMeta (同上死循环)
- **shiki dual-theme 代码高亮**: `codeToTokensWithThemes(code, { themes: { light, dark } })` 返回 token 级双色。每个 token span inline style 拼局部 CSS 变量 `--shiki-light`/`--shiki-dark`,SCSS 按 `html.dark` 选变量。**darkMode toggle 纯 CSS 切色**(零重渲,不要订阅事件 rebuild);**用户换主题**才 rebuild decoration(hex 变了,App.vue watch 触发)。**首屏零闪烁**: App.vue `setup` 用 `codeBlockReady` 守门 PM mount(等 shiki 主题加载完);PM mount 时 plugin `state.init` 同步拿 cached highlighter
- **语法实时转换走 appendTransaction + dirty-range**(不走 InputRule 末尾匹配): `syntaxAutoFormat.ts` 从 `tr.mapping.maps` 提取 dirty range → 对包含的 textblock 跑 block 段首检测 + inline 正则扫描。黑名单(code_block/html_block/mermaid/math_block)、code mark、link session 框架统一过滤。新增语法 = 写一个文件 + `syntax/index.ts` 注册一行。**坑**: block detector pattern 带 `^` 不带 `g`;inline 反过来带 `g` 不带 `^/$`;inline 扫描前把段内 atom 用 NBSP 占位防穿透;语法 apply 直接修改框架传入的 `tr`,不要自己 dispatch
- **NodeView 隔离**: `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror
- **样式分层**: ProseMirror 基础排版内联 `<style>`,公式/Mermaid/脚注走 SCSS partial

---

## 维护者注意点

1. **路径别名**: `@/` → `src/`
2. **fs.watch 生命周期 race**: `startWatchOf`/`stopWatch` fire-and-forget,理论可泄漏;`checkExternalChange` 早退故无实际影响
4. **Tauri 权限**: `capabilities/default.json` fs 开 `**`(通用文本编辑器),分发时收紧
5. **脚注 label 是显示文本,无自动编号**: 扩展点是在 `FootnoteNumberPlugin.state` 加 `numbering: Map<label, number>`,**不要**把编号写回 `attrs.label`(丢语义,跟 GFM 不符)
6. **shiki darkMode vs 切主题两条路径正交**: darkMode toggle 纯 CSS 切色(零重渲);切主题(换 one-light→dracula)hex 变了必须 rebuild,由 App.vue watch 触发。两条路径不要混,尤其 darkMode 切换时不要 dispatch setMeta
7. **clipboard 统一走** `@tauri-apps/plugin-clipboard-manager` 的 `writeText`
8. **code toolbar widget 用真盒子,不能 `display: contents`**: widget `display: block; height: 22px`,`side: -1` 渲染在 `<pre>` 之前,用 `:has(+ pre:hover)` 联动 hover
9. **dev web 端 Tauri API 必须 `isTauri()` 守门**: 纯 vite 调 `@tauri-apps/api/*` 同步 throw。`persistence.ts` 走 `tauriOnly()`;`App.vue` 顶层 `const tauri = isTauri()`,fire-and-forget 异步用 `if (tauri)` 守门,onMounted await 链路整段 `if (tauri) { ... }` 包裹(单行 throw 让 async 整条 reject)

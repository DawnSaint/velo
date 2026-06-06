# Velo




## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 前端框架 | Vue 3 (`<script setup>`) | ^3.5.13 |
| 状态管理 | Pinia | ^3.0.4 |
| 语言 | TypeScript | ^6.0 (strict) |
| 构建 | Vite | ^8.0 |
| 桌面壳 | Tauri 2.0 | ^2 |
| Tauri 插件（Rust） | `tauri-plugin-fs` / `-dialog` / `-shell` / `-single-instance` | ^2 |
| Tauri 桥（前端） | `@tauri-apps/plugin-fs` / `-dialog` / `@tauri-apps/api` | ^2 |
| 编辑器 | Milkdown (ProseMirror) | ^7.21.1 |
| 数学公式 | KaTeX | ^0.16.21 |
| 图表 | Mermaid | ^11 |
| CSS | Tailwind 3 + Sass | ^3.4 / ^1.83 |

---

## 目录结构

```
velo/
├── package.json
├── vite.config.ts             # port 5273, strictPort, watch ignore src-tauri
├── tsconfig.json              # TS strict
├── tailwind.config.cjs        # darkMode: 'class'
├── README.md                  # 用户向
├── docs/
│   └── ARCHITECTURE.md        # 本文件
│
├── src/
│   ├── main.ts                # createApp + Pinia
│   ├── App.vue                # 顶栏 + 大纲 + 编辑器 + 设置
│   ├── assets/
│   │   ├── sample.md
│   │   └── Velo.png
│   ├── stores/
│   │   ├── editor.ts          # 字号 / 主色 / 字体 / 暗色 / 代码块主题
│   │   └── document.ts        # 文件路径 / dirty / 自动保存 / fs.watch / save / openPath
│   ├── styles/                # Tailwind + Sass
│   └── components/
│       ├── EditorOutline.vue          # 大纲：稳定 key + scroll-spy
│       ├── EditorSettings.vue
│       └── MilkdownEditor/
│           ├── index.vue              # 编辑器主体 + Plan B 修复 + tabIndent + onCardClick
│           ├── MathNodeViews.ts       # 行内 & 块级公式 NodeView
│           ├── MermaidSyntax.ts       # remark 插件 + mermaid $nodeSchema
│           └── MermaidNodeView.ts     # Mermaid NodeView（异步渲染 + 主题事件监听）
│
└── src-tauri/
    ├── Cargo.toml             # fs / dialog / shell / single-instance
    ├── tauri.conf.json        # devUrl 5273, theme: Dark, fileAssociations
    ├── capabilities/default.json   # fs:allow-{read,write,exists,watch,unwatch} **
    └── src/
        ├── main.rs
        └── lib.rs             # set_window_theme + get_cli_args + PendingCliArgs + single-instance
```

---

## Milkdown 插件链

按 `.use()` 顺序（`src/components/MilkdownEditor/index.vue`）：

| 插件 | 用途 |
|------|------|
| `headingBackspaceToParagraph` | 标题前按 Backspace / Delete → 直接转正文（不降级 h2→h1） |
| `tabIndent` | 列表项 Tab/Shift-Tab 走 `sinkListItem`/`liftListItem`；段落 / 标题 / code-like 节点插 4 空格 |
| `safeCommonmark` + `fixedEmphasisUnderscoreInputRule` | commonmark bundle 过滤掉上游有 bug 的 `emphasisUnderscoreInputRule`，换装带 `$` 锚点的修复版（详见下方"已修复的 upstream 问题"） |
| `safeGfm` + `fixedStrikethroughInputRule` | 同上，针对 gfm 的 `strikethroughInputRule` |
| `history` | 撤销 / 重做 |
| `math` + `mathEditPlugin` | LaTeX：点公式 → input/textarea 行内编辑 + KaTeX 实时预览 |
| `mermaidSyntax` + `mermaidEditPlugin` | ` ```mermaid ` 转自定义节点；点击 → textarea 行内编辑 + 异步渲染 |
| `listener` | `markdownUpdated` → 回写 store / 触发 hljs class 注入 |

---

## 数据流

### Store 与编辑器

```
documentStore (Pinia)
    ├── content: ref<string>            ← 编辑器当前文本（唯一来源）
    ├── lastSavedContent: ref<string>   ← 磁盘基线
    ├── currentFilePath: ref<string|null>
    └── dirty: computed<boolean>         ← content !== lastSavedContent

App.vue
    ├── documentStore.init(sampleMd)    // setup 阶段同步装入
    ├── <MilkdownEditor :model-value="documentStore.content"
    │                   @update:model-value="documentStore.setContent">
    ├── <EditorOutline :model-value="documentStore.content">
    └── 监听 Ctrl+S / blur / focus / cli-args / onCloseRequested

MilkdownEditor
    ├── createEditor() → ctx.set(defaultValueCtx, props.modelValue)
    ├── listenerCtx.markdownUpdated((_, md) => emit('update:modelValue', md))
    │     ↑ 触发 setContent → content.value 更新 → 反向回流为 props.modelValue
    └── watch(props.modelValue) → if (isInternalChange) return; createEditor({focus: true})
          ↑ 外部 setContent / loadContent 才会走到这里（echo 自己时被 isInternalChange 短路）
```

### 文件操作

```
打开 → documentStore.open()
    ├── confirmDiscardIfDirty()          // 脏盘弹确认
    ├── openDialog(MD_FILTERS)
    └── openPath(path)
          ├── readTextFile(path)
          └── loadContent(content, path)
                ├── content.value = content
                ├── lastSavedContent.value = content
                ├── echosToAccept = 1     // 等编辑器首次 echo
                └── startWatchOf(path)    // fs.watch 接管

保存 / Ctrl+S → documentStore.save()
    ├── currentFilePath 为空 → saveAs()
    ├── snapshot = content.value
    ├── lastSavedContent.value = snapshot       // 乐观推进（写盘前）
    ├── writeTextFile(path, snapshot)            //   ↑ 自己的 fs:watch 因此被过滤
    └── catch: lastSavedContent.value = previousBaseline  // 回滚
```

### 外部文件改动同步

```
fs:watch 回调 / window focus → checkExternalChange()
    ├── disk = readTextFile(path)
    ├── disk === lastSavedContent → 自己的写，忽略
    ├── disk === content → 同内容外部改动，只刷新基线
    ├── !dirty → 静默 loadContent(disk, path)
    └── dirty → 弹确认 → loadContent(disk, path) or 取消
```

设计原则：

- **自家写盘不打扰** —— `save()` 在 `writeTextFile` 之前就把 `lastSavedContent` 推进到本次 snapshot，自己触发的 fs:watch 事件看到 `disk === lastSavedContent` 直接被过滤
- **写盘抛错回滚** —— 不能让 dirty 状态因为一次失败的写盘永久错位
- **focus 兜底** —— `notify-rs` 在网络盘 / 原子 rename / Dropbox 等同步工具下会漏报，window focus 主动核对一次

### 单实例 + 文件关联

```
冷启动（双击 .md / `velo file.md`）
    ├── Rust setup() → 把 argv 中的 .md 路径暂存进 PendingCliArgs(Mutex<Vec<String>>)
    │     ↑ 不直接 emit —— webview 此时还没挂 listen，事件会丢
    └── 前端 onMounted → invoke('get_cli_args') 主动来拉 → openPath()

二次启动
    └── tauri-plugin-single-instance 回调
          ├── 现有实例的前端早就挂好 → app.emit('cli-args', paths)
          └── unminimize + focus 主窗口
```

### 大纲

```
documentStore.content → EditorOutline
    ├── parseHeadings()
    │     └── 内容派生 key (`${level}::${displayText}#${dupIdx}`) ← 跨编辑保持稳定
    ├── watch(modelValue) → 重建 tree + 清掉 collapsedKeys 中已消失的 key
    ├── flatList computed (考虑 collapsedKeys)
    ├── headingIndex computed (全树查询，含 ancestors 链)
    └── findCurrentHeading() (rAF 节流)
          └── scroll-spy: lastAbove → headingIndex → 自身被折叠则回退到最近可见祖先
```

### 公式 / Mermaid 行内编辑

```
点公式 / Mermaid → startEdit()
    ├── input/textarea + edit-preview（实时 KaTeX / Mermaid debounce 400ms）
    ├── Tab → 插 `\t` + dispatch input → 触发预览
    ├── Escape → cancel() → 恢复渲染态
    └── blur → save() → view.dispatch(setNodeAttribute) → ProseMirror update()

NodeView update(newNode)
    ├── valueChanged 判定 → 只在 value 真的变了才 showDisplay()
    └── Mermaid: 同时监听 window 'velo:theme-change' → 主题切换强制重渲染
```

### 暗色模式

```
editorStore.darkMode 改变 → App.vue 的 watch
    ├── document.documentElement.classList.toggle('dark', val)   // Tailwind
    ├── invoke('set_window_theme', { theme: val ? 'dark' : 'light' })   // 原生 title bar
    └── window.dispatchEvent(new CustomEvent('velo:theme-change'))      // Mermaid NodeView 重渲染
```

---

## 已修复的 upstream 问题

### Milkdown `markRule` 越界改写 inline code 内容

`@milkdown/preset-commonmark` 的 `emphasisUnderscoreInputRule` 和 `@milkdown/preset-gfm` 的 `strikethroughInputRule` 的正则末尾**没有 `$` 锚点**：

```ts
// @milkdown/preset-commonmark/src/mark/emphasis.ts
markRule(/\b_(?![_\s])(.*?[^_\s])_\b/, emphasisSchema.type(ctx), ...)

// @milkdown/preset-gfm/src/mark/strike-through.ts
markRule(/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)/, strikethroughSchema.type(ctx))
```

正则会扫到段落里**任意位置**的 `_x_` / `~~x~~`，包括 inline code 内部的（因为 `textBetween` 不带 mark 信息，code 里的字面字符同样会被 regex 看到）。`prosemirror-inputrules` 调 handler 时按"匹配紧贴光标"算 `start`：

```ts
handler(state, m, from - (m[0].length - text.length), to)
```

一旦匹配命中段落中间的某段 inline code，算出来的 `start` 落在光标附近，`tr.delete` / `tr.addMark` 跑到完全不相关的位置上 —— inline code 里的字被吞，光标附近的字符被错误加 emphasis。同时 handler 不插入用户当次键入，所以这次输入也会丢。

**修法**（`MilkdownEditor/index.vue`）：

1. 从 `commonmark` / `gfm` 的 bundle 里过滤掉这两条 buggy rule：
   ```ts
   const safeCommonmark = commonmark.filter(p => p !== emphasisUnderscoreInputRule)
   const safeGfm = gfm.filter(p => p !== strikethroughInputRule)
   ```
2. 注册一对带 `$` 锚点的修复版顶上：
   ```ts
   const fixedEmphasisUnderscoreInputRule = $inputRule(ctx =>
     markRule(/\b_(?![_\s])(.*?[^_\s])_\b$/, emphasisSchema.type(ctx), { ... })
   )
   const fixedStrikethroughInputRule = $inputRule(ctx =>
     markRule(/(?<![\w:/])(~{1,2})(.+?)\1(?!\w|\/)$/, strikethroughSchema.type(ctx))
   )
   ```

`emphasisStarInputRule` / `strongInputRule` / `inlineCodeInputRule` 的正则末尾本来就有 `$`，是安全的，不需要替换。

等 upstream 修了之后可以移除 `safeCommonmark` / `safeGfm` 过滤和 `fixedXxxInputRule` 替换。

---

## 维护者注意点

1. **路径别名** —— `@/` → `src/`（Vite 8 `tsconfigPaths`）

2. **样式分层** —— MilkdownEditor 基础排版在 `index.vue` 内联 `<style>`；公式 / Mermaid 走 SCSS partial

3. **NodeView 隔离** —— `ignoreMutation()` + `stopPropagation` 隔离 ProseMirror；blur 触发 save

4. **echo 哨兵（`echosToAccept`）** —— 编辑器首次 mount 会回吐一次"规范化后"的 markdown，store 通过这个计数把这次回吐采纳为新基线，dirty 因此保持 false。任何"我们主动塞进编辑器一份新内容"的代码路径（`init` / `loadContent`）都要正确设置 `echosToAccept = 1`，否则首个 echo 就会被当成用户编辑、立刻 dirty

5. **Plan B 模块身份** —— `safeCommonmark = commonmark.filter(p => p !== emphasisUnderscoreInputRule)` 依赖于两端导入指向同一个模块实例。如果 upstream 重构破坏了这个等式，过滤会**静默失败** —— bug 回归而构建 / 类型检查都不会报错。Milkdown 升级时记得手动验证：
   - 打开示例文档
   - 在 `` `_斜体_` `` 这种 inline code 后面任意位置敲一下空格
   - 看 inline code 内容有没有被破坏

6. **fs.watch 生命周期 race** —— `startWatchOf` / `stopWatch` 从 `loadContent` 是 fire-and-forget。连续切文件时理论上能泄漏一个旧 watcher。今天没观察到 user-visible 影响（旧 watcher 触发时 `currentFilePath` 已经变了，`checkExternalChange` 早退）；如果哪天观察到泄漏 fd / 错误事件，给 `startWatchOf` 加一个 sequence number 把它串行化

7. **`onCloseRequested` 未取消** —— Tauri 的 `onCloseRequested` 返回一个 unlisten fn，目前没存。HMR 重挂时会叠加 handler，dev 体验略差；prod 一次性的生命周期不受影响

8. **Tauri 权限 scope** —— `capabilities/default.json` 把 `fs:allow-{read,write,exists,watch,unwatch}` 都开到了 `**`，因为是通用文本编辑器。如果未来要分发硬化版本（沙箱 / 仅限工作目录），需要收紧 scope

9. **`syncTitle` 调用频率** —— `setContent` 每次都 `void syncTitle()`，等于每个键击触发一次 Tauri `setTitle` IPC。功能上没问题，但 IPC 通道在长会话下有点吵 —— 想优化可以改成只在 `fileName` 或 `dirty` 真的变化时调

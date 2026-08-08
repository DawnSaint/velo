# Tree-shaking 清理清单

> 三路并行排查后汇总。完成后删除本文件。
> 排查维度:① 未使用文件/导出 ② 文件内死代码 ③ 依赖与重导出。

---

## A. 确定可删(删掉不影响功能) — 优先处理

### A1. 整份死文件
- [x] 删除 `src/components/ProseMirrorEditor/nodes/incrementalDeco.ts`(4 个 export 全仓 0 引用)

### A2. 死导出(单个符号)
- [x] `ProseMirrorEditor/editor/tableEditor.ts`:删除 `getTableEditorView()`(全仓 0 调用)
- [x] `ProseMirrorEditor/nodes/langIcons.ts`:删除 `LANG_ICON_INNER`(全仓 0 import)
- [x] `lib/cjkFormatter/index.ts:24`:删除 `export { DEFAULT_CJK_FORMATTING }`(`@deprecated`,全项目 0 import)

> 复核修正:`stores/workspace.ts` 的 `SIDEBAR_WIDTH_DEFAULT` 虽无外部 import,但在本文件内部用了 7 次(clamp 默认值/初始 state/reset),属"是否内联常量"的风格问题,非死代码,已从 A2 移到 F。`utils/quickCommand.ts` 的 `QuickCommandMode`/`ParsedQuickCommand` 是 `parseQuickCommand` 返回值类型的组成部分,属函数公共 API,已从 A2 移到 F。

### A3. package.json 冗余依赖(remark 传递依赖,源码 0 import)
- [x] 移除 `mdast-util-find-and-replace`
- [x] 移除 `mdast-util-from-markdown`
- [x] 移除 `mdast-util-gfm`
- [x] 移除 `mdast-util-to-markdown`

### A4. Cargo.toml 冗余依赖 + 空 feature
- [x] 移除 `windows_core` crate(代码用的是 `windows` crate 里的 `windows::core::*`)
- [x] 移除 `Win32_System_Com` feature(`CoInitialize/CoCreateInstance/STGMEDIUM` 0 命中)
- [x] 移除 `Win32_System_Variant` feature(`VariantInit/VARIANT` 0 命中)
- [x] 移除 `Win32_UI_Shell_Common` feature(`IShellItem/AssocCreate/SHParseDisplayName` 0 命中)

> 注:`Win32_Foundation` feature 同步移除(全仓 HRESULT/BOOL/HANDLE 0 命中);`Win32_Foundation` 在清单里未单独列出但已一并清理。
>
> ⚠ 复核修正:`serde_json` 必须保留 —— `tauri::generate_context!()` 宏展开需要它在 crate root 可用,即便源码无直接 `serde_json::` 调用。初次移除后 `cargo build` 报 E0433,已恢复。已从 A4 移到 F。

### A5. capabilities 声明但运行时未用
- [x] 移除 `core:window:allow-internal-toggle-maximize`(`toggleMaximize()` 用的是已声明的 `allow-toggle-maximize`)
- [x] 移除 `core:window:allow-set-decorations`(Rust 端 `.decorations()` 是构建期 `WebviewWindowBuilder` 方法,不消耗运行时权限)

---

## B. 重复 / 被覆盖(可抽取合并)

- [x] `stores/document.ts` ↔ `stores/export.ts`:两份同构 `formatError` → 抽到 `utils/formatError.ts`,两 store 改用共享导入
- [x] `App.vue` ↔ `stores/document.ts`:两份 `isMacOS` 检测 → 抽到 `utils/platform.ts`,两处改用共享导入(App.vue 保留 `tauri &&` 守卫语义)
- [ ] `utils/statusPath.ts:5 basenameOfPath` ↔ `Sidebar/treeUtils.ts:17 basename`:路径取basename — ⚠ 复核后保留差异

> B3 复核修正:实际存在**三份** basename(treeUtils.basename / statusPath.basenameOfPath / imageStorage.basenameSync + treeDrop.basename),实现与用途均不同(treeUtils 版纯 lastIndexOf;statusPath 版带 normalize + 剥尾 slash;image 两份是模块私有供 NodeView 同步构造),强行合并风险高,标记为保留差异。

---

## C. 疑似 bug(哨兵 stale 值)

- [x] `EditorInner.vue:638` 与 `SourceModeEditor.vue:92` 同构:`lastSelfEmitted` 哨兵 — ⚠ 复核后确认非 bug

> C 复核修正:`lastSelfEmitted` 是**一次性 echo 哨兵**(打断 emit→prop→watch→再 dispatch 的无限循环),设计为不重置。stale 值场景下"外部改回同值"会被跳过,但这正是期望行为(内容本就一致无需同步);真正"外部改成不同值"时哨兵不命中、正常同步。已从 C 移到 F。

---

## D. 分类错位

- [x] `@tauri-apps/cli` 从 `dependencies` 移到 `devDependencies`(仅 `tauri:dev`/`tauri:build` 脚本调用二进制,`src/` 0 import)

---

## E. 需人工复核 / 编译验证后再动

- [ ] `Win32_Foundation` feature:倾向冗余,删前 clean build 验证
- [ ] `serde_json`(Cargo):可能经 tauri IPC 间接需要,`cargo build` 后确认
- [ ] `utils/workspaceSearch.ts` 6 个导出类型(`WorkspaceSearchPhase`/`WorkspaceSearchFileEntry`/`Callbacks`/`SearchResult`/`ReplaceFailure`/`ReplaceResult`):无显式 import,可清理导出面
- [ ] `cjkFormatter/rules/` 空白压缩:`universal.ts:collapseNewspaces`/`spacing.ts:collapseSpaces`/`cleanup.ts:removeTrailingSpaces` 三者可能重叠,读 `applyRules.ts` 确认

---

## F. 排查后确认不成立(避免误删,仅作记录)

- `serde_json`(Cargo) — 源码无直接调用,但 `tauri::generate_context!()` 宏需要它在 crate root,不可移除
- `lastSelfEmitted` 哨兵(EditorInner / SourceModeEditor)— 一次性 echo 循环打断器,不重置是有意为之,非 stale 值 bug
- `stores/workspace.ts` 的 `SIDEBAR_WIDTH_DEFAULT` — 无外部 import,但本文件内部用 7 次,属风格问题非死代码
- `utils/quickCommand.ts` 的 `QuickCommandMode` / `ParsedQuickCommand` — `parseQuickCommand` 返回值类型的组成部分,属函数公共 API
- `statusPath.ts` / `markdownPath.ts` / `breadcrumbs.ts` — 三者职责不重叠
- `quickCommand.ts` vs `commandPalette.ts` — 均被 `QuickCommandPanel` 用
- `markdownIO.ts` 小/大文档 — 阈值分支在 `document.ts`,IO 层只有同步 + 异步 Worker 两入口
- `breadcrumbs.ts` 的 `headingChainFromDoc` / `headingChainFromMarkdown` — 输入形态不同,均被使用
- 所有 `stores/*`、`utils/*`、`composables/*`、`lib/export/*` 文件 — 全在用

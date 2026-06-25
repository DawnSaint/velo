# Tauri Boundary

> **本文件负责**: Tauri API 封装层、capabilities、CLI/single-instance、Windows 文件夹右键菜单与 web-dev 降级。
>
> **何时阅读**: 改 `src/tauri/*`、`src-tauri/*` command/capability、CLI 参数、single-instance 或 Windows shell 集成时。
>
> **先记住**:
> - 业务侧只 import `src/tauri/*`，不要直 import `@tauri-apps/*`。
> - dev web 端 Tauri API 必须用 `tauriOnly()` / `isTauri()` 守门。
> - `capabilities/default.json` 当前 fs scope 为 `**`，这是本地编辑器的显式取舍。
> - Windows 文件夹右键菜单写 HKCU，启动期 best-effort 重写，不阻塞应用。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [导出](./export.md) / [测试](./testing.md)


## 数据流

**单实例 + 文件关联**: 冷启动走 `PendingCliArgs` + `get_cli_args`;二次启动走 `tauri-plugin-single-instance` → `cli-args` 事件。argv 解析(`parse_cli_args`)同时返回 `{files: .md 路径, dirs: 目录路径}`:files 路由 `documentStore.openPath`,dirs 路由 `workspaceStore.setActiveRoot`(目录与文件互不冲突,工作区根 + 当前文档各管各的);二次启动走目录分支**不**弹 dirty 确认——切工作区不动当前编辑文档。Windows "在 Velo 中打开"右键菜单(v0.5.1)由 `folder_menu::ensure_registered` 在 `setup()` 写 HKCU\Software\Classes\Directory\shell\OpenInVelo,启动期 best-effort 每次重写(见设计要点)。

---

## 设计要点

- **"在 Velo 中打开"文件夹右键菜单走 HKCU 注册表 + 每启动 best-effort 重写**: `folder_menu::ensure_registered` 写在 HKCU\Software\Classes\Directory\shell\OpenInVelo(verb 子键 + command 子键),不写 HKLM —— HKCU 不需要 UAC 提升,普通用户启动即可注册;Windows shell 解析 Classes 时合并 HKCU+HKLM,效果等价。每次 `setup()` 重写而非"仅缺时写":自动跟随 exe 路径变化(用户把 Velo 拖到别处的场景),HKCU 写盘是同步快速 op 无可感知开销。命令模板 `"<exe>" "%1"` —— `%1` 而非 `%V`(后者用于 Directory\Background\shell 空白右键,本菜单挂的是 Directory\shell 即"右键文件夹"),引号必加防止路径含空格被拆词。失败仅 log::warn 不抛 —— Velo 是本地编辑器,菜单是 nice-to-have,启动不该被注册表故障阻塞


---

## 维护者注意点

- **Tauri 权限**: `capabilities/default.json` fs 开 `**`(通用文本编辑器),分发时收紧
- **clipboard 统一走** `@tauri-apps/plugin-clipboard-manager` 的 `writeText`
- **dev web 端 Tauri API 必须 `isTauri()` 守门**: 纯 vite 调 `@tauri-apps/api/*` 同步 throw,单行 throw 会让 async 整条 reject。`persistence.ts` 走 `tauriOnly()`;`App.vue` 顶层 `const tauri = isTauri()`,fire-and-forget 异步 `if (tauri)` 守门,onMounted await 链路整段 `if (tauri) { ... }` 包裹
- **PDF 走隐藏打印窗口而非主 webview**: `Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 上下文,弹不出反馈且应用回不来;隐藏窗口让主应用全程不动。初始 URL 选 `about:blank`(tauri-runtime-wry 对其特判为"不设初始 URL",避免"初始页 vs data URL"两个 NavigationCompleted 竞态)。Windows: cast `ICoreWebView2_7` 拿 PrintToPdf、cast `ICoreWebView2Environment6` 拿 CreatePrintSettings(v1 环境没这方法);`SetShouldPrintBackgrounds(true)` 必开(默认不打印背景,alert SVG / 代码块底色 / 暗色底全丢)。HTML 注入靠 `navigate("data:text/html;base64,...")`(需 `webview-data-url` feature)。`PRINT_LOCK` 防并发,30s 超时兜底。**新建窗口必须在 async command 里做**(`WebviewWindowBuilder::build` 从同步 command / 事件 handler 调会死锁);**闭包不能 self-reference**(webview7/settings 必须 move 进 handler)。macOS / Linux 待实现
- **Tauri 2 plugin-opener 只能 desktop**: `revealItemInDir` 移动端 unsupported,Velo 当前只打 desktop,future 加 mobile entry 时需自行在 capability / 调用点降级(消息弹"不支持")

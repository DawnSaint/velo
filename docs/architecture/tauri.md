# Tauri Boundary

> **本文件负责**: Tauri API 封装层、capabilities、CLI/single-instance、Windows NSIS 安装器集成（文件关联 + 文件夹/md 文件右键菜单 + per-user 安装）、web-dev 降级。
>
> **何时阅读**: 改 `src/tauri/*`、`src-tauri/*` command/capability、CLI 参数、single-instance、Windows shell 集成或 NSIS 安装器 hooks 时。
>
> **先记住**:
> - 业务侧只 import `src/tauri/*`，不要直 import `@tauri-apps/*`。
> - dev web 端 Tauri API 必须用 `tauriOnly()` / `isTauri()` 守门。
> - `capabilities/default.json` 当前 fs scope 为 `**`，这是本地编辑器的显式取舍。
> - Windows 文件夹右键菜单运行时写 HKCU（best-effort 重写，不阻塞应用）；安装器也写 HKCU（per-user only，SHCTX=HKCU）。
> - 文件关联（ProgID 始终注册、默认打开可选）、文件夹右键菜单、md 文件右键菜单由 NSIS installer hooks 手动管理（非 `bundle.fileAssociations`），安装时用户可选，卸载时自动注销。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [导出](./export.md) / [测试](./testing.md)


## 数据流

**单实例 + 文件关联 + 多窗口(v0.5.6)**: 冷启动走 per-window pending payload:`setup()` 将 argv 解析结果挂到 `main` label,前端按 `getCurrentWindow().label` 调 `take_window_cli_args` 领取;二次启动仍由 `tauri-plugin-single-instance` 拦截,但不再 `app.emit("cli-args")` 广播给所有窗口,而是 async spawn 创建新的 Velo app window,并把 `{files, dirs}` 绑定到该新 window label。argv 解析(`parse_cli_args`)同时返回 `{files: .md 路径, dirs: 目录路径}`:files 路由 `documentStore.openPath`,dirs 路由 `workspaceStore.setActiveRoot`(目录与文件互不冲突,工作区根 + 当前文档各管各的)。

---

## 设计要点

- **可见 app window label 与权限**:主窗口显式 label 为 `main`,动态 app window 使用 `velo-window-{n}`;`capabilities/default.json` 只授权 `main` + `velo-window-*`,不要用 `*`,避免隐藏 PDF printer window 拿到完整编辑器权限。多窗口不是多标签:每个 WebView 拥有自己的 Pinia runtime,当前工作区 / 当前文档 / dirty prompt 都按窗口隔离。
- **动态 app window 走 async 创建 + per-window bootstrap**:二次启动 / 顶栏新窗口入口都创建新 WebView window,启动参数先按 label 写入 pending map,前端挂载后领取。不要恢复全局 `cli-args` 广播;多窗口下广播会让所有窗口同时切工作区 / 打开文件。`WebviewWindowBuilder::build` 不要在 single-instance 同步回调里直接调用,必须 `tauri::async_runtime::spawn` 后再建,延续 PDF 窗口踩坑。
- **"在 Velo 中打开"文件夹右键菜单走 HKCU 注册表 + 每启动 best-effort 重写**: `folder_menu::ensure_registered` 运行时写 HKCU\Software\Classes\Directory\shell\OpenInVelo(verb 子键 + command 子键),不写 HKLM —— HKCU 不需要 UAC 提升,普通用户启动即可注册。每次 `setup()` 重写而非"仅缺时写":自动跟随 exe 路径变化(用户把 Velo 拖到别处的场景),HKCU 写盘是同步快速 op 无可感知开销。命令模板 `"<exe>" "%1"` —— `%1` 而非 `%V`(后者用于 Directory\Background\shell 空白右键,本菜单挂的是 Directory\shell 即"右键文件夹"),引号必加防止路径含空格被拆词。失败仅 log::warn 不抛 —— Velo 是本地编辑器,菜单是 nice-to-have,启动不该被注册表故障阻塞。

- **NSIS 安装器集成 — 文件关联 + 文件夹/md 文件右键菜单安装时可选、卸载时自动注销; `installMode: currentUser` per-user only**: Windows 安装器从 MSI(WiX)切换为 NSIS-only。NSIS 通过自定义模板 + installer hooks 实现用户可选的 shell 集成:
  - **移除 MSI target 与 `bundle.fileAssociations`**: MSI 安装器在已安装旧版本时会弹出"更改/修复/删除"维护页面(Windows Installer 行为),阻止覆盖安装;且 MSI/WiX 无法通过 Tauri 配置注入自定义安装页面(需写 WiX UI Fragment,Tauri 2 未暴露入口)。`bundle.fileAssociations` 会让安装器无条件注册文件关联,与"用户可选"需求冲突。改为 NSIS-only + installer hooks 手动写注册表。
  - **自定义 NSIS 模板**(`src-tauri/nsis/installer.nsi`): 基于Tauri 默认模板,插入一个自定义页面:附加任务 checkbox 页 `Page custom PageTasks LeaveTasks`。模板通过 `bundle.windows.nsis.template` 引用。**维护注意**: 升级 Tauri 版本时需 diff 默认模板,合并上游变更到自定义模板。
  - **`allowDowngrades: true`**: 允许覆盖安装(同版本 / 降级均直接装,不强制卸载旧版)。
  - **`installerIcon` / `uninstallerIcon`**: Tauri 的 `{{installer_icon}}` 模板变量仅在 `bundle.windows.nsis.installerIcon` 显式设置时才填充(源码 `nsis/mod.rs` 中 `if let Some(installer_icon)` 守门,无 fallback 到 `bundle.icon`)。不设置时模板渲染为空字符串,`MUI_ICON` 不被定义,NSIS 回退默认图标。需显式指定 `"installerIcon": "icons/icon.ico"` 和 `"uninstallerIcon": "icons/icon.ico"`(路径相对于 `src-tauri/`)。
  - **`installMode: currentUser`（per-user only）**: 安装到 `$LOCALAPPDATA\Velo`，不需要 UAC 提升，**启动时不弹管理员权限**。与 VS Code / Typora / Obsidian 等现代 Windows 应用对齐。`SHCTX` 定义为 `HKCU`，所有 shell 集成项写 HKCU。偏好标志也写 HKCU。无 `MultiUser.nsh`、无延迟提权、无 `PageInstallDir` 自定义页面，使用标准 `MUI_PAGE_DIRECTORY`。
  - **与旧版 per-machine 安装共存**: 从 per-machine 切换到 per-user only 后,新安装器不会卸载旧的全局安装。两者文件路径不同（`Program Files\Velo` vs `$LOCALAPPDATA\Velo`）不冲突;Shell 集成写 HKCU,Windows 合并 HKCU + HKLM Classes 时 HKCU 优先,新安装的行为覆盖旧的。旧的全局安装残留在"控制面板"中,用户可手动卸载。
  - **Additional Tasks 页面(installer-hooks.nsh `PageTasks` / `LeaveTasks`)**: VS Code 风格的 checkbox 页面,位于目录选择页之后、安装页之前。三个 checkbox:① 「将 Markdown 文件设为默认使用 Velo 打开」(默认**不勾选**)②「添加"在 Velo 中打开"到文件夹右键菜单」(默认勾选)③「添加"在 Velo 中打开"到 Markdown 文件右键菜单」(默认勾选)。用户点击 Next 后,checkbox 状态存入 `$VeloOptDefaultOpen` / `$VeloOptFolderMenu` / `$VeloOptMdMenu` 变量,供 `NSIS_HOOK_POSTINSTALL` 读取。静默/被动安装模式(`/S` / `/P`)下跳过此页,默认 DefaultOpen=0、FolderMenu=1、MdMenu=1。用户选择写入偏好标志 `HKCU\Software\com.velo.editor\ShellIntegration\{DefaultOpen,FolderMenu,MdMenu}`("1"/"0")。
  - **文件关联注册表布局(写 HKCU)**: ProgID `Velo.md` **始终注册**(下设 `DefaultIcon` / `shell\open\command`)。仅当 DefaultOpen 勾选时,才将 `.md` / `.markdown` / `.mdown` 三个扩展名的 `(Default)` 指向 ProgID `Velo.md`,同时备份原有关联到 `Velo.md_backup` 值(卸载时恢复),并调 `SHChangeNotify` 刷新 Shell。
  - **文件夹右键菜单注册表布局(写 HKCU + 运行时 HKCU 刷新)**: `HKCU\Software\Classes\Directory\shell\OpenInVelo` 设 `(Default)` = "在 Velo 中打开"、`Icon` = `<exe>,0`;`\command` 设 `(Default)` = `<exe> "%1"`。运行时 `folder_menu::ensure_registered` 写 HKCU 刷新(重写 exe 路径)。
  - **md 文件右键菜单注册表布局(写 HKCU,通过 SystemFileAssociations)**: `HKCU\Software\Classes\SystemFileAssociations\.{md,markdown,mdown}\shell\OpenInVelo` 设 `(Default)` = "在 Velo 中打开"、`Icon` = `<exe>,0`;`\command` 设 `(Default)` = `<exe> "%1"`。使用 `SystemFileAssociations` 而非 ProgID verb:这样无论 .md 是否关联到 Velo,右键菜单都出现「在 Velo 中打开」(独立于文件关联 checkbox)。无运行时刷新(exe 路径安装后不变)。
  - **卸载自动注销**: `NSIS_HOOK_PREUNINSTALL` 恢复 HKCU 备份的文件关联、删除 HKCU ProgID `Velo.md`、删除 HKCU 文件夹右键菜单键、删除 HKCU md 文件右键菜单键、删除 HKCU 偏好标志。全部注册表操作在卸载器中完成,运行时无需做注销。
  - **运行时 `folder_menu::ensure_registered` 读偏好标志**: 安装时用户选择写入 `HKCU\Software\com.velo.editor\ShellIntegration\FolderMenu`。运行时读取该标志:`"1"` → 刷新注册表(重写 exe 路径);`"0"` → 跳过(用户选择了不注册);未设置 → 照常注册(便携模式 / 旧版升级,向后兼容)。
  - **从旧版 MSI 升级**: NSIS 安装器内置 WiX 检测逻辑(`PageReinstall` 函数中遍历 `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` 匹配 `ProductName` + `Publisher`),检测到旧版 MSI 安装会提示用户先卸载,卸载后继续正常 NSIS 安装流程。非 WiX 模式直接跳过 PageReinstall 页面(`allowDowngrades: true` 覆盖安装,无需先卸载)。
  - **`release-please-config.json` 的 `extra-files` 配置**: Cargo.toml 必须用显式 `{"type":"toml","path":"...","jsonpath":"$.package.version"}`,不能用纯字符串 `"src-tauri/Cargo.toml"`。release-please 的 `GenericToml` updater 要求 `jsonpath` 参数,纯字符串虽检测到 `.toml` 扩展名但 `jsonpath` 为空 → JSONPath 查询返回 0 结果 → 文件不被修改(v0.6.6 release 时 Cargo.toml 未被 bump 就是这个原因)。Cargo.lock 不需要 release-please 管理,`cargo build` 时自动更新。
  - **`CheckIfAppIsRunning` 替换为内联代码**: Tauri 默认的 `utils.nsh` 中 `CheckIfAppIsRunning` 宏在用户点"取消"时调用 `Abort`(在 Section 中只停止当前 Section,不关闭安装器窗口 → 安装页面卡住)。替换为内联代码,取消路径改为 `Quit`(直接关闭安装器),安装在 Install 和 Uninstall 两个 Section 中各内联一份(标签前缀 `velo_` / `un_velo_` 避免冲突)。


---

## 维护者注意点

- **Tauri 权限**: `capabilities/default.json` fs 开 `**`(通用文本编辑器),分发时收紧
- **clipboard 统一走** `@tauri-apps/plugin-clipboard-manager` 的 `writeText`
- **dev web 端 Tauri API 必须 `isTauri()` 守门**: 纯 vite 调 `@tauri-apps/api/*` 同步 throw,单行 throw 会让 async 整条 reject。`persistence.ts` 走 `tauriOnly()`;`App.vue` 顶层 `const tauri = isTauri()`,fire-and-forget 异步 `if (tauri)` 守门,onMounted await 链路整段 `if (tauri) { ... }` 包裹
- **PDF 走隐藏打印窗口而非主 webview**: `Navigate(data:...)` 会销毁主 webview 的 Vue 应用 + `invoke` promise 上下文,弹不出反馈且应用回不来;隐藏窗口让主应用全程不动。初始 URL 选 `about:blank`(tauri-runtime-wry 对其特判为"不设初始 URL",避免"初始页 vs data URL"两个 NavigationCompleted 竞态)。Windows: cast `ICoreWebView2_7` 拿 PrintToPdf、cast `ICoreWebView2Environment6` 拿 CreatePrintSettings(v1 环境没这方法);`SetShouldPrintBackgrounds(true)` 必开(默认不打印背景,alert SVG / 代码块底色 / 暗色底全丢)。HTML 注入靠 `navigate("data:text/html;base64,...")`(需 `webview-data-url` feature)。`PRINT_LOCK` 防并发,30s 超时兜底。**新建窗口必须在 async command 里做**(`WebviewWindowBuilder::build` 从同步 command / 事件 handler 调会死锁);**闭包不能 self-reference**(webview7/settings 必须 move 进 handler)。macOS / Linux 待实现
- **Tauri 2 plugin-opener 只能 desktop**: `revealItemInDir` 移动端 unsupported,Velo 当前只打 desktop,future 加 mobile entry 时需自行在 capability / 调用点降级(消息弹"不支持")
- **F12 开 DevTools + perf 打点 prod 开关**: `Cargo.toml` 开了 `devtools` feature,release 包也能开 DevTools。`App.vue` 注册 F12 → `invoke('open_devtools')`(dev 环境 Vite 自带 F12,invoke 会失败,catch 掉)。`src/utils/perf.ts` 是首屏性能打点工具(Performance API mark/measure + FCP/LCP),dev 自动启用,production 可通过 `localStorage.setItem('velo.perf','1')` + 刷新临时开启,测完 `removeItem` 关掉恢复 no-op。PerformanceObserver 必须页面早期注册才能抓 FCP/LCP,所以 flag 在模块加载时读一次,设了 flag 必须刷新才生效。埋点位置:`main.ts`(`script-start`)、`App.vue`(`settings-ready`/`code-block-ready`/`mounted`/`editor-mounted`),`editor-mounted` 时 `console.table` 输出 measure 汇总

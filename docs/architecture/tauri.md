# Tauri Boundary

> **本文件负责**：Tauri 边界 —— `src/tauri/*` 封装层、capabilities 权限、窗口创建与启动时序、CLI / single-instance、Windows NSIS 安装器与 shell 集成、web-dev 降级、GPU 硬件加速、Git 历史 / 工作区搜索 Rust 命令、应用自动更新。
>
> **何时阅读**：改 `src/tauri/*`、`src-tauri/src/*`、`tauri.conf.json` / `capabilities/`、NSIS 模板、CLI 与 single-instance、Windows shell 集成、updater 配置或 CI 签名时。
>
> **代码入口**：`src/tauri/{fs,dialog,path,window,git,workspace}.ts`、`src-tauri/src/{lib,file_assoc,folder_menu,linux_menu,gpu_accel,git,workspace,pdf,pdf_windows}.rs`、`src-tauri/nsis/{installer.nsi,installer-hooks.nsh}`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [导出](./export.md) · [测试](./testing.md)

## 红线

- **业务侧只 import `src/tauri/*`**，不直 import `@tauri-apps/*`（测试 mock 单一入口）。
- **dev web 端 Tauri API 必须 `tauriOnly()` / `isTauri()` 守门**：纯 Vite 下调 `@tauri-apps/api/*` 会同步 throw，整条 async 链 reject。
- **capability 只授权 `main` + `velo-window-*`**，不用 `*` —— 避免隐藏 PDF 打印窗口拿到完整编辑器权限。
- **所有窗口一律 `visible(false)` 创建**，由前端首帧 `invoke('show_main_window')` 显示；不要改成配置驱动或可见创建（会露 WebView2 导航期白底）。
- **新建窗口必须在 async command 内 `tauri::async_runtime::spawn`**：`WebviewWindowBuilder::build` 从同步 command / 事件 handler 调会死锁。
- **Windows 下 spawn 外部程序前确认子进程 PE subsystem**：CUI 程序（git / where / cmd / powershell）必须 `CREATE_NO_WINDOW`，否则刷出一串 CMD 窗口。
- **不恢复全局 `cli-args` 广播**：多窗口下广播会让所有窗口同时切工作区 / 打开文件。
- **不改 `capabilities/default.json` 的 fs `**` scope**（本地编辑器的显式取舍，分发时收紧）。
- **不重新引入 macOS Finder 服务旧实现**（`finder_service.rs` 那套会崩，见「关键取舍」）。
- **NSIS 模板升级 Tauri 时必须 diff 上游默认模板合并变更**（`src-tauri/nsis/installer.nsi` 是定制副本）。

## 架构

### 封装层

| 模块 | 职责 |
| --- | --- |
| `src/tauri/fs.ts` | `plugin-fs` 薄封装 + `tauriOnly()`；`watchImmediate` 专供工作区根递归监听 |
| `src/tauri/dialog.ts` | 只 re-export `open` / `save`；确认类 UI 走 `useConfirmStore` + `VeloConfirmDialog.vue` |
| `src/tauri/path.ts` | `appDataDir` / `join` / `dirname` / `sep` 等常用 path API |
| `src/tauri/window.ts` | `takeWindowCliArgs` / `newAppWindow` / `showMainWindow` / `getCurrentWindowLabel` |
| `src/tauri/git.ts` | `git_repo_root` / `git_file_history` / `git_show_file` + snake→camel |
| `src/tauri/workspace.ts` | `scan_workspace_files` / `search_workspace`(Channel) / `cancel_workspace_search` / `replace_workspace` |
| `src/utils/clipboard.ts` | 唯一剪贴板写入口 `writeClipboardText`（plugin 失败回退 `navigator.clipboard`） |

### 窗口与启动时序

- `tauri.conf.json` 的 `app.windows` 为空数组；主窗口在 `setup()` 中 `create_window(handle, "main", payload)` 代码创建（原因见「关键取舍」）。
- **per-window pending payload**：`setup()` 把 argv 解析结果按 label 挂到 pending map，前端按 `getCurrentWindow().label` 调 `take_window_cli_args` 领取；二次启动由 `tauri-plugin-single-instance` 拦截后 `new_app_window` 创建新窗口并绑定 payload。
- **隐藏创建 + 首帧 show**：前端首帧渲染完 `invoke('show_main_window')`；`ShownWindows` 保证每窗口只 show 一次，`create_window` 另注册 3s 兜底线程防前端异常导致永久隐藏。
- **CLI 路由**：`parse_cli_args` 把 argv 归 `{files, dirs}`；`dirs` → `workspaceStore.setActiveRoot`，`files` → `documentStore.openPathInTab`（无 dirs 时取文件父目录作工作区根）。files/dirs 任一非空时 `App.vue` 启动链置 `leftPanelView='sidebar'` + `sidebarTab='files'`，且 `shouldRestoreActive=false`（不恢复持久化工作区 / 标签）。
- **多窗口不是多标签**：每个 WebView 有独立 Pinia runtime，工作区 / 文档 / dirty prompt 按窗口隔离。

### capabilities / 权限

`capabilities/default.json`：`windows: ["main", "velo-window-*"]`；权限含 `core:default` / `fs:default` / `dialog:default` / `clipboard-manager:default` / `shell:default` / `opener:default` / `updater:default` / `process:default`，加窗口标题 / 缩放 / 事件监听，以及 fs 全量操作的 `path: "**"`。`core:webview:allow-set-webview-zoom` 供 `useZoom` 调 `setZoom`。

### Rust 命令清单

| 来源 | 命令 |
| --- | --- |
| `lib.rs` | `take_window_cli_args` / `show_main_window` / `new_app_window` / `open_devtools` / `export_pdf` / `gpu_accel_state` / `set_gpu_accel` / `open_default_apps_settings` / `shell_integration_state` / `set_shell_integration` |
| `git.rs` | `git_repo_root` / `git_file_history` / `git_show_file` |
| `workspace.rs` | `scan_workspace_files` / `search_workspace` / `cancel_workspace_search` / `replace_workspace` |
| `file_assoc.rs` | `open_settings`（被 `open_default_apps_settings` 调用） |
| `gpu_accel.rs` | `gpu_accel_enabled` / `set_gpu_accel` / `additional_browser_args_if_disabled` |
| `pdf.rs` / `pdf_windows.rs` | PDF 导出实现，见 [export.md](./export.md) |

### NSIS 与 shell 集成

- `bundle.windows.nsis.template` = `src-tauri/nsis/installer.nsi`（Tauri 默认模板 + 自定义 `PageTasks` / `LeaveTasks` 附加任务页），`installerHooks` = `installer-hooks.nsh`。
- `installMode: "currentUser"`：装到 `$LOCALAPPDATA\Velo`，免 UAC，`SHCTX=HKCU`。`allowDowngrades: true` 允许同版本 / 降级覆盖安装。
- `installerIcon` / `uninstallerIcon` 必须显式设置 —— 模板变量 `{{installer_icon}}` 无 fallback 到 `bundle.icon`，不设则 `MUI_ICON` 未定义、NSIS 回退默认图标。
- **附加任务页**：位于目录选择页后、安装页前，两个 checkbox（文件夹菜单 / md 文件菜单）默认勾选；状态写 `HKCU\Software\com.velo.editor\ShellIntegration\{FolderMenu,MdMenu}`。被动模式（`$PassiveMode=1`）跳过该页并默认都装。
- **注册表布局**：
  - ProgID `Velo.md` + `RegisteredApplications` + `Capabilities\FileAssociations` **始终注册**（保证出现在「打开方式」和「默认应用」列表）。
  - **不设默认程序**：Windows 10 1703+ 反劫持保护会回滚注册表直写 + 删 `UserChoice`；前端用 `open_default_apps_settings`（`ShellExecuteW` 打开 `ms-settings:defaultapps`）引导用户手动设。
  - 文件夹菜单：`HKCU\Software\Classes\Directory\shell\OpenInVelo`，command `"<exe>" "%1"`（`%1` 非 `%V`，引号防路径含空格拆词）。
  - md 菜单：`HKCU\Software\Classes\SystemFileAssociations\.{md,markdown,mdown,mkd,mkdown,mdwn,mdtxt,mdtext}\shell\OpenInVelo`（独立于文件关联 checkbox）；HKLM 同路径由卸载器清旧 per-machine 残留。
- **卸载自动注销**：`NSIS_HOOK_PREUNINSTALL` 删 ProgID / RegisteredApplications / Capabilities，自底向上清菜单树（`command` 子树先于父键），`SHChangeNotify` 刷新 Shell，删偏好标志。
- **运行时刷新**：`folder_menu::ensure_registered` 读偏好（`"1"` 刷新 exe 路径 / `"0"` 跳过 / 未设置 → 注册，兼容便携与旧版升级）。debug 构建 `#[cfg(debug_assertions)]` 只读写偏好不碰注册表 —— debug exe 是临时路径，写注册表会让右键菜单启动 debug 版连 Vite dev server + 弹终端窗口。
- **Linux**：`linux_menu::ensure_registered` 按 `$XDG_CURRENT_DESKTOP` 分发 —— KDE 写 `~/.local/share/kio/servicemenus/*.desktop`（`Actions=OpenInVelo`，文件须 chmod +x），GNOME / Nemo / Caja / MATE 写 `~/.local/share/nautilus/scripts/`；偏好文件 `~/.config/com.velo.editor/folder-menu`。Thunar / XFCE 无文件级机制，不支持；Linux 不注册 md 文件菜单。
- **macOS**：Finder 服务已移除，见「关键取舍」。
- 安装器内置 WiX 检测（`PageReinstall` 遍历 `HKLM\...\Uninstall` 匹配旧 MSI 的 ProductName + Publisher），提示先卸载旧版。

## 关键取舍

- **封装层是 thin re-export，刻意不统一错误形态**：各调用方有自己的降级策略（persistence 静默默认值 / document 弹原生 message / imageStorage 透传），统一形态会破坏现有语义。存在理由是测试 mock 单一入口 + 收敛 fs 调用点。
- **`watchImmediate` 专供工作区根**：`plugin-fs` 的 `watch()` 默认 `delayMs:2000` 走 notify-debouncer-full 分支，对整棵目录树 WalkDir 逐路径取 file id，而 `watch` 是同步 command 跑在主线程 —— 打开含 node_modules 的大目录会占死主线程。`watchImmediate` 强制 RecommendedWatcher，Windows 单句柄递归、注册 O(1)，去抖交前端 dirtyDirs + 120ms timer。单文件监听仍用 `watch({ delayMs: 100 })`。
- **主窗口代码创建而非配置驱动**：GPU 加速偏好必须经 `WebviewWindowBuilder::additional_browser_args` 在 WebView 创建时注入，`tauri.conf.json` 配置驱动窗口不支持该 builder 方法。
- **首屏零闪烁两段时序**：① 深浅色 —— `index.html` 在外部 CSS 前同步加载 `public/theme-boot.js`，读 localStorage `velo.theme-mode` 镜像 + `matchMedia` 给 `<html>` 上 `.dark` 与 `--surface-0` 同色兜底背景；`editorStore` 初值同源，磁盘 hydrate 后回写。外部同步脚本是硬要求（CSP `script-src` 只有 `'self'`，内联 `<script>` 会被拦），key / 枚举 / 色值必须与 `src/utils/themeBoot.ts` 同步维护。② 窗口可见 —— 隐藏创建 + 首帧 show。
- **macOS overlay 标题栏隐藏 title**：`titleBarStyle: Overlay` 下原生标题栏居中显示窗口 title，与自定义 header 重叠；`create_window` 设 `.title("")`，`documentStore.syncTitle()` 在 macOS 持续 `setTitle('')`。交通灯不受影响。
- **从 MSI 切到 NSIS-only**：MSI 在已装旧版时弹「更改/修复/删除」维护页阻止覆盖安装，且 WiX 无法注入自定义安装页；`bundle.fileAssociations` 无条件注册与「用户可选」冲突。
- **Git 历史走 git2 库化**：`git2`（libgit2 静态链入）`Repository::discover` + `revwalk` + `tree.get_path` + blob-id 去重，最多 100 条；开一次面板从 ~23 子进程 / ~1s 降到 0 / ~17ms，且不再依赖用户装 git。git2 失败回退 CLI 路径（损坏 / 权限 / 特殊 worktree）。**不跟踪重命名**（git2 无 `--follow` 等价物），面板 tooltip 注明；`GitCommitEntry` snake_case serde 不变 → 前端映射层零改动。Windows 链接：`build.rs` 显式 `cargo:rustc-link-lib=advapi32/crypt32`（rust-lld 默认不链）；`git2` 用 `default-features=false` 关 https/ssh 免 OpenSSL。Git 历史作为版本历史面板数据源，不做独立面板（ADR-20260823-001）。
- **`git_available()` 只缓存「可用」**：开面板要跑 `git_repo_root` + `git_file_history` + 20 次 `git_show_file`，每个 command 都探一次 `where git` ≈ 45 次进程创建。不缓存「未安装」—— 保持重试让用户装 git 后免重启生效。
- **`CREATE_NO_WINDOW` 只禁控制台不影响管道**：release 是 windows subsystem，父进程无控制台；spawn CUI 程序会被系统分配新控制台窗口。GUI 子系统程序（`ie4uinit.exe` / `explorer.exe` / NSIS 包）不需要 flag。判断方法：读 PE 可选头 `Subsystem` 字段（`e_lfanew + 4 + 20 + 68`），`2`=GUI / `3`=CUI。**dev 下父进程有控制台、子进程继承，问题不重现**，别拿 dev 行为当验收结论。
- **GPU 偏好只能在 WebView 创建时注入**：`additional_browser_args` 创建后不可改，故偏好为关时返回 `--disable-features=... --disable-gpu`（必须保留 wry 默认 disable-features —— 用户自定义 args 会完全替换默认值），为开时返回 `None`；切换后需重启生效，前端 toast 提示。仅 Windows 暴露开关，macOS / Linux wry 未暴露等效 API。
- **应用自动更新**：`tauri-plugin-updater` + `tauri-plugin-process`（relaunch）。Ed25519 自签名密钥（私钥存 CI Secret，公钥写 `tauri.conf.json` 的 `plugins.updater.pubkey`），endpoint 指向 GitHub Release 的 `latest.json`。CI 两层：Tauri CLI 检测签名私钥后产 `.exe.sig` / `.tar.gz.sig`（`createUpdaterArtifacts: true`），tauri-action `includeUpdaterJson: true` 收集生成 `latest.json`（input 名是 `includeUpdaterJson` 不是 `updaterJson`，后者静默忽略），`updaterJsonPreferNsis: true` 走 NSIS 格式。前端 `useUpdater`：启动 10s 后自动检查一次，有更新后台静默下载 → Toast 提示去设置页手动安装；受 `systemStore.autoUpdateEnabled` 控制；release notes 取 `docs/RELEASE_NOTES.md` 目标版本段落，失败降级 `release.body`；dev 走 Vite proxy `/github-raw` 避 CSP。
- **macOS Finder 服务已移除**：曾用 NSServices + `Info-Additions.plist` + `finder_service.rs`（objc crate），因 macOS 26 Tahoe ObjC 异常穿越 `extern "C"` 边界触发 `panic_cannot_unwind` → `abort()`（tao#1171 / tauri#15517），无 Mac 设备无法调试，已移除全部相关代码。`lib.rs` macOS 走 `#[cfg(not(any(windows, linux)))]` catch-all，`shell_integration_state` 返回 `false/false`，`set_shell_integration` no-op，前端 `SystemGroup.vue` 隐藏开关。**重新实现的坑**：不要用 `objc_exception::r#try`（内部 `catch_unwind` 穿越 `extern "C"` 帧本身触发 `panic_cannot_unwind`，catch 反成崩溃源）；objc 0.2.7 的 `exception` 模块是私有的，须直接依赖 `objc_exception` 0.1.x；`NSApplication` 方法名是 `setServicesProvider:`（复数）；`class!` / `msg_send!` / `sel!` 宏触发 `unexpected_cfgs`，需 `#![allow(unexpected_cfgs)]`。
- **PDF 走隐藏打印窗口**：机制与平台实现见 [export.md](./export.md)「PDF 路径」。

## 附录

- **F12 / perf 打点 prod 开关**：`Cargo.toml` 开 `devtools` feature，release 也能开 DevTools；`App.vue` 注册 F12 → `invoke('open_devtools')`（dev 下 Vite 自带 F12，invoke 失败 catch 掉）。`src/utils/perf.ts` 首屏打点（Performance mark/measure + FCP/LCP），dev 自动启用，production 用 `localStorage.setItem('velo.perf','1')` + 刷新临时开启。PerformanceObserver 必须页面早期注册，flag 模块加载时读一次，设了必须刷新才生效。埋点：`main.ts` `script-start`、`App.vue` `settings-ready` / `code-block-ready` / `mounted` / `editor-mounted`。
- **release-please `extra-files`**：Cargo.toml 必须用 `{"type":"toml","path":"...","jsonpath":"$.package.version"}`，纯字符串会因 `jsonpath` 为空静默不修改。`Cargo.lock` 不要进 extra-files：velo 自己的 `[[package]]` 在数组深层，`GenericToml` 底层 `node-jsonpath` 不支持 `?(...)` filter，配了也静默返回 0 结果。
- **Tauri 2 plugin-opener 只 desktop**：`revealItemInDir` 移动端 unsupported，future 加 mobile entry 时需在 capability / 调用点降级。

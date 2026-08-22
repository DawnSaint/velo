use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdown", "mdwn", "mdtxt", "mdtext"];
const MAIN_WINDOW_LABEL: &str = "main";
const APP_WINDOW_LABEL_PREFIX: &str = "velo-window-";
static APP_WINDOW_ID: AtomicU64 = AtomicU64::new(0);

/// 启动 argv 解析后的待处理路径。多窗口后按 window label 暂存;前端 onMounted
/// 用当前 label 主动领取并清空,避免 app-wide event 被所有窗口同时消费。
///
/// v0.5.1 起 argv 同时支持文件(.md)和目录("在 Velo 中打开"右键菜单):
///   - `files`: 路由到 `documentStore.openPath`(单文件编辑)
///   - `dirs` : 路由到 `workspaceStore.setActiveRoot`(工作区)
#[derive(Default, Clone, serde::Serialize, serde::Deserialize)]
struct CliArgsPayload {
    files: Vec<String>,
    dirs: Vec<String>,
}

impl CliArgsPayload {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.dirs.is_empty()
    }
}

struct PendingWindowCliArgs(Mutex<HashMap<String, CliArgsPayload>>);

fn next_app_window_label() -> String {
    format!(
        "{}{}",
        APP_WINDOW_LABEL_PREFIX,
        APP_WINDOW_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn store_window_payload(app: &AppHandle, label: &str, payload: CliArgsPayload) {
    if payload.is_empty() {
        return;
    }
    let state = app.state::<PendingWindowCliArgs>();
    {
        if let Ok(mut guard) = state.0.lock() {
            guard.insert(label.to_string(), payload);
        };
    }
}

/// 创建一个 app 窗口。`label` 为 None 时使用自增 label（动态窗口），
/// Some(label) 时使用指定 label（主窗口 = "main"）。
fn create_window(
    app: &AppHandle,
    label: &str,
    payload: CliArgsPayload,
) -> Result<String, String> {
    store_window_payload(app, label, payload);

    let mut builder = WebviewWindowBuilder::new(
        app,
        label.to_string(),
        WebviewUrl::App("index.html".into()),
    )
    .title("Velo")
    .inner_size(1200.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .center()
    .resizable(true)
    .fullscreen(false)
    .disable_drag_drop_handler();

    // GPU 硬件加速：用户可在设置中关闭（仅 Windows WebView2 有效）。
    // additional_browser_args 会完全替换 wry 的默认参数，所以禁用 GPU 时
    // 必须保留默认的 --disable-features 再追加 --disable-gpu。
    #[cfg(target_os = "windows")]
    if let Some(args) = gpu_accel::additional_browser_args_if_disabled() {
        builder = builder.additional_browser_args(&args);
    }

    // macOS: 原生装饰 + overlay 标题栏,交通灯浮在自定义 header 左上角。
    // 标题设为空:overlay 标题栏会居中显示 title 文本,与自定义 header 的
    // 菜单按钮 / tab 重叠;空字符串隐藏文本(交通灯仍显示)。
    // Windows/Linux: 无原生装饰,前端自绘 WindowControls。
    #[cfg(target_os = "macos")]
    {
        builder = builder.title("").decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    let build_result = builder.build();

    match build_result {
        Ok(win) => {
            let _ = win.set_focus();
            Ok(label.to_string())
        }
        Err(e) => {
            let state = app.state::<PendingWindowCliArgs>();
            if let Ok(mut guard) = state.0.lock() {
                guard.remove(label);
            }
            Err(format!("create app window: {e}"))
        }
    }
}

/// 创建动态 app 窗口（二次启动 / 顶栏新窗口入口）。
fn create_app_window(app: &AppHandle, payload: CliArgsPayload) -> Result<String, String> {
    let label = next_app_window_label();
    create_window(app, &label, payload)
}

/// 解析 argv:.md 文件归 files,目录归 dirs,其它丢弃。
///
/// 文件 + 目录混杂时各归各路;前端拿到后会先 setActiveRoot(dirs[0])
/// 再 openPath(files[0]),目录与文件互不冲突(目录决定工作区根、文件决定
/// 当前文档)。
fn parse_cli_args(args: &[String]) -> CliArgsPayload {
    let mut out = CliArgsPayload::default();
    for a in args {
        // E2E via WebDriver:msedgedriver 把 capabilities.args 每条都当 Chrome flag,
        // 强制加 `--` 前缀。`PathBuf::from("--C:\\path")` 既不是 file 也不是 dir
        // → 整条 argv 静默丢弃。这里宽容地剥一层 `--`,真实 CLI 不受影响
        // (用户传 `--help` 也是 is_file=false / is_dir=false,本来就会被过滤)。
        let raw: &str = a.strip_prefix("--").unwrap_or(a);
        let p = PathBuf::from(raw);
        if p.is_file() {
            let is_md = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| MD_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            if is_md {
                out.files.push(raw.to_string());
            }
        }
        else if p.is_dir() {
            out.dirs.push(raw.to_string());
        }
    }
    out
}

/// 前端在 onMounted 按当前窗口 label 拉一次:拿到该窗口启动 payload 并清空缓冲。
#[tauri::command]
fn take_window_cli_args(label: String, state: tauri::State<PendingWindowCliArgs>) -> CliArgsPayload {
    state
        .0
        .lock()
        .map(|mut g| g.remove(&label).unwrap_or_default())
        .unwrap_or_default()
}

#[tauri::command]
async fn new_app_window(
    app: AppHandle,
    payload: Option<CliArgsPayload>,
) -> Result<String, String> {
    create_app_window(&app, payload.unwrap_or_default())
}

/// 打开 WebView2 devtools。生产构建需要在 tauri 依赖开 `devtools` 才生效。
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// PDF 导出 (v0.4.7 后) —— 把 HTML 字符串通过平台原生 PrintToPDF API 写到磁盘。
///
/// 当前支持 Windows (WebView2 ICoreWebView2_7::PrintToPdf);macOS / Linux 在
/// `pdf::export_pdf` 里返回 `PdfError::Unsupported`。
#[tauri::command]
async fn export_pdf(
    window: tauri::WebviewWindow,
    output_path: String,
    html: String,
) -> Result<(), pdf::PdfError> {
    pdf::export_pdf(window, output_path, html).await
}

/// 仅在桌面端引入 pdf 模块(避免 mobile entry 编译失败)。
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
mod pdf;

/// Git 历史集成(#local-timeline-git):调用系统 git 获取文件 commit 历史,
/// 供版本历史面板展示。非 Git 仓库 / git 未安装时静默降级。
mod git;

/// 前端设置面板:读取 GPU 硬件加速启用状态。仅 Windows 有意义。
#[cfg(target_os = "windows")]
#[tauri::command]
fn gpu_accel_state() -> bool {
    gpu_accel::gpu_accel_enabled()
}

/// 前端设置面板:切换 GPU 硬件加速。写入注册表偏好,需重启应用生效
///（additional_browser_args 在 WebView 创建时固定）。
#[cfg(target_os = "windows")]
#[tauri::command]
fn set_gpu_accel(enabled: bool) {
    gpu_accel::set_gpu_accel(enabled);
}

/// 打开 Windows 设置 > 默认应用页面,供前端设置面板按钮调用。
#[cfg(target_os = "windows")]
#[tauri::command]
fn open_default_apps_settings() {
    file_assoc::open_settings();
}

/// 前端设置面板:读取文件夹 / .md 右键菜单的当前启用状态。
/// 两个 bool 分别对应 FolderMenu / MdMenu 偏好("1" = 启用,"0" = 禁用,
/// 未设置 → true 向后兼容)。
/// 跨平台:Windows 读注册表偏好;Linux 读 ~/.config 偏好文件。
#[tauri::command]
fn shell_integration_state() -> ShellIntegrationState {
    #[cfg(target_os = "windows")]
    {
        return ShellIntegrationState {
            folder_menu: folder_menu::folder_menu_enabled(),
            md_menu: folder_menu::md_menu_enabled(),
        };
    }
    #[cfg(target_os = "linux")]
    {
        return ShellIntegrationState {
            folder_menu: linux_menu::folder_menu_enabled(),
            md_menu: false, // Linux 暂不注册 md 文件菜单
        };
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        ShellIntegrationState {
            folder_menu: false,
            md_menu: false,
        }
    }
}

/// 前端设置面板:运行时切换文件夹或 .md 右键菜单。
/// `kind` = "folder" | "md";`enabled` = 启用/禁用。
/// Linux 只认 "folder" kind。
#[tauri::command]
fn set_shell_integration(kind: String, enabled: bool) {
    #[cfg(target_os = "windows")]
    {
        match kind.as_str() {
            "folder" => folder_menu::set_folder_menu(enabled),
            "md" => folder_menu::set_md_menu(enabled),
            other => log::warn!("[shell_integration] 未知的菜单种类: {other}"),
        }
    }
    #[cfg(target_os = "linux")]
    {
        match kind.as_str() {
            "folder" => linux_menu::set_folder_menu(enabled),
            "md" => log::warn!("[shell_integration] Linux 暂不支持 md 文件菜单"),
            other => log::warn!("[shell_integration] 未知的菜单种类: {other}"),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (kind, enabled);
    }
}

#[derive(serde::Serialize)]
struct ShellIntegrationState {
    folder_menu: bool,
    md_menu: bool,
}

/// Windows 文件夹右键菜单注册(v0.5.1)。
#[cfg(target_os = "windows")]
mod folder_menu;

/// Windows 默认程序:打开系统设置页面引导用户完成 .md 关联。
#[cfg(target_os = "windows")]
mod file_assoc;

/// Windows GPU 硬件加速偏好读写（WebView2 additional_browser_args）。
#[cfg(target_os = "windows")]
mod gpu_accel;

/// Linux 文件夹右键菜单:按桌面环境检测 + 写 action 文件(v0.7.x)。
#[cfg(target_os = "linux")]
mod linux_menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingWindowCliArgs(Mutex::new(HashMap::new())))
        // single-instance 必须第一个注册:拦截后续启动并在现有进程中创建新窗口
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let payload = parse_cli_args(&args);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = create_app_window(&app, payload) {
                    log::error!("二次启动创建新窗口失败: {e}");
                    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                }
            });
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            take_window_cli_args,
            new_app_window,
            open_devtools,
            export_pdf,
            #[cfg(target_os = "windows")]
            open_default_apps_settings,
            shell_integration_state,
            set_shell_integration,
            #[cfg(target_os = "windows")]
            gpu_accel_state,
            #[cfg(target_os = "windows")]
            set_gpu_accel,
            git::git_repo_root,
            git::git_file_history,
            git::git_show_file,
        ])
        .setup(|app| {
            // 首次启动:argv 解析后按 main label 暂存,等前端 onMounted 主动来拉
            let args: Vec<String> = std::env::args().skip(1).collect();
            let payload = parse_cli_args(&args);

            // 主窗口由代码创建（非 tauri.conf.json 配置驱动），以便在创建时
            // 注入 additional_browser_args（GPU 加速偏好）。tauri.conf.json 的
            // windows 配置已清空，避免配置驱动的窗口与代码创建的窗口冲突。
            // 创建后立即 show（配置中 visible:false 的等效由代码完成）。
            let label = MAIN_WINDOW_LABEL.to_string();
            match create_window(app.handle(), &label, payload) {
                Ok(_) => {
                    if let Some(win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                        let _ = win.show();
                    }
                }
                Err(e) => {
                    log::error!("创建主窗口失败: {e}");
                    return Err(e.into());
                }
            }

            // 注册/刷新"在 Velo 中打开"文件夹右键菜单。
            // 安装器会写入偏好标志;ensure_registered 读取标志决定
            // 是否注册:"1"→刷新,"0"→跳过(用户安装时选了不注册),未设置→照常
            // 注册(便携模式/旧版升级)。best-effort,不阻塞应用启动。
            // 跨平台:Windows→注册表;Linux→action 文件。
            // macOS Finder 服务已移除,待购入 Mac 设备后重新实现。
            #[cfg(target_os = "windows")]
            folder_menu::ensure_registered();
            #[cfg(target_os = "linux")]
            linux_menu::ensure_registered();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

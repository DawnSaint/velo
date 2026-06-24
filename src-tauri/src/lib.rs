use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, Theme};

const MD_EXTS: &[&str] = &["md", "markdown", "mdown"];

/// 冷启动 argv 解析后的待处理路径。`setup()` 期前端 `listen('cli-args')` 还
/// 没挂上,这里暂存;前端 onMounted 主动 `get_cli_args` 拉取并清空。
///
/// v0.5.1 起 argv 同时支持文件(.md)和目录("在 Velo 中打开"右键菜单):
///   - `files`: 路由到 `documentStore.openPath`(单文件编辑)
///   - `dirs` : 路由到 `workspaceStore.setActiveRoot`(工作区)
/// 二次启动(single-instance plugin)走同一 `parse_cli_args`,负载形态一致。
#[derive(Default, Clone, serde::Serialize)]
struct CliArgsPayload {
    files: Vec<String>,
    dirs: Vec<String>,
}

impl CliArgsPayload {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.dirs.is_empty()
    }
}

struct PendingCliArgs(Mutex<CliArgsPayload>);

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

/// 前端在 onMounted 拉一次:拿到冷启动 argv 解析结果并清空缓冲。
#[tauri::command]
fn get_cli_args(state: tauri::State<PendingCliArgs>) -> CliArgsPayload {
    state
        .0
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default()
}

/// 同步 webview 暗色模式到原生窗口的 title bar
/// theme: "dark" | "light"（其他值表示跟随系统设置）
#[tauri::command]
fn set_window_theme(theme: String, window: tauri::WebviewWindow) {
    let t = match theme.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None, // 跟随系统
    };
    let _ = window.set_theme(t);
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

/// Windows 文件夹右键菜单注册(v0.5.1)。
#[cfg(target_os = "windows")]
mod folder_menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingCliArgs(Mutex::new(CliArgsPayload::default())))
        // single-instance 必须第一个注册:拦截后续启动并把 argv 转发给现有实例
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let payload = parse_cli_args(&args);
            if !payload.is_empty() {
                // 二次启动 = 现有实例的前端早就挂载好了,直接 emit 即可
                let _ = app.emit("cli-args", payload);
            }
            // 拉回主窗口前台
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            set_window_theme,
            get_cli_args,
            open_devtools,
            export_pdf,
        ])
        .setup(|app| {
            // 首次启动:argv 解析后暂存到 state,等前端 onMounted 主动来拉
            let args: Vec<String> = std::env::args().skip(1).collect();
            let payload = parse_cli_args(&args);
            if !payload.is_empty() {
                let state = app.state::<PendingCliArgs>();
                let lock = state.0.lock();
                if let Ok(mut guard) = lock {
                    *guard = payload;
                }
            }

            // 注册"在 Velo 中打开"文件夹右键菜单(v0.5.1)。
            // best-effort:失败仅 warn,不阻塞应用启动。每次启动都重写,
            // 自动跟随 exe 路径变化(用户把 Velo 拖到别处的场景)。
            #[cfg(target_os = "windows")]
            folder_menu::ensure_registered();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

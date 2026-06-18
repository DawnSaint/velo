use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, Theme};

const MD_EXTS: &[&str] = &["md", "markdown", "mdown"];

/// Cold-launch buffer for any markdown paths the OS handed us on argv.
/// `setup()` runs BEFORE the webview has a chance to register
/// `listen('cli-args', ...)`, so `app.emit("cli-args", ...)` at that point
/// is fire-and-forget into the void. We stash them here instead and let
/// the frontend drain via `get_cli_args` on mount.
struct PendingCliArgs(Mutex<Vec<String>>);

/// Pick out the markdown file paths the user actually asked us to open.
fn filter_md_paths(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|a| {
            PathBuf::from(a)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| MD_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        .filter(|a| PathBuf::from(a).is_file())
        .cloned()
        .collect()
}

/// 前端在 onMounted 拉一次：拿到冷启动 argv 里的文件路径并清空缓冲。
#[tauri::command]
fn get_cli_args(state: tauri::State<PendingCliArgs>) -> Vec<String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingCliArgs(Mutex::new(Vec::new())))
        // single-instance 必须第一个注册：拦截后续启动并把 argv 转发给现有实例
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = filter_md_paths(&args);
            if !paths.is_empty() {
                // 二次启动 = 现有实例的前端早就挂载好了，直接 emit 即可
                let _ = app.emit("cli-args", paths);
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
        .invoke_handler(tauri::generate_handler![set_window_theme, get_cli_args, open_devtools])
        .setup(|app| {
            // 首次启动：把 argv 里的文件路径暂存进 state，等前端 onMounted 主动来拉
            let args: Vec<String> = std::env::args().skip(1).collect();
            let paths = filter_md_paths(&args);
            if !paths.is_empty() {
                let state = app.state::<PendingCliArgs>();
                let lock = state.0.lock();
                if let Ok(mut guard) = lock {
                    *guard = paths;
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

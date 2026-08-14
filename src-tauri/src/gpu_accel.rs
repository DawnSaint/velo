//! GPU 硬件加速偏好读写（Windows）。
//!
//! WebView2 默认启用 GPU 硬件加速。用户可通过设置面板关闭（类似 Chrome
//! 的"使用图形加速功能"开关）。偏好存 HKCU 注册表，与 ShellIntegration
//! 偏好同路径，Rust 端在创建 WebView 前直接读取——`additional_browser_args`
//! 必须在 WebView 创建时传入，不能在运行时动态切换。
//!
//! **仅 Windows 有意义**：macOS WKWebView 和 Linux WebKitGTK 的 GPU 加速
//! 由系统控制，Tauri/wry 未暴露 `additional_browser_args` 等效 API。

// 无论 debug/release 都需要读偏好（setup 中决定是否传 --disable-gpu），
// write_pref 也在前端设置面板调用。没有 dead_code 风险。

use winreg::enums::*;
use winreg::RegKey;

const PREF_KEY_PATH: &str = r"Software\com.velo.editor\ShellIntegration";
const PREF_GPU_ACCEL: &str = "GpuAcceleration";

/// 读取 GPU 加速偏好。未设置 → true（默认开启，向后兼容）。
pub fn gpu_accel_enabled() -> bool {
    read_pref(PREF_GPU_ACCEL)
        .map(|v| v != "0")
        .unwrap_or(true)
}

/// 写入 GPU 加速偏好。前端设置面板调用。
pub fn set_gpu_accel(enabled: bool) {
    write_pref(PREF_GPU_ACCEL, enabled);
}

/// 如果用户关闭了 GPU 加速，返回 `--disable-gpu` 参数字符串；否则返回 None。
/// 在 `WebviewWindowBuilder::additional_browser_args` 中传入。
pub fn additional_browser_args_if_disabled() -> Option<String> {
    if gpu_accel_enabled() {
        None
    } else {
        // wry 默认会注入 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection。
        // 用户自定义 additional_browser_args 会完全替换默认值（wry 源码 unwrap_or_else
        // 只在 None 时走默认路径），所以必须保留默认 disable-features 再追加 --disable-gpu。
        Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu".to_string())
    }
}

fn read_pref(name: &str) -> Option<String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let prefs = hkcu.open_subkey(PREF_KEY_PATH).ok()?;
    prefs.get_value::<String, _>(name).ok()
}

fn write_pref(name: &str, enabled: bool) {
    let value = if enabled { "1" } else { "0" };
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok((key, _)) = hkcu.create_subkey(PREF_KEY_PATH) {
        if let Err(e) = key.set_value(name, &value) {
            log::warn!("[gpu_accel] 写偏好 {name}={value} 失败: {e}");
        }
    }
}

//! Windows 默认程序 —— 打开系统设置页面引导用户完成 .md 文件关联。
//!
//! Windows 10 (1703+) 引入了文件关联反劫持保护机制,程序无法通过注册表
//! 直写设定默认程序。唯一可靠的方式是引导用户到 Windows 设置 > 默认应用
//! 页面手动选择。ProgID `Velo.md` + Capabilities 已由 NSIS 安装器注册,
//! Velo 会出现在设置列表中。
//!
//! 本模块提供 `open_settings()` 供 Tauri command 调用,前端设置面板
//! 可通过按钮主动打开 Windows 设置页面。

use windows::core::w;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// 打开 Windows 设置 > 默认应用页面。供 Tauri command 调用(前端设置面板按钮)。
///
/// 使用 ShellExecuteW 而非 cmd /c start:直接调 Win32 API 更可靠,
/// 避免 cmd 窗口一闪而过 / 引号转义问题。
pub fn open_settings() {
    unsafe {
        let result = ShellExecuteW(
            None,
            w!("open"),
            w!("ms-settings:defaultapps"),
            None,
            None,
            SW_SHOWNORMAL,
        );
        let code = result.0 as isize;
        if code <= 32 {
            log::warn!("[file_assoc] 打开 Windows 设置失败,错误码: {code}");
        }
    }
}

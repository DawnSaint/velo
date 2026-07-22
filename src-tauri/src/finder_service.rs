//! macOS Finder 右键「服务」菜单 ——「在 Velo 中打开」文件夹动词的实现端。
//!
//! 注册由 `Info-Additions.plist` 的 `NSServices` 数组静态声明（通过
//! `bundle.macOS.infoPlist` 合并进 app 的 Info.plist），本模块只负责实现
//! `NSMessage = openInVelo:` 指定的 service handler。
//!
//! ## 数据流
//!
//! 用户右键文件夹 → Finder「服务 → 在 Velo 中打开」→ macOS 在 service provider 上
//! 调用 `openInVelo:userData:error:` → 本 handler 从 `NSPasteboard` 读出 file URLs
//! → 取首个路径 → 重新启动自身并传路径（走 single-instance → `setActiveRoot`，
//! 与 Windows `%1` 完全同构）。
//!
//! 注意：NSServices 自 macOS 10.14 起 deprecated，但仍可用；菜单落在右键「服务」子菜单。

use std::path::PathBuf;
use std::sync::Once;

use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel, objc_getClass};
use objc::{class, msg_send, sel};

const SERVICE_PROVIDER_CLASS: &str = "VeloServiceProvider";

// ---------------------------------------------------------------------------
// 偏好存取
// macOS/Linux 共用一个简易 pref 文件：$HOME/.config/com.velo.editor/folder-menu，
// 内容 "1"(启用) / "0"(禁用)。未设置 → true（向后兼容）。
// ---------------------------------------------------------------------------

fn pref_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".config/com.velo.editor/folder-menu"))
}

/// 读取「文件夹右键菜单」偏好（true = 启用）。未设置 → true。
pub fn folder_menu_enabled() -> bool {
    match pref_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(contents) => contents.trim() != "0",
        None => true,
    }
}

fn write_pref(enabled: bool) {
    let value = if enabled { "1" } else { "0" };
    if let Some(path) = pref_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&path, value) {
            log::warn!("[shell_integration] 写 macOS 文件夹菜单偏好失败: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// 重新启动自身传目录路径
// ---------------------------------------------------------------------------

/// 用 directory 路径重启自身，走 single-instance → setActiveRoot。
fn reopen_with_dir(dir: &str) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[shell_integration] 取 exe 路径失败: {e}");
            return;
        }
    };
    if let Err(e) = std::process::Command::new(&exe).arg(dir).spawn() {
        log::warn!("[shell_integration] 启动自身打开目录失败({dir}): {e}");
    }
}

// ---------------------------------------------------------------------------
// NSServices handler
// ---------------------------------------------------------------------------

extern "C" fn open_in_velo(
    _this: &Object,
    _cmd: Sel,
    pboard: *mut Object,
    _user_data: *mut Object,
    _error: *mut *mut Object,
) {
    if pboard.is_null() {
        log::warn!("[shell_integration] openInVelo: pasteboard 为空");
        return;
    }
    unsafe {
        // 从 pasteboard 读 file URLs：readClasses:[NSURL] options:nil
        let nsurl_class: *mut Object = class!(NSURL);
        let classes: *mut Object = msg_send![class!(NSArray), arrayWithObject: nsurl_class];
        let urls: *mut Object =
            msg_send![pboard, readObjectsForClasses: classes options: std::ptr::null_mut::<Object>()];
        if urls.is_null() {
            log::warn!("[shell_integration] openInVelo: 读 pasteboard URLs 失败");
            return;
        }
        let count: usize = msg_send![urls, count];
        if count == 0 {
            log::warn!("[shell_integration] openInVelo: pasteboard 无 URL");
            return;
        }
        let first_url: *mut Object = msg_send![urls, objectAtIndex: 0];
        // NSURL.path → NSString → UTF8 路径
        let nsstring: *mut Object = msg_send![first_url, path];
        if nsstring.is_null() {
            log::warn!("[shell_integration] openInVelo: URL path 为空");
            return;
        }
        let cstr: *const i8 = msg_send![nsstring, UTF8String];
        if cstr.is_null() {
            log::warn!("[shell_integration] openInVelo: UTF8String 为空");
            return;
        }
        let path = std::ffi::CStr::from_ptr(cstr).to_string_lossy().into_owned();
        reopen_with_dir(&path);
    }
}

/// 注册 service provider，让 Finder 知道 openInVelo: 的实现。
/// 幂等，多次调用安全。best-effort：失败仅 warn 不抛。
fn install_service_provider() {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| unsafe {
        let superclass = class!(NSObject);
        let mut decl = match ClassDecl::new(SERVICE_PROVIDER_CLASS, superclass) {
            Some(d) => d,
            None => {
                log::warn!("[shell_integration] 注册 {SERVICE_PROVIDER_CLASS} 类失败");
                return;
            }
        };
        decl.add_method(
            sel!(openInVelo:userData:error:),
            open_in_velo as extern "C" fn(&Object, Sel, *mut Object, *mut Object, *mut *mut Object),
        );
        decl.register();
    });

    unsafe {
        // 在运行时查找已注册的类（objc_getClass 返回 *const Class）。
        let cls: *const Class =
            objc_getClass(SERVICE_PROVIDER_CLASS.as_ptr() as *const i8) as *const Class;
        if cls.is_null() {
            log::warn!("[shell_integration] {SERVICE_PROVIDER_CLASS} 类不存在");
            return;
        }
        let provider: *mut Object = msg_send![cls, new];
        if provider.is_null() {
            log::warn!("[shell_integration] 创建 service provider 实例失败");
            return;
        }
        let app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, setServiceProvider: provider];
    }
}

// ---------------------------------------------------------------------------
// 公共 API（lib.rs 调用）
// ---------------------------------------------------------------------------

/// setup() 调用：读偏好，按需注册 service provider。best-effort。
pub fn register() {
    if !folder_menu_enabled() {
        log::info!("[shell_integration] 文件夹右键菜单偏好为 0，跳过注册");
        return;
    }
    install_service_provider();
}

/// 运行时切换文件夹右键菜单。写入偏好 + 重新注册/标记。
pub fn set_folder_menu(enabled: bool) {
    write_pref(enabled);
    if enabled {
        install_service_provider();
    }
    // NSServices 无法运行时注销菜单项（plist 静态注册），禁用仅停止刷新；
    // 菜单项仍可能出现但点击后无动作。与 Windows 注册表即时注销语义不同，
    // 但符合 NSServices 能力边界。
}

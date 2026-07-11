//! Windows 注册表:文件夹右键菜单"在 Velo 中打开"(v0.5.1)
//!
//! 安装器(NSIS)在安装时询问用户是否注册右键菜单,并将偏好写入
//! `HKCU\Software\com.velo.editor\ShellIntegration\FolderMenu`("1" = 注册,
//! "0" = 不注册)。运行时 `ensure_registered` 读取该标志:
//! - "1": 刷新注册表(重写 exe 路径,跟随用户移动 exe 的场景)
//! - "0": 跳过(用户安装时选择了不注册)
//! - 未设置(便携模式 / 旧版升级): 照常注册,保持向后兼容
//!
//! `installMode` 为 `currentUser`(per-user only),安装器 shell 集成项
//! 写 `HKCU`(SHCTX=HKCU),偏好标志也写 HKCU。运行时刷新始终写 HKCU。
//! 卸载时由 NSIS 卸载器自动删除 HKCU 的全部注册表项,运行时无需做注销。
//!
//! 注册路径(运行时刷新写 HKCU,安装器写 HKCU):
//!   HKCU\Software\Classes\Directory\shell\OpenInVelo
//!     (Default) = "在 Velo 中打开"
//!     Icon      = "<exe>,0"
//!   HKCU\Software\Classes\Directory\shell\OpenInVelo\command
//!     (Default) = "<exe>" "%1"
//!
//! - 选 `Directory\shell\<verb>` 而非 `Directory\Background\shell`:前者是"右键
//!   一个文件夹",后者是"在文件夹空白处右键";前者覆盖主要用例,后者实现差异
//!   仅在于 %1 → %V,后续需要再加一个并行子树即可。
//! - `%1` 而非 `%V`:`%V` 在 `Background\shell` 才适用(`Directory\shell` 下
//!   `%1` = 选中的文件夹路径)。加引号 `"%1"` 处理带空格路径。
//! - 写在 HKCU\Software\Classes 而非 HKLM\Software\Classes:HKCU 不需要 UAC
//!   提升,普通用户启动即可写入;Windows 合并 HKCU + HKLM 的 Classes 解析。

use winreg::enums::*;
use winreg::RegKey;

const MENU_KEY_PATH: &str = r"Software\Classes\Directory\shell\OpenInVelo";
const COMMAND_KEY_PATH: &str = r"Software\Classes\Directory\shell\OpenInVelo\command";
const MENU_LABEL: &str = "在 Velo 中打开";

const PREF_KEY_PATH: &str = r"Software\com.velo.editor\ShellIntegration";
const PREF_FOLDER_MENU: &str = "FolderMenu";

/// 注册文件夹右键菜单。best-effort:失败仅 warn,不抛错给调用方。
///
/// 读取安装偏好标志决定是否注册:
/// - "1": 用户安装时选择了注册 → 刷新(重写 exe 路径)
/// - "0": 用户安装时选择了不注册 → 跳过
/// - 未设置: 便携模式或旧版升级 → 照常注册(向后兼容)
pub fn ensure_registered() {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // 检查安装偏好标志
    if let Ok(prefs) = hkcu.open_subkey(PREF_KEY_PATH) {
        if let Ok(val) = prefs.get_value::<String, _>(PREF_FOLDER_MENU) {
            if val == "0" {
                log::info!("[folder_menu] 用户安装时未选择注册右键菜单,跳过");
                return;
            }
        }
    }

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[folder_menu] 取 exe 路径失败,跳过注册: {}", e);
            return;
        }
    };
    let exe_str = exe.to_string_lossy().to_string();

    if let Err(e) = write_keys(&exe_str) {
        log::warn!("[folder_menu] 写注册表失败,菜单不可用: {}", e);
    }
}

fn write_keys(exe: &str) -> std::io::Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let (menu_key, _) = hkcu.create_subkey(MENU_KEY_PATH)?;
    menu_key.set_value("", &MENU_LABEL)?;
    menu_key.set_value("Icon", &format!("{},0", exe))?;

    let (cmd_key, _) = hkcu.create_subkey(COMMAND_KEY_PATH)?;
    // "%1" 必须带引号,文件夹路径含空格时未引号 = 拆词
    cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe))?;
    Ok(())
}

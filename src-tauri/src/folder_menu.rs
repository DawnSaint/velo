//! Windows 注册表:文件夹右键菜单"在 Velo 中打开"(v0.5.1)
//!
//! 写入 HKCU(Current User)分支无需管理员权限,启动期 best-effort 跑一次,
//! 失败仅 warn,不阻塞应用。每次启动都重写,自动跟随 exe 路径变化(用户
//! 把 Velo 拖到别处的场景)。注册表写 HKCU 是同步快速 op,每次重写无可
//! 感知开销。
//!
//! 注册路径:
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

/// 注册文件夹右键菜单。best-effort:失败仅 warn,不抛错给调用方。
pub fn ensure_registered() {
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

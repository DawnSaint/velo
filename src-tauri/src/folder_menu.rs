//! Windows 注册表:文件夹 / .md 文件右键菜单"在 Velo 中打开" + 偏好读写 + SHChangeNotify。
//!
//! installMode=currentUser(SHCTX=HKCU),偏好键与菜单树都写 HKCU,免 UAC。
//!
//! ## 双源状态模型
//!
//! 安装器把 FolderMenu / MdMenu 两个偏好("1"/"0")写入
//! `HKCU\Software\com.velo.editor\ShellIntegration`;
//! NSIS POSTINSTALL 同时把对应的注册表菜单树写入 HKCU。
//! 偏好键是"是否启用"的真理来源,菜单树是它的运行时体现。
//!
//! 启动时 `ensure_registered()` 读取偏好,按需刷新文件夹菜单的 exe 路径
//! (用户移动 exe 的场景);`md_menu` 不需要运行时刷新,因为安装器写后 exe
//! 路径不变。前端设置面板通过 `set_folder_menu` / `set_md_menu`
//! 在运行时切换,写入偏好 + 立即注册/注销菜单树。
//!
//! **debug 构建跳过注册表写入**:debug exe 路径(`target/debug/velo.exe`)是
//! 临时路径,写入注册表会让右键菜单启动 debug 版本 → 尝试连接 Vite dev
//! server(5273)并弹出终端窗口(console subsystem)。右键菜单注册由安装器
//! + release 版本负责,debug 构建只读写偏好标志,不触碰注册表菜单树。
//! 因此注册表操作函数在 debug 构建下无调用者,模块级 allow(dead_code)。

// debug 构建跳过注册表菜单树操作(ensure_registered / set_*_menu 内的
// #[cfg(not(debug_assertions))] 块),导致 register_* / unregister_* /
// notify_shell_changed / 相关常量无调用者。release 构建正常检查 dead_code。
#![cfg_attr(debug_assertions, allow(dead_code))]

use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_FLUSH};
use winreg::enums::*;
use winreg::RegKey;

// 清理时两侧都清:HKCU(当前用户,始终可写) + HKLM(旧 per-machine 残留)。
// HKLM 在非管理员进程打开会 ACCESS_DENIED → 静默跳过,仅日志。
fn delete_verb_both_hives(parent_path: &str, leaf: &str) {
  for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
    let root = RegKey::predef(hive);
    match root.create_subkey(parent_path) {
      Ok((parent, _)) => {
        if let Err(e) = parent.delete_subkey_all(leaf) {
          // NotFound = 这侧本来就没注册,正常;ACL 拒绝 = 普通用户清 HKLM,也正常。
          let kind = e.kind();
          if kind != std::io::ErrorKind::NotFound {
            log::warn!("[shell_integration] 删除 {parent_path}\\{leaf} 失败({hive:?}): {e}");
          }
        }
      }
      Err(_) => {
        // HKLM 在非管理员下打不开 → 跳过
        if hive == HKEY_LOCAL_MACHINE {
          continue
        }
      }
    }
  }
}

// ---- 文件夹右键菜单 ----
const MENU_KEY_PATH: &str = r"Software\Classes\Directory\shell\OpenInVelo";
const COMMAND_KEY_PATH: &str = r"Software\Classes\Directory\shell\OpenInVelo\command";
const MENU_LABEL: &str = "在 Velo 中打开";

// ---- md 文件右键菜单(SystemFileAssociations) ----
// GitHub Linguist + Typora + VS Code 公认的 Markdown 扩展名全集,顺序无关。
const MD_EXTS: &[&str] = &[".md", ".markdown", ".mdown", ".mkd", ".mkdown", ".mdwn", ".mdtxt", ".mdtext"];
const MD_MENU_STEM: &str = r"Software\Classes\SystemFileAssociations";

// ---- 偏好键 ----
const PREF_KEY_PATH: &str = r"Software\com.velo.editor\ShellIntegration";
const PREF_FOLDER_MENU: &str = "FolderMenu";
const PREF_MD_MENU: &str = "MdMenu";

/// 启动时调用:读 FolderMenu 偏好,按需刷新文件夹菜单的 exe 路径。
/// best-effort:失败仅 warn,不抛错给调用方。
pub fn ensure_registered() {
  #[cfg(debug_assertions)]
  {
    log::info!("[shell_integration] debug 构建,跳过文件夹右键菜单注册表刷新");
    return;
  }

  #[cfg(not(debug_assertions))]
  {
    let enabled = read_pref(PREF_FOLDER_MENU).map(|v| v != "0").unwrap_or(true);
    if !enabled {
      log::info!("[shell_integration] 文件夹右键菜单偏好为 0,跳过注册");
      return;
    }
    let exe = match std::env::current_exe() {
      Ok(p) => p,
      Err(e) => {
        log::warn!("[shell_integration] 取 exe 路径失败,跳过注册: {}", e);
        return;
      }
    };
    if let Err(e) = register_folder_menu(&exe.to_string_lossy()) {
      log::warn!("[shell_integration] 刷新文件夹右键菜单失败: {}", e);
    }
  }
}

// ---------------------------------------------------------------------------
// 运行时开关 —— 前端设置面板调用
// ---------------------------------------------------------------------------

/// 读取 FolderMenu 偏好(true = 启用)。未设置 → true(向后兼容)。
pub fn folder_menu_enabled() -> bool {
  read_pref(PREF_FOLDER_MENU).map(|v| v != "0").unwrap_or(true)
}

/// 读取 MdMenu 偏好(true = 启用)。未设置 → true。
pub fn md_menu_enabled() -> bool {
  read_pref(PREF_MD_MENU).map(|v| v != "0").unwrap_or(true)
}

/// 运行时切换文件夹右键菜单。写入偏好 + 注册/注销菜单树 + SHChangeNotify。
pub fn set_folder_menu(enabled: bool) {
  write_pref(PREF_FOLDER_MENU, enabled);
  // debug 构建不修改注册表菜单树(避免写入 debug exe 路径),只更新偏好标志。
  #[cfg(debug_assertions)]
  {
    log::info!("[shell_integration] debug 构建,仅更新偏好,跳过注册表写入");
    return;
  }

  #[cfg(not(debug_assertions))]
  {
    if enabled {
      let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
          log::warn!("[shell_integration] 取 exe 路径失败: {}", e);
          return;
        }
      };
      if let Err(e) = register_folder_menu(&exe) {
        log::warn!("[shell_integration] 注册文件夹右键菜单失败: {}", e);
      }
    } else {
      unregister_folder_menu();  // 双侧 best-effort,内部已处理错误
    }
    notify_shell_changed();
  }
}

/// 运行时切换 .md 文件右键菜单。写入偏好 + 注册/注销菜单树 + SHChangeNotify。
pub fn set_md_menu(enabled: bool) {
  write_pref(PREF_MD_MENU, enabled);
  // debug 构建不修改注册表菜单树(避免写入 debug exe 路径),只更新偏好标志。
  #[cfg(debug_assertions)]
  {
    log::info!("[shell_integration] debug 构建,仅更新偏好,跳过注册表写入");
    return;
  }

  #[cfg(not(debug_assertions))]
  {
    if enabled {
      let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
          log::warn!("[shell_integration] 取 exe 路径失败: {}", e);
          return;
        }
      };
      if let Err(e) = register_md_menu(&exe) {
        log::warn!("[shell_integration] 注册 .md 右键菜单失败: {}", e);
      }
    } else {
      unregister_md_menu();  // 双侧 best-effort,内部已处理错误
    }
    notify_shell_changed();
  }
}

// ---------------------------------------------------------------------------
// 注册表菜单树 —— 注册 / 注销
// ---------------------------------------------------------------------------

/// 写文件夹右键菜单的 verb + command。
fn register_folder_menu(exe: &str) -> std::io::Result<()> {
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let (menu_key, _) = hkcu.create_subkey(MENU_KEY_PATH)?;
  menu_key.set_value("", &MENU_LABEL)?;
  menu_key.set_value("Icon", &format!("{},0", exe))?;
  let (cmd_key, _) = hkcu.create_subkey(COMMAND_KEY_PATH)?;
  // "%1" 必须带引号,文件夹路径含空格时未引号 = 拆词
  cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe))?;
  Ok(())
}

/// 删文件夹右键菜单(OpenInVelo 整体,含 command 子树)。HKCU + HKLM 双侧清理。
fn unregister_folder_menu() {
  delete_verb_both_hives(r"Software\Classes\Directory\shell", "OpenInVelo");
}

/// 写三处扩展名的 md 右键菜单。
fn register_md_menu(exe: &str) -> std::io::Result<()> {
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  for ext in MD_EXTS {
    let verb_path = format!("{MD_MENU_STEM}\\{ext}\\shell\\OpenInVelo");
    let command_path = format!("{MD_MENU_STEM}\\{ext}\\shell\\OpenInVelo\\command");
    let (menu_key, _) = hkcu.create_subkey(&verb_path)?;
    menu_key.set_value("", &MENU_LABEL)?;
    menu_key.set_value("Icon", &format!("{},0", exe))?;
    let (cmd_key, _) = hkcu.create_subkey(&command_path)?;
    cmd_key.set_value("", &format!("\"{}\" \"%1\"", exe))?;
  }
  Ok(())
}

/// 删全部扩展名的 md 右键菜单(OpenInVelo 整体)。HKCU + HKLM 双侧清理。
fn unregister_md_menu() {
  for ext in MD_EXTS {
    let parent_path = format!("{MD_MENU_STEM}\\{ext}\\shell");
    delete_verb_both_hives(&parent_path, "OpenInVelo");
  }
}

// ---------------------------------------------------------------------------
// 偏好读写 / SHChangeNotify
// ---------------------------------------------------------------------------

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
      log::warn!("[shell_integration] 写偏好 {name}={value} 失败: {e}");
    }
  }
}

fn notify_shell_changed() {
  unsafe {
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH, None, None);
  }
  // SHCNE_ASSOCCHANGED 能刷新 shell 菜单树,但 IconCache.db 里的图标缓存常常
  // 不会立刻失效(残留菜单项会显示"找不到"图标)。显式触发图标缓存重建,
  // 避免用户重启 Explorer.ie4uinit.exe -show 是 Windows 推荐的图标缓存重建入口,
  // 失败无害(仅日志)。
  if let Err(e) = std::process::Command::new("ie4uinit.exe").arg("-show").spawn() {
    log::warn!("[shell_integration] 触发图标缓存重建失败: {e}");
  }
}

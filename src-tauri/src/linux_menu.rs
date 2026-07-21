//! Linux 文件夹右键菜单 ——「在 Velo 中打开」。
//!
//! Linux 没有跨桌面环境（DE）的统一右键菜单注册机制。本模块按 `$XDG_CURRENT_DESKTOP`
//! 检测当前 DE，分别写入对应文件管理器的 action 文件，per-user、免 admin。
//!
//! ## 覆盖矩阵
//!
//! | DE / 文件管理器 | 机制 | 落盘位置 | 菜单深度 |
//! |----------------|------|---------|---------|
//! | KDE (Dolphin) | ServiceMenu | `~/.local/share/kservices5/ServiceMenus/` | 顶级菜单 |
//! | GNOME / Unity / Cinnamon / MATE / 其它 | Nautilus Script | `~/.local/share/nautilus/scripts/` | 「脚本」子菜单 |
//!
//! Thunar (XFCE) 与未知 DE 没有标准文件级注册机制：Thunar 走 GUI 配置；未知 DE
//! 退到 Nautilus 脚本并 log::warn。
//!
//! ## 数据流
//!
//! 启动时 `ensure_registered()` 读偏好 + 检测 DE → 写 action 文件（幂等：内容相同跳过）。
//! 用户在FileManager 右键文件夹点击「在 Velo 中打开」→ 脚本/exec 启动自身传路径
//! → single-instance → setActiveRoot（与 Windows 同构）。

use std::path::PathBuf;

const SCRIPT_LABEL: &str = "在 Velo 中打开";

// ---------------------------------------------------------------------------
// 偏好存取 —— 与 macOS finder_service 共用 pref 文件路径语义。
// ---------------------------------------------------------------------------

fn pref_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".config/com.velo.editor/folder-menu"))
}

/// 读取「文件夹右键菜单」偏好（true = 启用）。未设置 → true（向后兼容）。
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
            log::warn!("[shell_integration] 写 Linux 文件夹菜单偏好失败: {e}");
        }
    }
}

// ---------------------------------------------------------------------------
// 自身路径
// ---------------------------------------------------------------------------

/// 解析当前可执行文件路径。best-effort。
fn current_exe() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

// ---------------------------------------------------------------------------
// Dolphin ServiceMenu（KDE）
// ---------------------------------------------------------------------------

fn dolphin_service_menu_path(exe: &std::path::Path) -> String {
    // 当前官方 KDE 格式(develop.kde.org/docs/apps/dolphin/service-menus/):
    // Type=Service + MimeType= 决定何时出现,Actions= 列出动作。
    // 目录用 inode/directory;%f 传单个选中路径。文件必须 chmod +x 才出现在菜单。
    format!(
        "[Desktop Entry]\n\
         Type=Service\n\
         MimeType=inode/directory;\n\
         Actions=OpenInVelo\n\
         Icon=text-markdown\n\
         \n\
         [Desktop Action OpenInVelo]\n\
         Name={SCRIPT_LABEL}\n\
         Icon=text-markdown\n\
         Exec={exe} %f\n",
        exe = exe.display()
    )
}

fn install_dolphin_service_menu(exe: &std::path::Path) -> bool {
    let home = match std::env::var_os("HOME") {
        Some(h) => h,
        None => return false,
    };
    // 官方路径:~/.local/share/kio/servicemenus/(develop.kde.org 文档)
    let dir = PathBuf::from(home).join(".local/share/kio/servicemenus");
    let file = dir.join("velo-openfolder.desktop");

    let content = dolphin_service_menu_path(exe);
    if !write_action_file(&file, &content) {
        return false;
    }
    // Dolphin ServiceMenu .desktop 必须是可执行文件才出现在右键菜单。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&file) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            if let Err(e) = std::fs::set_permissions(&file, perm) {
                log::warn!("[shell_integration] 设置 ServiceMenu 可执行权限失败({}): {e}", file.display());
            }
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Nautilus Script（GNOME / Unity / Cinnamon / MATE / 兜底）
// --------------------------------------------------------------------------

fn nautilus_script_content(exe: &std::path::Path) -> String {
    format!(
        "#!/usr/bin/env bash\n\
         # Velo: 文件夹右键「脚本」菜单 —— 在 Velo 中打开所选目录。\n\
         # 把首个选中目录传给 Velo；single-instance 会把它设为工作区根。\n\
         for arg in \"$@\"; do\n\
           if [ -d \"$arg\" ]; then\n\
             exec \"{exe}\" \"$arg\"\n\
           fi\n\
         done\n",
        exe = exe.display()
    )
}

fn install_nautilus_script(exe: &std::path::Path) -> bool {
    let home = match std::env::var_os("HOME") {
        Some(h) => h,
        None => return false,
    };
    let dir = PathBuf::from(home).join(".local/share/nautilus/scripts");
    let file = PathBuf::from(&dir).join(SCRIPT_LABEL);

    let content = nautilus_script_content(exe);
    if !write_action_file(&file, &content) {
        return false;
    }
    // Nautilus 脚本必须是可执行文件才会出现在菜单里。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&file) {
            let mut perm = meta.permissions();
            perm.set_mode(0o755);
            if let Err(e) = std::fs::set_permissions(&file, perm) {
                log::warn!("[shell_integration] 设置脚本可执行权限失败({}): {e}", file.display());
            }
        }
    }
    true
}

// ---------------------------------------------------------------------------
// 通用：幂等写入 action 文件
// ---------------------------------------------------------------------------

/// 把 content 写入 path，必要时创建父目录。内容已相同则跳过写（幂等）。
fn write_action_file(path: &std::path::Path, content: &str) -> bool {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return true; // 已是最新，无需重写
        }
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("[shell_integration] 创建目录失败({}): {e}", parent.display());
            return false;
        }
    }
    if let Err(e) = std::fs::write(path, content) {
        log::warn!("[shell_integration] 写入 action 文件失败({}): {e}", path.display());
        false
    } else {
        log::info!("[shell_integration] 已安装 action 文件: {}", path.display());
        true
    }
}

// ---------------------------------------------------------------------------
// DE 检测 + 安装分发
// ---------------------------------------------------------------------------

fn is_kde(desktop: &str) -> bool {
    let lower = desktop.to_ascii_lowercase();
    lower.contains("kde") || lower.contains("plasma")
}

fn is_gnome_family(desktop: &str) -> bool {
    let lower = desktop.to_ascii_lowercase();
    lower.contains("gnome")
        || lower.contains("unity")
        || lower.contains("cinnamon")
        || lower.contains("mate")
        || lower.contains("pantheon")
        || lower.contains("budgie")
}

/// 按当前 DE 安装对应 action 文件。best-effort，失败仅 log。
fn install_for_current_de() {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let exe = match current_exe() {
        Some(p) => p,
        None => {
            log::warn!("[shell_integration] 无法获取 exe 路径，跳过 Linux 菜单注册");
            return;
        }
    };

    if is_kde(&desktop) {
        install_dolphin_service_menu(&exe);
    } else if is_gnome_family(&desktop) {
        install_nautilus_script(&exe);
    } else {
        // 未知 DE：退到 Nautilus 脚本 + 警告。Thunar/XFCE 无文件级机制，本分支只能放弃。
        if !desktop.is_empty() {
            log::warn!(
                "[shell_integration] 未识别的桌面环境 \"{desktop}\"，退到 Nautilus 脚本"
            );
        }
        install_nautilus_script(&exe);
    }
}

// ---------------------------------------------------------------------------
// 公共 API（lib.rs 调用）
// ---------------------------------------------------------------------------

/// setup() 调用：读偏好、按 DE 安装 action 文件。best-effort，不阻塞启动。
pub fn ensure_registered() {
    if !folder_menu_enabled() {
        log::info!("[shell_integration] 文件夹右键菜单偏好为 0，跳过注册");
        return;
    }
    install_for_current_de();
}

/// 运行时切换文件夹右键菜单。写入偏好 + 安装/保留 action 文件。
/// Linux action 文件没有「注销」语义（文件一写就常驻），禁用仅停止刷新；
/// 菜单项仍可能出现但点击后不工作。与 Windows 注册表即时注销语义不同，
/// 但符合 Linux 各 DE 的能力边界。
pub fn set_folder_menu(enabled: bool) {
    write_pref(enabled);
    if enabled {
        install_for_current_de();
    }
}

//! Git 历史集成（#local-timeline-git）
//!
//! 通过 `std::process::Command` 调用系统 `git`，为版本历史面板提供
//! Git commit 历史条目。非 Git 仓库 / git 未安装时静默降级。
//!
//! 三个 `#[tauri::command]`：
//! - `git_repo_root(file_path)` — 检测文件是否在 Git 仓库内，返回仓库根路径或 None
//! - `git_file_history(file_path)` — 获取文件的 commit 历史（metadata only，不含 content）
//! - `git_show_file(repo_root, commit_hash, file_path)` — 获取某 commit 中该文件的内容

use std::path::Path;
use std::process::Command;

/// 检测 git 是否可用（which / where 查找）。
fn git_available() -> bool {
    let cmd = if cfg!(target_os = "windows") {
        Command::new("where").arg("git").output()
    } else {
        Command::new("which").arg("git").output()
    };
    match cmd {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// 把 `git -C <dir> <args...>` 的 stdout 拿成 String。
/// 返回 Err 表示 git 不存在 / 命令执行失败 / 非 0 退出码。
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 执行失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// 规范化路径用于 strip_prefix 比较：
/// - 统一为正斜杠
/// - 统一小写（Windows 不区分大小写）
/// - 去掉尾部分隔符
fn normalize_path(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    while s.ends_with('/') {
        s.pop();
    }
    if cfg!(target_os = "windows") {
        s.to_lowercase()
    } else {
        s
    }
}

/// 计算文件相对于仓库根的路径，返回 **正斜杠** 分隔的相对路径。
/// git show hash:path 在 git tree 内部查找，只认正斜杠，
/// 所以无论平台都必须输出 `dir/subdir/file.md` 格式。
///
/// 大小写保留原始 file_path 的大小写——git log -- <path> 在 Windows 上
/// 虽然 core.ignorecase=true，但 --follow 对大小写敏感，
/// 小写化会导致 git log 匹配不到文件。
fn relative_to_repo(repo_root: &str, file_path: &str) -> String {
    let root_norm = normalize_path(repo_root);
    let file_norm = normalize_path(file_path);

    if file_norm.starts_with(&root_norm) {
        // 从 file_path 截取后缀（保留原始大小写），但把反斜杠转为正斜杠
        let rel = &file_path[root_norm.len()..];
        return rel
            .trim_start_matches(['/', '\\'])
            .replace('\\', "/");
    }

    // fallback: 用 git ls-files 获取相对路径（已是正斜杠 + 原始大小写）
    if let Ok(rel) = run_git(repo_root, &["ls-files", "--full-name", file_path]) {
        let rel = rel.trim();
        if !rel.is_empty() {
            return rel.to_string();
        }
    }

    // 最后 fallback: 用文件名
    Path::new(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct GitCommitEntry {
    /// commit hash (full SHA)
    pub hash: String,
    /// commit hash 短格式 (7 位)
    pub short_hash: String,
    /// 作者名
    pub author: String,
    /// 作者时间戳 (ms)
    pub author_date: i64,
    /// commit message 第一行
    pub subject: String,
    /// commit message 完整内容(subject + body)
    pub message: String,
}

/// 检测文件是否在 Git 仓库内。
/// 返回 Some(repo_root) 或 None（非 git 仓库 / git 未安装）。
#[tauri::command]
pub async fn git_repo_root(file_path: String) -> Option<String> {
    if !git_available() {
        return None;
    }

    // 文件所在目录（git -C 需要一个存在的目录）
    let parent = Path::new(&file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    // 如果文件没有父目录（根路径），用当前目录
    let dir = if parent.is_empty() { ".".to_string() } else { parent };

    match run_git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => Some(root.trim().to_string()),
        Err(_) => None,
    }
}

/// 获取文件的 Git commit 历史。
/// 返回按时间倒序(最新在前)的 commit 列表。
///
/// 使用 `--follow` 跟踪文件重命名。
/// 用 `\x1f` (Unit Separator) 作为字段分隔符,`\x1e` (Record Separator) 作为记录分隔符,
/// 避免 commit message 中含特殊字符导致解析问题。
///
/// `--max-count` 限制返回数量,避免超大仓库加载过多 commit 导致性能问题。
/// 前端预加载前 20 条的 content(git show),其余选中时懒加载。
#[tauri::command]
pub async fn git_file_history(file_path: String) -> Result<Vec<GitCommitEntry>, String> {
    if !git_available() {
        return Ok(Vec::new());
    }

    let parent = Path::new(&file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    let dir = if parent.is_empty() { ".".to_string() } else { parent };

    // 获取仓库根
    let repo_root = match run_git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => root.trim().to_string(),
        Err(_) => return Ok(Vec::new()),
    };

    // 计算相对路径
    let rel_path = relative_to_repo(&repo_root, &file_path);

    // git log --follow 格式: <hash>\x1f<short>\x1f<author>\x1f<timestamp>\x1f<subject>\x1f<message>\x1e
    // %s = subject(第一行), %B = 完整 raw body(含 subject + body 换行)
    let format = "%H\x1f%h\x1f%an\x1f%at\x1f%s\x1f%B\x1e";
    let log_output = run_git(
        &repo_root,
        &[
            "log",
            "--follow",
            "--max-count=100",
            &format!("--pretty=format:{format}"),
            "--",
            &rel_path,
        ],
    );

    let log = match log_output {
        Ok(s) => s,
        Err(_) => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    for record in log.split('\x1e') {
        let record = record.trim();
        if record.is_empty() {
            continue;
        }
        let fields: Vec<&str> = record.split('\x1f').collect();
        if fields.len() < 5 {
            continue;
        }
        let author_date = fields[3].trim().parse::<i64>().unwrap_or(0) * 1000; // s → ms
        // %B 输出的完整 message 末尾会带一个换行,trim 掉
        let message = fields.get(5).map(|s| s.trim_end().to_string()).unwrap_or_default();
        entries.push(GitCommitEntry {
            hash: fields[0].to_string(),
            short_hash: fields[1].to_string(),
            author: fields[2].to_string(),
            author_date,
            subject: fields[4].to_string(),
            message,
        });
    }

    Ok(entries)
}

/// 获取某 commit 中该文件的内容（`git show <hash>:<path>`）。
/// 用于用户点击 Git 条目时懒加载 content。
#[tauri::command]
pub async fn git_show_file(
    repo_root: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    if !git_available() {
        return Err("git 不可用".to_string());
    }

    let rel_path = relative_to_repo(&repo_root, &file_path);
    let treeish = format!("{commit_hash}:{rel_path}");
    run_git(&repo_root, &["show", &treeish])
}

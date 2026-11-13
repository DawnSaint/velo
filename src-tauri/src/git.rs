//! Git 历史集成（#local-timeline-git / #rust-search-quickopen-git Phase 3）
//!
//! 优先用 `git2`（libgit2，静态链入）库内直读仓库，免 spawn 系统 git 子进程
//! （开一次面板从 ~23 个子进程 / ~1s 降到 0 子进程 / ~17ms，实测 ~60×）。
//! git2 打开 / 读取失败（损坏 / 权限 / 特殊 worktree）时回退现有 CLI 路径，
//! 行为不回退。非 Git 仓库 / git 未安装时静默降级。
//!
//! 三个 `#[tauri::command]`（签名不变，前端零改动）：
//! - `git_repo_root(file_path)` — 检测文件是否在 Git 仓库内，返回仓库根路径或 None
//! - `git_file_history(file_path)` — 获取文件的 commit 历史（metadata only，不含 content）
//! - `git_show_file(repo_root, commit_hash, file_path)` — 获取某 commit 中该文件的内容
//!
//! **--follow 重命名跟踪**：git2 无内置等价物，MVP 不跟踪重命名（按固定路径
//! 查 tree + blob-id 去重），与 VSCode Local History 的「按路径」语义对齐。
//! 面板文案注明此限制。见 docs/architecture/tauri.md Git 历史条目。

use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

/// 构造子进程 Command。
///
/// Windows release 下 Velo 是 windows subsystem(`main.rs` 的 `windows_subsystem` attr),
/// 进程自身没有控制台。此时 spawn 控制台子系统的程序(`git.exe` / `where.exe`)会被系统
/// 分配一个**新的**控制台窗口 —— 打开版本历史时刷出一串闪烁即消失的 CMD 窗口。
/// `tauri dev` 是 debug build,父进程自带控制台,子进程直接继承,所以该现象只在 build 后出现。
/// `CREATE_NO_WINDOW` 显式禁止为子进程创建控制台;stdout/stderr 管道照常工作,不影响读取输出。
#[cfg(windows)]
fn spawn(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn spawn(program: &str) -> Command {
    Command::new(program)
}

/// `where git` / `which git` 的探测结果。
///
/// **只缓存"git 可用"这一种结果**:git 可用时才是重路径(开一次面板要跑 20+ 次
/// `git show`,每次都得先探一次 `where git`),缓存它能把进程数从约 45 降到约 24;
/// git 未安装时每个 command 只多 1 次 spawn,保持重试让用户装上 git 后无需重启 Velo。
static GIT_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// 检测 git 是否可用（which / where 查找）。
fn git_available() -> bool {
    if let Some(true) = GIT_AVAILABLE.get().copied() {
        return true;
    }

    let cmd = if cfg!(target_os = "windows") {
        spawn("where").arg("git").output()
    } else {
        spawn("which").arg("git").output()
    };
    let found = match cmd {
        Ok(o) => o.status.success(),
        Err(_) => false,
    };

    // 并发调用(20 条预加载的 git show 是 Promise.all)下 set 可能抢输,忽略即可。
    if found {
        let _ = GIT_AVAILABLE.set(true);
    }
    found
}

/// 把 `git -C <dir> <args...>` 的 stdout 拿成 String。
/// 返回 Err 表示 git 不存在 / 命令执行失败 / 非 0 退出码。
fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let output = spawn("git")
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

// ============ git2 库内直读（Phase 3 主路径）============
//
// 与 CLI 路径的口径对齐：
// - repo_root 返回 workdir（去尾分隔符），与 `git rev-parse --show-toplevel` 一致
// - history 按时间倒序、最多 100 条、blob-id 去重（跳过「commit 改了别的文件」）
// - **不跟踪重命名**（无 --follow 等价物）：按固定 rel_path 查 tree
// - author_date 秒 → 毫秒；message 去尾部换行（同 CLI %B trim_end）

/// 用 git2 打开文件所在仓库，返回 (repo, workdir 字符串)。失败 → Err。
fn open_repo(file_path: &str) -> Result<(git2::Repository, String), String> {
    let parent = Path::new(file_path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let repo = git2::Repository::discover(parent).map_err(|e| format!("git2 discover: {e}"))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare 仓库无 workdir".to_string())?;
    let mut root = workdir.to_string_lossy().to_string();
    while root.ends_with('/') || root.ends_with('\\') {
        root.pop();
    }
    Ok((repo, root))
}

/// 计算 file_path 相对 workdir 的正斜杠路径（git tree 内部只认正斜杠）。
fn rel_to_workdir(workdir: &str, file_path: &str) -> String {
    let wd = Path::new(workdir);
    let fp = Path::new(file_path);
    if let Ok(rel) = fp.strip_prefix(wd) {
        return rel.to_string_lossy().replace('\\', "/");
    }
    // strip_prefix 失败（大小写 / 符号链接差异）→ 退化为文件名
    fp.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.to_string())
}

/// git2 版 git_repo_root。
fn repo_root_git2(file_path: &str) -> Result<String, String> {
    let (_repo, root) = open_repo(file_path)?;
    Ok(root)
}

/// git2 版 git_file_history：revwalk + tree.get_path + blob-id 去重，最多 100 条。
fn file_history_git2(file_path: &str) -> Result<Vec<GitCommitEntry>, String> {
    let (repo, root) = open_repo(file_path)?;
    let rel = rel_to_workdir(&root, file_path);
    let rel_path = Path::new(&rel);

    let mut revwalk = repo.revwalk().map_err(|e| format!("revwalk: {e}"))?;
    // push_head 失败（空仓库 / 无 HEAD）→ 空历史，与 CLI 行为一致
    if revwalk.push_head().is_err() {
        return Ok(Vec::new());
    }
    // 按时间倒序（最新在前），与 git log 默认一致
    let _ = revwalk.set_sorting(git2::Sort::TIME);

    let mut entries = Vec::new();
    let mut prev_blob: Option<git2::Oid> = None;
    for oid in revwalk {
        let oid = match oid {
            Ok(o) => o,
            Err(_) => continue,
        };
        let commit = match repo.find_commit(oid) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let tree = match commit.tree() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // 该 commit 中此路径不存在（重命名前 / 尚未创建）→ 跳过
        let entry = match tree.get_path(rel_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        // blob-id 去重：内容未变的 commit 不重复列出（同 CLI pathspec 过滤）
        if prev_blob == Some(entry.id()) {
            continue;
        }
        prev_blob = Some(entry.id());

        let author = commit.author();
        let name = author.name().unwrap_or("").to_string();
        let author_date = author.when().seconds() * 1000; // s → ms
        let message_raw = commit.message().unwrap_or("");
        let message = message_raw.trim_end().to_string();
        let subject = commit.summary().unwrap_or("").to_string();
        let hash = oid.to_string();
        let short_hash = hash.chars().take(7).collect::<String>();

        entries.push(GitCommitEntry {
            hash,
            short_hash,
            author: name,
            author_date,
            subject,
            message,
        });
        if entries.len() >= 100 {
            break;
        }
    }
    Ok(entries)
}

/// git2 版 git_show_file：读某 commit 中该路径的 blob 内容。
fn show_file_git2(repo_root: &str, commit_hash: &str, file_path: &str) -> Result<String, String> {
    let repo = git2::Repository::open(repo_root).map_err(|e| format!("git2 open: {e}"))?;
    let rel = rel_to_workdir(repo_root, file_path);
    let oid = git2::Oid::from_str(commit_hash).map_err(|e| format!("无效 hash: {e}"))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("find_commit: {e}"))?;
    let tree = commit.tree().map_err(|e| format!("tree: {e}"))?;
    let entry = tree
        .get_path(Path::new(&rel))
        .map_err(|e| format!("路径不存在: {e}"))?;
    let blob = repo.find_blob(entry.id()).map_err(|e| format!("blob: {e}"))?;
    // 与 CLI `git show` 的 stdout 一致：按 UTF-8 损失转换（二进制内容罕见）
    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

/// 检测文件是否在 Git 仓库内。
/// 返回 Some(repo_root) 或 None（非 git 仓库 / git 未安装）。
/// git2 优先；失败回退 CLI。
#[tauri::command]
pub async fn git_repo_root(file_path: String) -> Option<String> {
    // 主路径：git2 库内直读（免子进程）
    if let Ok(root) = repo_root_git2(&file_path) {
        return Some(root);
    }
    // 降级：CLI（git2 打不开的损坏 / 特殊 worktree）
    if !git_available() {
        return None;
    }
    let parent = Path::new(&file_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());
    let dir = if parent.is_empty() { ".".to_string() } else { parent };
    match run_git(&dir, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => Some(root.trim().to_string()),
        Err(_) => None,
    }
}

/// 获取文件的 Git commit 历史。
/// 返回按时间倒序(最新在前)的 commit 列表。
///
/// git2 优先（revwalk + tree + blob-id 去重，**不跟踪重命名**）；
/// git2 失败时回退 CLI `git log --follow`（保留重命名跟踪能力）。
///
/// CLI 路径用 `\x1f` (Unit Separator) 作为字段分隔符,`\x1e` (Record Separator)
/// 作为记录分隔符,避免 commit message 中含特殊字符导致解析问题。
///
/// `--max-count` 限制返回数量,避免超大仓库加载过多 commit 导致性能问题。
/// 前端预加载前 20 条的 content(git show),其余选中时懒加载。
#[tauri::command]
pub async fn git_file_history(file_path: String) -> Result<Vec<GitCommitEntry>, String> {
    // 主路径：git2 库内直读（免子进程，~60×）
    if let Ok(entries) = file_history_git2(&file_path) {
        return Ok(entries);
    }
    // 降级：CLI（git2 打不开时保留 --follow 重命名跟踪）
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
/// git2 优先（读 blob）；失败回退 CLI。
#[tauri::command]
pub async fn git_show_file(
    repo_root: String,
    commit_hash: String,
    file_path: String,
) -> Result<String, String> {
    // 主路径：git2 读 blob（免子进程）
    if let Ok(content) = show_file_git2(&repo_root, &commit_hash, &file_path) {
        return Ok(content);
    }
    // 降级：CLI
    if !git_available() {
        return Err("git 不可用".to_string());
    }
    let rel_path = relative_to_repo(&repo_root, &file_path);
    let treeish = format!("{commit_hash}:{rel_path}");
    run_git(&repo_root, &["show", &treeish])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 建一个临时 git 仓库并提交一个文件，返回 (tempdir, repo_root, file_path)。
    /// 用 git2 自身建仓库 + 提交，不依赖系统 git。
    fn make_repo_with_file(content: &str) -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let file = dir.path().join("note.md");
        fs::write(&file, content).unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("note.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let sig = git2::Signature::now("Tester", "tester@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init: add note", &tree, &[])
            .unwrap();

        let root = dir.path().to_string_lossy().to_string();
        let file_path = file.to_string_lossy().to_string();
        (dir, root, file_path)
    }

    #[test]
    fn repo_root_git2_finds_workdir() {
        let (_dir, root, file) = make_repo_with_file("hello");
        let found = repo_root_git2(&file).unwrap();
        // workdir 去尾分隔符后与 root 一致（平台分隔符）
        let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
        assert_eq!(norm(&found), norm(&root));
    }

    #[test]
    fn repo_root_git2_non_repo_errors() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("lonely.md");
        fs::write(&file, "x").unwrap();
        assert!(repo_root_git2(&file.to_string_lossy()).is_err());
    }

    #[test]
    fn history_git2_single_commit() {
        let (_dir, _root, file) = make_repo_with_file("hello");
        let entries = file_history_git2(&file).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].subject, "init: add note");
        assert_eq!(entries[0].author, "Tester");
        assert_eq!(entries[0].hash.len(), 40);
        assert_eq!(entries[0].short_hash.len(), 7);
        assert!(entries[0].author_date > 0);
        assert_eq!(entries[0].message, "init: add note");
    }

    #[test]
    fn history_git2_blob_dedup() {
        let (dir, _root, file) = make_repo_with_file("v1");
        let repo = git2::Repository::open(dir.path()).unwrap();
        let sig = git2::Signature::now("Tester", "tester@example.com").unwrap();

        // 第二次提交：改别的文件，note.md 内容不变 → blob-id 相同应被去重
        fs::write(dir.path().join("other.md"), "other").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("other.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let head = repo.head().unwrap().target().unwrap();
        let parent = repo.find_commit(head).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "add other", &tree, &[&parent]).unwrap();

        // 第三次提交：改 note.md → 新 blob，应列出
        fs::write(&file, "v2").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("note.md")).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let head = repo.head().unwrap().target().unwrap();
        let parent = repo.find_commit(head).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "update note", &tree, &[&parent]).unwrap();

        let entries = file_history_git2(&file).unwrap();
        // 3 个 commit，但中间那个 note.md 未变 → 去重后 2 条
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "update note"); // 最新在前
        assert_eq!(entries[1].subject, "init: add note");
    }

    #[test]
    fn show_file_git2_reads_blob() {
        let (_dir, root, file) = make_repo_with_file("hello world");
        let entries = file_history_git2(&file).unwrap();
        let content = show_file_git2(&root, &entries[0].hash, &file).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn show_file_git2_missing_path_errors() {
        let (_dir, root, file) = make_repo_with_file("hello");
        let entries = file_history_git2(&file).unwrap();
        let missing = Path::new(&root).join("nope.md").to_string_lossy().to_string();
        assert!(show_file_git2(&root, &entries[0].hash, &missing).is_err());
    }

    #[test]
    fn rel_to_workdir_forward_slashes() {
        let root = if cfg!(windows) { "C:\\repo" } else { "/repo" };
        let file = if cfg!(windows) { "C:\\repo\\docs\\a.md" } else { "/repo/docs/a.md" };
        assert_eq!(rel_to_workdir(root, file), "docs/a.md");
    }
}

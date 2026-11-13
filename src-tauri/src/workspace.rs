//! 工作区文件遍历 / 全文搜索 / 全文替换（#rust-search-quickopen-git Phase 1+2）
//!
//! `scan_workspace_files` 用一次 command 收集工作区根下所有 Markdown 文件，
//! 替换前端 quickOpenIndex 的「按层并发 readDir + 每条目一次 join IPC」
//! （5k 文件 ≈ 上万次 IPC 往返 → 1 次 command + 1 次结果序列化）。
//!
//! `search_workspace` 用 grep-searcher（ripgrep 同款引擎）+ rayon 按文件并行
//! 扫描，命中按批走 Tauri Channel 流式回传（禁止全量一次返回：稠密命中
//! 74992 条 ≈ 15MB JSON，序列化会反超扫描本身）。取消走独立 command
//! `cancel_workspace_search` + AtomicBool，每文件 / 每命中行检查。
//!
//! `replace_workspace` 读 → 替换 → 计数 → 写盘，dirty 守门（前端 snapshot
//! 的脏 tab 集合传入，一律跳过），返回结构与前端 ReplaceResult 对齐。
//!
//! 过滤规则与前端 `quickOpenIndex.ts` / `markdownPath.ts` 严格对齐：
//! - 只收 md / markdown / mdown（大小写不敏感，同 MARKDOWN_EXT_RE）
//! - 隐藏**目录**整段跳过（.git / .vscode 等）；隐藏**文件**不跳过
//! - 不跟随符号链接（JS readDir 同样不跟随）
//! - rel_path 归一为正斜杠；full_path 保留平台分隔符（与前端 join 输出同风格）
//! - 单条目 IO 错误（权限等）静默跳过，不影响整次 walk（同 JS readDir catch）
//!
//! 命中口径与前端 `workspaceSearch.ts searchFileContent` 逐条对齐：
//! - 逐行扫描（匹配不跨行）；行尾 \r\n / \n 从展示行剥掉（同 displayLineEnd）
//! - 偏移量全部是 **UTF-16 code unit**（JS string 坐标），不是字节 ——
//!   rawFrom/rawTo 直接喂给编辑器 setSelection，中文 / emoji 必须换算
//! - 零宽匹配跳过（同 JS `m[0].length === 0 → continue`）
//! - wholeWord 外层 \b(?:body)\b、caseSensitive 控制 i flag（同 buildPattern）
//! - 正则方言差异（JS lookahead/反向引用 vs Rust regex）：编译失败返回
//!   结构化错误，前端降级回 JS 引擎
//! - 非 UTF-8 文件整体跳过（JS readTextFile 同样会失败）
//!
//! 已知微分歧（可接受，记录备查）：JS `i` flag 用 Simple Case Folding，
//! Rust regex 用 Unicode Case Folding（如长 s ſ 在 JS 不匹配 s、Rust 匹配）；
//! 替换模板 JS 支持 $` / $'（前后文引用），Rust expand 不支持 —— 两者都属
//! 极罕见边角，共享测试语料覆盖常见场景。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use rayon::prelude::*;
use walkdir::WalkDir;

/// Markdown 扩展名集合 —— 与前端 MARKDOWN_EXTENSIONS 同源。
/// 注意 lib.rs 的 MD_EXTS（CLI argv 解析）是更宽的集合，两者用途不同，勿合并。
const MD_EXTS: &[&str] = &["md", "markdown", "mdown"];

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct WorkspaceFileEntry {
    /// 绝对路径（平台分隔符，与前端 join 输出同风格）
    pub full_path: String,
    /// 文件名（含后缀）
    pub name: String,
    /// 相对 root 的路径，正斜杠分隔（展示用）
    pub rel_path: String,
}

/// 与前端 `MARKDOWN_EXT_RE = /\.(md|markdown|mdown)$/i` 等价：
/// 按最后一个 `.` 取扩展名，大小写不敏感。`.md`（无主名）也算命中，与正则一致。
fn is_markdown(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => MD_EXTS.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// 遍历 root 收集全部 Markdown 文件。root 不存在 / 不是目录 → Err。
pub fn scan_workspace(root: &str) -> Result<Vec<WorkspaceFileEntry>, String> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("工作区根不存在或不是目录: {root}"));
    }

    let mut out = Vec::new();
    let walker = WalkDir::new(root_path)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // root 自身不过滤：用户可能把隐藏目录（如 .notes）开成工作区。
            // 只跳隐藏子目录，与 JS scanDir 的 `e.name.startsWith('.')` 一致。
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                !e.file_name().to_string_lossy().starts_with('.')
            }
            else {
                true
            }
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            // 单条目权限 / IO 错误不影响整次 walk（同 JS readDir catch）
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_markdown(&name) {
            continue;
        }
        // strip_prefix 按路径组件比较，root 带不带尾分隔符 / 混合斜杠都安全。
        let rel = entry.path().strip_prefix(root_path).unwrap_or(entry.path());
        let rel_path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        out.push(WorkspaceFileEntry {
            full_path: entry.path().to_string_lossy().to_string(),
            name,
            rel_path,
        });
    }
    Ok(out)
}

/// Ctrl+P 文件索引：单 command 返回工作区全量 .md 条目。
/// 放 blocking 线程池执行，避免大工作区遍历占用 async runtime / 主线程。
#[tauri::command]
pub async fn scan_workspace_files(root: String) -> Result<Vec<WorkspaceFileEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_workspace(&root))
        .await
        .map_err(|e| format!("扫描任务失败: {e}"))?
}

// ============ Phase 2:全文搜索 / 替换 ============

/// 与前端 FindOptions 对齐（serde camelCase）。
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// 与前端 escapeRegex 同集合：`[.*+?^${}()|[\]\\]`。
fn escape_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '.' | '*' | '+' | '?' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// 与前端 buildPattern 同构：非 regex 模式 escape；wholeWord 外层 \b(?:body)\b。
fn build_pattern_body(query: &str, options: &SearchOptions) -> String {
    let body = if options.regex { query.to_string() } else { escape_regex(query) };
    if options.whole_word { format!("\\b(?:{body})\\b") } else { body }
}

/// UTF-8 字节偏移 → UTF-16 code unit 偏移（JS string 坐标）。
/// 逐字符走一遍；行长度有限，开销可忽略。 astral 字符（emoji）占 2 个 unit。
fn utf16_offset(s: &str, byte_idx: usize) -> usize {
    let mut units = 0usize;
    for (i, c) in s.char_indices() {
        if i >= byte_idx { break; }
        units += c.len_utf16();
    }
    units
}

/// 一次搜索 / 替换运行期的取消令牌表。search_id 由前端生成（runId 同源），
/// cancel_workspace_search 置位；任务结束（含出错）自行移除。
static SEARCH_CANCEL_TOKENS: OnceLock<Mutex<HashMap<u64, Arc<AtomicBool>>>> = OnceLock::new();

fn cancel_tokens() -> &'static Mutex<HashMap<u64, Arc<AtomicBool>>> {
    SEARCH_CANCEL_TOKENS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_cancel_token(id: u64) -> Arc<AtomicBool> {
    let token = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = cancel_tokens().lock() {
        map.insert(id, token.clone());
    }
    token
}

fn remove_cancel_token(id: u64) {
    if let Ok(mut map) = cancel_tokens().lock() {
        map.remove(&id);
    }
}

/// 前端 controller.cancel() 时调用：置位对应 search_id 的取消令牌。
/// 未知 id（已结束 / 不存在）静默 no-op。
#[tauri::command]
pub fn cancel_workspace_search(search_id: u64) {
    if let Ok(map) = cancel_tokens().lock() {
        if let Some(token) = map.get(&search_id) {
            token.store(true, Ordering::SeqCst);
        }
    }
}

/// Channel 流式事件。前端按 kind 分发；字段 camelCase。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchEvent {
    /// 遍历完成，进入逐文件搜索阶段
    Scanned { files_found: usize },
    /// 一个文件的全部命中（fileMatchCount 已回填）。仅有命中的文件发此事件。
    File {
        file: WorkspaceFileEntry,
        hits: Vec<SearchHit>,
        files_searched: usize,
        hits_total: usize,
    },
    /// 无命中文件的轻量进度（避免为每个空文件序列化完整条目）
    Progress { files_searched: usize, hits_total: usize },
    /// 搜索结束（正常完成或被取消）
    Done { canceled: bool, files_searched: usize, hits_total: usize },
}

/// 单条命中 —— 字段与前端 WorkspaceSearchHit 一一对应（除 id / query /
/// options 由前端回填：它们对同一 run 是常量，不必每条重复传输）。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub full_path: String,
    pub rel_path: String,
    pub file_name: String,
    pub line_number: u64,
    pub line_text: String,
    pub match_start_in_line: usize,
    pub match_end_in_line: usize,
    pub raw_from: usize,
    pub raw_to: usize,
    pub match_text: String,
    pub match_ordinal: usize,
    pub file_match_count: usize,
}

/// 单文件扫描结果。读失败 / 非 UTF-8 → hits 为空（计入 filesSearched，
/// 同 JS readTextFile catch 后 continue）。
struct FileSearchOutcome {
    entry: WorkspaceFileEntry,
    hits: Vec<SearchHit>,
}

/// 自定义 Sink：逐命中行回调，从 `SinkMatch.absolute_byte_offset()` 拿该行
/// 在原文中的**真实字节基址**，再换算 UTF-16 得 JS lineStart 坐标。
///
/// 为什么不用 sinks::UTF8 + 手动累加行基址：UTF8 sink 只对**命中行**回调，
/// 非命中行不回调，手动累加会漏算前面所有非命中行 → rawFrom 漂移。
/// absolute_byte_offset 由 searcher 维护，跨非命中行也准确。
struct HitSink<'a> {
    entry: &'a WorkspaceFileEntry,
    matcher: &'a grep_regex::RegexMatcher,
    cancel: &'a AtomicBool,
    /// 原文（用于把绝对字节偏移换算成 UTF-16 基址）
    content: &'a str,
    hits: Vec<SearchHit>,
    ordinal: usize,
}

impl<'a> Sink for HitSink<'a> {
    type Error = std::io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            return Ok(false); // 停止本文件扫描
        }
        let line_number = mat.line_number().unwrap_or(0);
        let line = match std::str::from_utf8(mat.bytes()) {
            Ok(s) => s,
            Err(_) => return Ok(true), // 非 UTF-8 行跳过（整文件 read_to_string 已保证 UTF-8，兜底）
        };
        // 展示行：剥行终止符（同 JS displayLineEnd 去 \r）
        let display = line.strip_suffix("\r\n").or_else(|| line.strip_suffix('\n')).unwrap_or(line);

        // 该行在原文中的字节基址 → UTF-16 基址（JS lineStart 坐标）
        let line_base_byte = mat.absolute_byte_offset() as usize;
        let line_base_u16 = utf16_offset(self.content, line_base_byte);

        let display_bytes = display.as_bytes();
        let entry = self.entry;
        let ordinal = &mut self.ordinal;
        let hits = &mut self.hits;
        let _ = self.matcher.find_iter(display_bytes, |m| {
            if m.start() == m.end() {
                return true; // 零宽匹配跳过（同 JS）
            }
            let start_u16 = utf16_offset(display, m.start());
            let end_u16 = utf16_offset(display, m.end());
            hits.push(SearchHit {
                full_path: entry.full_path.clone(),
                rel_path: entry.rel_path.clone(),
                file_name: entry.name.clone(),
                line_number,
                line_text: display.to_string(),
                match_start_in_line: start_u16,
                match_end_in_line: end_u16,
                raw_from: line_base_u16 + start_u16,
                raw_to: line_base_u16 + end_u16,
                match_text: display[m.start()..m.end()].to_string(),
                match_ordinal: *ordinal,
                file_match_count: 0, // 扫描完回填
            });
            *ordinal += 1;
            true
        });
        Ok(!self.cancel.load(Ordering::Relaxed))
    }
}

/// 扫描单个文件。matcher 已按 buildPattern 语义构建。
/// 逐行口径：line 含行终止符，展示行剥 \r\n / \n（同 JS displayLineEnd）；
/// 行基址走 SinkMatch.absolute_byte_offset（真实字节偏移）换算 UTF-16，
/// 保证 rawFrom 与 JS 的 lineStart 完全一致。零宽匹配跳过。
fn search_one_file(
    entry: &WorkspaceFileEntry,
    matcher: &grep_regex::RegexMatcher,
    cancel: &AtomicBool,
) -> FileSearchOutcome {
    let content = match std::fs::read_to_string(&entry.full_path) {
        Ok(c) => c,
        Err(_) => return FileSearchOutcome { entry: entry.clone(), hits: Vec::new() },
    };

    let mut searcher = SearcherBuilder::new().line_number(true).build();
    let mut sink = HitSink {
        entry,
        matcher,
        cancel,
        content: &content,
        hits: Vec::new(),
        ordinal: 0,
    };

    // search_slice 失败（IO 等）按"该文件无命中"处理，同 JS catch
    let _ = searcher.search_slice(matcher, content.as_bytes(), &mut sink);

    let mut hits = sink.hits;
    let count = hits.len();
    for h in &mut hits {
        h.file_match_count = count;
    }
    FileSearchOutcome { entry: entry.clone(), hits }
}

/// 构建 grep matcher。Rust regex 编译失败（JS 方言：lookahead / 反向引用等）
/// 返回 Err，前端据此降级回 JS 引擎。
fn build_matcher(query: &str, options: &SearchOptions) -> Result<grep_regex::RegexMatcher, String> {
    let body = build_pattern_body(query, options);
    RegexMatcherBuilder::new()
        .case_insensitive(!options.case_sensitive)
        .build(&body)
        .map_err(|e| format!("正则编译失败: {e}"))
}

/// 全文搜索：walkdir 收集 → rayon 按文件并行 grep → Channel 分批流式回传。
/// 取消：cancel_workspace_search(search_id) 置位 AtomicBool，每文件 / 每命中行检查。
#[tauri::command]
pub async fn search_workspace(
    root: String,
    scope_dir: Option<String>,
    query: String,
    options: SearchOptions,
    search_id: u64,
    channel: tauri::ipc::Channel<SearchEvent>,
) -> Result<(), String> {
    if query.is_empty() {
        return Ok(());
    }
    let matcher = build_matcher(&query, &options)?;
    let token = register_cancel_token(search_id);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let start_dir = scope_dir.unwrap_or(root);
        let files = match scan_workspace(&start_dir) {
            Ok(f) => f,
            Err(e) => return Err(e),
        };
        let _ = channel.send(SearchEvent::Scanned { files_found: files.len() });

        let files_searched = AtomicU64::new(0);
        let hits_total = AtomicU64::new(0);
        let canceled = || token.load(Ordering::Relaxed);

        // rayon 并行扫描；每文件结果经 channel 流式回传。
        // channel.send 内部线程安全；计数用原子量，前端按事件累计展示。
        files.par_iter().for_each(|entry| {
            if canceled() { return; }
            let outcome = search_one_file(entry, &matcher, &token);
            let searched = files_searched.fetch_add(1, Ordering::Relaxed) + 1;
            let total = hits_total.fetch_add(outcome.hits.len() as u64, Ordering::Relaxed)
                + outcome.hits.len() as u64;
            if !outcome.hits.is_empty() {
                let _ = channel.send(SearchEvent::File {
                    file: outcome.entry,
                    hits: outcome.hits,
                    files_searched: searched as usize,
                    hits_total: total as usize,
                });
            }
            else {
                // 无命中文件只推进度计数，载荷极小
                let _ = channel.send(SearchEvent::Progress {
                    files_searched: searched as usize,
                    hits_total: total as usize,
                });
            }
        });

        let _ = channel.send(SearchEvent::Done {
            canceled: canceled(),
            files_searched: files_searched.load(Ordering::Relaxed) as usize,
            hits_total: hits_total.load(Ordering::Relaxed) as usize,
        });
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("搜索任务失败: {e}"))?;

    remove_cancel_token(search_id);
    result
}

// ============ Phase 2:全文替换 ============

/// 与前端 ReplacePlan 对齐。
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePlan {
    pub query: String,
    pub options: SearchOptions,
    pub replacement: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailure {
    pub full_path: String,
    pub reason: String,
}

/// 与前端 ReplaceResult 对齐（fileContents 用 HashMap，前端转 Map）。
#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub changed_files: Vec<String>,
    pub replaced_count: usize,
    pub skipped_files: Vec<String>,
    pub failed_files: Vec<ReplaceFailure>,
    pub file_contents: HashMap<String, String>,
}

/// 统计 content 中非零宽匹配数（同 JS countMatches）。
fn count_matches(re: &regex::Regex, content: &str) -> usize {
    re.find_iter(content).filter(|m| m.start() != m.end()).count()
}

/// 替换模板方言归一（JS String.replace → Rust regex expand）：
/// - `$$`（字面 $）：Rust expand 原生支持，原样保留
/// - `$&`（整段匹配）：Rust 不认 `$&`，转 `${0}`
/// - `$0`（整段匹配，JS 事实支持）：Rust 把裸 `$0` 当 named ref "0"，转 `${0}`
/// - `$1`..`$99` / `${name}`：两侧语义一致，原样保留
/// 注意：JS 的 $` / $'（前后文引用）Rust 无等价物，原样透传（罕见边角）。
fn normalize_replacement(replacement: &str) -> String {
    let chars: Vec<char> = replacement.chars().collect();
    let mut out = String::with_capacity(replacement.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '$' && i + 1 < chars.len() {
            let next = chars[i + 1];
            if next == '&' {
                out.push_str("${0}");
                i += 2;
                continue;
            }
            if next == '0' && !(i + 2 < chars.len() && chars[i + 2].is_ascii_digit()) {
                out.push_str("${0}");
                i += 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// 逐匹配替换，支持 $1 / $2 / $& / ${name}（regex Captures::expand）。
/// 与 JS String.replace 的全局替换语义对齐（零宽匹配跳过）。
fn replace_all(re: &regex::Regex, content: &str, replacement: &str) -> String {
    let template = normalize_replacement(replacement);
    let mut out = String::with_capacity(content.len());
    let mut last = 0usize;
    for caps in re.captures_iter(content) {
        let m = caps.get(0).unwrap();
        if m.start() == m.end() {
            continue; // 零宽跳过（同 JS replaceInText 的 countMatches 口径）
        }
        out.push_str(&content[last..m.start()]);
        caps.expand(&template, &mut out);
        last = m.end();
    }
    out.push_str(&content[last..]);
    out
}

/// 全文替换：dirty 守门 → 读 → 替换 → 计数差值 → 写盘。
/// 与前端 applyWorkspaceReplace 语义逐条对齐：
/// - dirtyPaths（前端替换瞬间 snapshot）一律跳过，不读不写
/// - 读 / 写失败入 failedFiles，不阻塞其它文件
/// - 内容未变化（命中被外部改动移走）不进 changedFiles
/// - replacedCount = countMatches(旧) - countMatches(新)，负值钳 0
/// - fileContents 返回新内容，前端同步 clean tab 免一次 readTextFile
#[tauri::command]
pub async fn replace_workspace(
    paths: Vec<String>,
    plan: ReplacePlan,
    dirty_paths: Vec<String>,
) -> Result<ReplaceOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut outcome = ReplaceOutcome::default();
        if paths.is_empty() {
            return outcome;
        }
        let body = build_pattern_body(&plan.query, &plan.options);
        let re = match regex::RegexBuilder::new(&body)
            .case_insensitive(!plan.options.case_sensitive)
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                // 正则无效：所有受影响文件记失败（同 JS buildPattern null 分支）
                let mut seen = HashSet::new();
                for p in &paths {
                    if seen.insert(p.clone()) {
                        outcome.failed_files.push(ReplaceFailure {
                            full_path: p.clone(),
                            reason: format!("正则表达式无效: {e}"),
                        });
                    }
                }
                return outcome;
            }
        };

        let dirty: HashSet<String> = dirty_paths.into_iter().collect();
        let mut seen = HashSet::new();
        for full_path in paths {
            if !seen.insert(full_path.clone()) {
                continue; // 按 fullPath 去重（同 JS）
            }
            if dirty.contains(&full_path) {
                outcome.skipped_files.push(full_path);
                continue;
            }
            let content = match std::fs::read_to_string(&full_path) {
                Ok(c) => c,
                Err(e) => {
                    outcome.failed_files.push(ReplaceFailure { full_path, reason: e.to_string() });
                    continue;
                }
            };
            let new_content = replace_all(&re, &content, &plan.replacement);
            if new_content == content {
                continue; // 无命中可换（罕见 race）
            }
            if let Err(e) = std::fs::write(&full_path, &new_content) {
                outcome.failed_files.push(ReplaceFailure { full_path, reason: e.to_string() });
                continue;
            }
            let replaced_in_file =
                count_matches(&re, &content).saturating_sub(count_matches(&re, &new_content));
            outcome.changed_files.push(full_path.clone());
            outcome.file_contents.insert(full_path, new_content);
            outcome.replaced_count += replaced_in_file;
        }
        outcome
    })
    .await
    .map_err(|e| format!("替换任务失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, rel: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    fn rels(entries: &[WorkspaceFileEntry]) -> Vec<String> {
        let mut v: Vec<String> = entries.iter().map(|e| e.rel_path.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn hidden_dirs_skipped_hidden_files_kept() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "a.md");
        write(root, ".hidden.md"); // 隐藏文件：保留（JS 只过滤目录）
        write(root, ".git/config.md"); // 隐藏目录：整段跳过
        write(root, "sub/.vscode/b.md");
        write(root, "sub/c.md");
        let entries = scan_workspace(&root.to_string_lossy()).unwrap();
        assert_eq!(rels(&entries), vec![".hidden.md", "a.md", "sub/c.md"]);
    }

    #[test]
    fn extension_set_and_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "a.md");
        write(root, "b.MD");
        write(root, "c.Markdown");
        write(root, "d.MDOWN");
        write(root, "e.mkd"); // 不在前端集合内（lib.rs CLI 集合更宽，勿混淆）
        write(root, "f.txt");
        write(root, "md"); // 无扩展名
        write(root, "g.md.bak");
        let entries = scan_workspace(&root.to_string_lossy()).unwrap();
        assert_eq!(rels(&entries), vec!["a.md", "b.MD", "c.Markdown", "d.MDOWN"]);
    }

    #[test]
    fn rel_path_forward_slashes_and_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "docs/guide/intro.md");
        let entries = scan_workspace(&root.to_string_lossy()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "docs/guide/intro.md");
        assert_eq!(entries[0].name, "intro.md");
        // full_path 以 root 开头（平台分隔符），前端无需再 join
        assert!(entries[0].full_path.starts_with(&root.to_string_lossy().to_string()));
    }

    #[test]
    fn root_with_trailing_separator() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sub/a.md");
        let with_sep = format!("{}{}", root.to_string_lossy(), std::path::MAIN_SEPARATOR);
        let entries = scan_workspace(&with_sep).unwrap();
        assert_eq!(rels(&entries), vec!["sub/a.md"]);
    }

    #[test]
    fn hidden_root_itself_not_filtered() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".notes");
        fs::create_dir_all(&root).unwrap();
        write(&root, "a.md");
        let entries = scan_workspace(&root.to_string_lossy()).unwrap();
        assert_eq!(rels(&entries), vec!["a.md"]);
    }

    #[test]
    fn missing_root_errors() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(scan_workspace(&missing.to_string_lossy()).is_err());
        // 文件而非目录也报错
        let f = dir.path().join("file.md");
        fs::write(&f, "x").unwrap();
        assert!(scan_workspace(&f.to_string_lossy()).is_err());
    }

    #[test]
    fn empty_workspace_ok() {
        let dir = tempfile::tempdir().unwrap();
        let entries = scan_workspace(&dir.path().to_string_lossy()).unwrap();
        assert!(entries.is_empty());
    }

    // ============ Phase 2:搜索口径 ============

    fn entry(root: &Path, rel: &str, content: &str) -> WorkspaceFileEntry {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        WorkspaceFileEntry {
            full_path: p.to_string_lossy().to_string(),
            name: rel.rsplit('/').next().unwrap().to_string(),
            rel_path: rel.to_string(),
        }
    }

    fn opts(regex: bool, case_sensitive: bool, whole_word: bool) -> SearchOptions {
        SearchOptions { case_sensitive, whole_word, regex }
    }

    fn search(e: &WorkspaceFileEntry, query: &str, o: SearchOptions) -> Vec<SearchHit> {
        let m = build_matcher(query, &o).unwrap();
        search_one_file(e, &m, &AtomicBool::new(false)).hits
    }

    #[test]
    fn multi_match_per_line_ordinal_and_count() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "foo foo");
        let hits = search(&e, "foo", opts(false, false, false));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].match_ordinal, 0);
        assert_eq!(hits[1].match_ordinal, 1);
        assert_eq!(hits[0].file_match_count, 2);
        assert_eq!(hits[1].file_match_count, 2);
        assert_eq!(hits[0].raw_from, 0);
        assert_eq!(hits[1].raw_from, 4);
        assert_eq!(hits[0].match_start_in_line, 0);
        assert_eq!(hits[1].match_start_in_line, 4);
    }

    #[test]
    fn crlf_display_strips_cr_raw_keeps_original() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "one\r\ntwo needle\r\nthree");
        let hits = search(&e, "needle", opts(false, false, false));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_number, 2);
        assert_eq!(hits[0].line_text, "two needle");
        // "one\r\n" = 5 UTF-16 units, "two " = 4 → rawFrom = 9
        assert_eq!(hits[0].raw_from, "one\r\ntwo ".encode_utf16().count());
        assert_eq!(hits[0].match_start_in_line, 4);
    }

    #[test]
    fn chinese_utf16_offsets() {
        let dir = tempfile::tempdir().unwrap();
        // "中文abc中文"：中文 2 字 = 2 UTF-16 units（各 1），abc 3，再中文 2
        let e = entry(dir.path(), "a.md", "中文abc中文");
        let hits = search(&e, "abc", opts(false, false, false));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_start_in_line, 2); // "中文" = 2 units
        assert_eq!(hits[0].match_end_in_line, 5);
        assert_eq!(hits[0].raw_from, 2);
        assert_eq!(hits[0].match_text, "abc");
    }

    #[test]
    fn emoji_astral_utf16_offsets() {
        let dir = tempfile::tempdir().unwrap();
        // emoji 😀 = 2 UTF-16 units（surrogate pair）
        let e = entry(dir.path(), "a.md", "😀abc");
        let hits = search(&e, "abc", opts(false, false, false));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_start_in_line, 2); // 😀 = 2 units
        assert_eq!(hits[0].raw_from, 2);
    }

    #[test]
    fn case_sensitive_flag() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "Hello\nhello");
        assert_eq!(search(&e, "hello", opts(false, false, false)).len(), 2);
        let sensitive = search(&e, "hello", opts(false, true, false));
        assert_eq!(sensitive.len(), 1);
        assert_eq!(sensitive[0].line_text, "hello");
    }

    #[test]
    fn whole_word_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "cat scatter cat");
        let hits = search(&e, "cat", opts(false, false, true));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].match_start_in_line, 0);
        assert_eq!(hits[1].match_start_in_line, 12);
    }

    #[test]
    fn regex_mode_and_invalid_regex() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "id:123 id:abc");
        let hits = search(&e, r"id:\d+", opts(true, false, false));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_text, "id:123");
        // JS 方言（lookahead）Rust 编译失败 → Err，前端降级
        assert!(build_matcher(r"foo(?=bar)", &opts(true, false, false)).is_err());
        assert!(build_matcher("[", &opts(true, false, false)).is_err());
    }

    #[test]
    fn zero_width_matches_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "abc");
        // 纯 anchor 零宽匹配应被跳过（同 JS m[0].length===0 continue）
        let hits = search(&e, r"\b", opts(true, false, false));
        assert_eq!(hits.len(), 0);
    }

    #[test]
    fn literal_mode_escapes_metachars() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "a.b axb");
        // 非 regex 模式：`.` 是字面量，只匹配 "a.b"
        let hits = search(&e, "a.b", opts(false, false, false));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].match_text, "a.b");
    }

    #[test]
    fn no_trailing_newline_last_line() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "line1\nneedle");
        let hits = search(&e, "needle", opts(false, false, false));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_number, 2);
        assert_eq!(hits[0].line_text, "needle");
        assert_eq!(hits[0].raw_from, 6); // "line1\n" = 6 units
    }

    // ============ Phase 2:替换口径 ============

    fn replace(content: &str, query: &str, o: SearchOptions, repl: &str) -> String {
        let body = build_pattern_body(query, &o);
        let re = regex::RegexBuilder::new(&body)
            .case_insensitive(!o.case_sensitive)
            .build()
            .unwrap();
        replace_all(&re, content, repl)
    }

    #[test]
    fn replace_basic_and_count() {
        let dir = tempfile::tempdir().unwrap();
        let e = entry(dir.path(), "a.md", "needle one needle two");
        let content = fs::read_to_string(&e.full_path).unwrap();
        let new = replace(&content, "needle", opts(false, false, false), "knife");
        assert_eq!(new, "knife one knife two");
        let body = build_pattern_body("needle", &opts(false, false, false));
        let re = regex::Regex::new(&body).unwrap();
        assert_eq!(count_matches(&re, &content), 2);
        assert_eq!(count_matches(&re, &new), 0);
    }

    #[test]
    fn replace_capture_groups() {
        let out = replace("id:123 id:456", r"id:(\d+)", opts(true, false, false), "[$1]");
        assert_eq!(out, "[123] [456]");
    }

    #[test]
    fn replace_dollar_normalization() {
        // $0 → 整段匹配；$$ → 字面 $
        assert_eq!(replace("ab", "ab", opts(false, false, false), "$0"), "ab");
        assert_eq!(replace("ab", "ab", opts(false, false, false), "$$"), "$");
        assert_eq!(replace("ab", "ab", opts(false, false, false), "$&"), "ab");
    }

    #[test]
    fn replace_empty_replacement_deletes() {
        assert_eq!(replace("a needle b", "needle ", opts(false, false, false), ""), "a b");
    }

    #[test]
    fn replace_no_match_unchanged() {
        assert_eq!(replace("abc", "xyz", opts(false, false, false), "Q"), "abc");
    }
}

//! PDF 导出 (v0.4.7 后) —— 通过 with_webview 调平台原生 PrintToPDF API。
//!
//! 设计要点:
//! 1. **复用前端 HTML**:前端 `buildExportHtml` 已经把 mermaid/katex/shiki/暗色翻转
//!    全部 inline 渲染好,这里只负责把 HTML 字符串塞进 webview、调平台 API 写盘。
//!    不引入新的 Markdown → HTML 渲染路径。
//! 2. **隐藏的打印专用窗口 (v0.4.8)**:不再 navigate 主 webview —— 主 webview 一旦
//!    被 navigate 到 data: URL,Vue 应用整个被销毁(顶栏消失、文档/光标/undo 全丢),
//!    且只能靠整页重载"恢复",代价不可接受。改为新建一个 `visible(false)` 的隐藏
//!    webview 窗口,把导出 HTML navigate 进它、PrintToPdf,完成后 close 掉。主应用
//!    全程不动,前端 `invoke('export_pdf')` 的 promise 能正常 resolve,从而能弹
//!    "导出成功 / 失败"反馈。
//! 3. **初始 URL = about:blank**:tauri-runtime-wry 的 `create_webview` 对
//!    `"about:blank"` 特判为"不设初始 URL"(`if url != "about:blank" { with_url }`),
//!    所以隐藏窗口创建后没有任何初始 navigation —— 我们再自己 Navigate(asset_url),
//!    NavigationCompleted 只会为这一次 navigation 触发,无"初始页 vs asset URL"竞态。
//! 4. **HTML 走本地临时文件 + asset 协议 (v0.7.16 修复)**:原先走
//!    `Navigate("data:text/html;base64,...")`,但 WebView2/Chromium 对 data: URL 主
//!    文档有 ~2MB 上限(`NavigateToString` 明确 2MB),而导出 HTML 内联了
//!    KaTeX(~340KB b64)+ 8 款内嵌字体(~5MB b64),远超上限 → `Navigate` 返回
//!    `0x80070057`。改为把 HTML 写到 `app_cache_dir/velo-export/<label>.html`,
//!    用 `http://asset.localhost/<percent-encoded-path>` 导航(wry 的 custom protocol
//!    workaround 会拦截该前缀并 revert 回真实路径;asset scope 是 `**`,CSP 已含
//!    `http://asset.localhost`)。
//! 5. **PRINT_LOCK 全局锁**:WebView2 文档明确"PrintToPdf 同时只能一个 in-flight",
//!    用 `tokio::Mutex` 排队防止并发崩溃。
//! 6. **oneshot 桥接**:`with_webview` 是同步闭包,内部平台 API 是异步的(IAsyncOperation
//!    / block callback / gtk signal),用 `tokio::oneshot` 把结果桥接到 async fn。
//! 7. **超时**:30s 兜底,防平台回调不触发时永久挂起。
//!
//! 平台支持状态:
//! - **Windows (WebView2)**:✅ 完整实现 —— `pdf_windows.rs`
//! - **macOS (WKWebView)**:⏳ 待实现 —— 当前返回 `PdfError::Unsupported`
//! - **Linux (WebKitGTK)**:⏳ 待实现 —— 当前返回 `PdfError::Unsupported`

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, Mutex};

/// PDF 导出错误,序列化给前端。
#[derive(Debug, thiserror::Error)]
pub enum PdfError {
    #[error("Webview not ready: {0}")]
    WebviewNotReady(String),

    #[error("PrintToPdf failed: {0}")]
    Platform(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("PDF generation timed out after {0}s")]
    Timeout(u64),

    /// 平台尚未实现 PrintToPDF(v0.4.7 后阶段性只交付 Windows)
    #[error("PDF export is not supported on this platform yet ({0})")]
    #[allow(dead_code)] // 非 Windows 平台使用
    Unsupported(&'static str),
}

/// thiserror 的 Display 输出天然就是 String,直接转发给 serde。
impl serde::Serialize for PdfError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// 全局并发锁:WebView2 要求同时只能有一个 print in-flight,跨 command 共享。
static PRINT_LOCK: Mutex<()> = Mutex::const_new(());

/// 平台 PrintToPDF 注入 HTML + 写盘的超时上限。
const PDF_TIMEOUT: Duration = Duration::from_secs(30);

/// 隐藏打印窗口的 label 自增计数器 —— 每次 export 用一个唯一 label,
/// 万一某次窗口没被 close 掉(异常路径),下一次也不会因 label 冲突建不出来。
static PRINTER_ID: AtomicU64 = AtomicU64::new(0);

/// 把 HTML 字符串导出成 PDF,写到 `output_path`。
///
/// 返回 `Ok(())` 表示 PDF 已成功写到磁盘;返回 `Err(PdfError)` 把错误透传给前端。
/// 实现上新建一个隐藏 webview 窗口承载导出 HTML,主应用 webview 全程不被触碰。
pub async fn export_pdf(
    window: WebviewWindow,
    output_path: String,
    html: String,
) -> Result<(), PdfError> {
    // 全局并发锁,防 WebView2 同时跑两个 print
    let _guard = PRINT_LOCK.lock().await;

    // 新建隐藏打印窗口。`window` 在这里只用来拿 app_handle —— 实际打印
    // 全在这个新窗口里发生,主 webview 不被 navigate。
    let app = window.app_handle();
    let label = format!(
        "velo-pdf-printer-{}",
        PRINTER_ID.fetch_add(1, Ordering::Relaxed)
    );

    // 把导出 HTML 落到本地临时文件,再用 asset 协议导航 —— 取代原先的 data URL。
    // 原因:WebView2/Chromium 对 data: URL 主文档有 ~2MB 上限,而导出 HTML 内联了
    // KaTeX(~340KB b64)+ 8 款内嵌字体(~5MB b64),必然超限,Navigate 直接返回
    // 0x80070057。asset 协议走 wry 的 custom protocol workaround:
    //   `http://asset.localhost/<percent-encoded-abs-path>` →
    //   WebResourceRequested filter 拦截 → revert 回真实路径 → File::open。
    // scope 是 `**`(见 tauri.conf.json assetProtocol.scope),CSP 已含
    // `http://asset.localhost`,配置齐备。
    let html_file = prepare_export_html(app, &label, &html)?;
    let asset_url = match asset_url_for_path(&html_file) {
        Ok(url) => url,
        Err(e) => {
            cleanup_export_html(&html_file);
            return Err(PdfError::Platform(format!("asset url: {e}")));
        }
    };

    let printer = WebviewWindowBuilder::new(
        app,
        label.clone(),
        // about:blank → tauri-runtime-wry 跳过 with_url,窗口无初始 navigation,
        // 我们在 with_webview 里自己 Navigate(asset_url),避免初始页竞态。
        WebviewUrl::CustomProtocol(Url::parse("about:blank").expect("about:blank parses")),
    )
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .inner_size(800.0, 1000.0)
    .build()
    .map_err(|e| {
        cleanup_export_html(&html_file);
        PdfError::Platform(format!("create printer window: {e}"))
    })?;

    let (tx, rx) = oneshot::channel::<Result<(), PdfError>>();

    // with_webview 把闭包投递到 webview 线程;打印结果通过 oneshot 桥回 async 上下文。
    // 投递本身失败(窗口已关等)→ 走错误分支,不 await rx(此时 tx 已随闭包 drop,
    // rx 会拿到 canceled,但我们直接报更准确的 with_webview 错误)。
    // asset_url / output_path 仅在 Windows 闭包分支使用;非 Windows 平台闭包不捕获它们,
    // 需显式引用以抑制 unused_variables 警告(macOS/Linux PDF 导出待实现时会真正使用)。
    #[cfg(not(target_os = "windows"))]
    let _ = (&asset_url, &output_path);
    let result = match printer.with_webview(move |_webview| {
        // 平台分发:每平台各自实现 HTML 注入 + PrintToPDF + oneshot 回传
        #[cfg(target_os = "windows")]
        {
            // PlatformWebview 在 Windows 上暴露 .controller() 和 .environment()
            let controller = _webview.controller();
            let environment = _webview.environment();
            pdf_windows::print(controller, environment, &asset_url, &output_path, tx);
        }

        #[cfg(target_os = "macos")]
        {
            let _ = tx.send(Err(PdfError::Unsupported("macOS")));
        }

        #[cfg(target_os = "linux")]
        {
            let _ = tx.send(Err(PdfError::Unsupported("linux")));
        }

        // 移动端(iOS / Android) —— 不支持桌面端 PDF API
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = tx.send(Err(PdfError::Unsupported("this platform")));
        }
    }) {
        Ok(()) => match tokio::time::timeout(PDF_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_canceled)) => Err(PdfError::WebviewNotReady(
                "platform callback channel closed".into(),
            )),
            Err(_elapsed) => Err(PdfError::Timeout(PDF_TIMEOUT.as_secs())),
        },
        Err(e) => Err(PdfError::Platform(format!("with_webview dispatch: {e}"))),
    };

    // 无论成败都关掉隐藏打印窗口,避免泄漏。close 失败也无能为力,忽略。
    let _ = printer.close();
    // 临时 HTML 已无用,清掉。失败也无害(缓存目录会被系统/应用清理)。
    cleanup_export_html(&html_file);

    result
}

/// 把导出 HTML 写到 `app_cache_dir/velo-export/<label>.html`,返回绝对路径。
///
/// 放 cache 目录而非系统 temp:随应用卸载 / 用户清缓存自然回收,不污染文档目录;
/// asset scope 是 `**`,cache 目录下的文件天然在授权范围内。
/// PDF / 图片导出共用(`image.rs`),错误统一走 `io::Error`,各模块自行转自己的错误类型。
pub(crate) fn prepare_export_html(
    app: &tauri::AppHandle<tauri::Wry>,
    label: &str,
    html: &str,
) -> Result<PathBuf, std::io::Error> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| std::io::Error::other("app_cache_dir unavailable"))?
        .join("velo-export");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{label}.html"));
    std::fs::write(&path, html.as_bytes())?;
    Ok(path)
}

/// 删掉临时导出 HTML。失败静默 —— 缓存目录由系统/应用兜底清理。
pub(crate) fn cleanup_export_html(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// 把绝对路径转成 asset 协议 URL:`http://asset.localhost/<percent-encoded-path>`。
///
/// 与前端 `convertFileSrc` 同构(Windows/Android 用 `{scheme}://{protocol}.localhost/{path}`,
/// macOS/Linux 用 `{protocol}://localhost/{path}`)。wry 的 custom protocol workaround
/// 会在导航时把该 URL 交给注册的 `asset` scheme handler,后者 revert 回真实路径再读盘。
/// PDF / 图片导出共用(`image.rs`)。
pub(crate) fn asset_url_for_path(path: &Path) -> Result<String, String> {
    // 拒绝相对路径 / 含 `..` 的路径 —— 与 tauri asset handler 的 SafePathBuf 校验对齐。
    if !path.is_absolute() {
        return Err("export html path must be absolute".into());
    }
    // percent-encode 整条路径(含盘符冒号),与前端 encodeURIComponent 行为一致。
    let encoded = percent_encode_path(&path.to_string_lossy());
    if cfg!(target_os = "windows") || cfg!(target_os = "android") {
        // http:// 而非 https://:与 wry 的 `use_https_scheme=false` 默认值一致
        // (asset.localhost 走本地回环,不需要 TLS)。
        Ok(format!("http://asset.localhost/{encoded}"))
    } else {
        Ok(format!("asset://localhost/{encoded}"))
    }
}

/// 简易 percent-encoding,只编码"非 unreserved 字符"(保留 A-Za-z0-9 -._~ 与 `/`)。
///
/// 不引入 percent-encoding crate:路径字符集有限,自写一个覆盖 Windows 盘符冒号、
/// 空格、非 ASCII 即可。编码规则与 JS `encodeURIComponent` 对齐(除 `/` 外全编码,
/// 因为 JS 版不编码 `/`;asset handler 侧 percent_decode 后再交给 SafePathBuf)。
fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        let c = byte as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '/') {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(target_os = "windows")]
#[path = "pdf_windows.rs"]
mod pdf_windows;

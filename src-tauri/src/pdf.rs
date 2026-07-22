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
//!    所以隐藏窗口创建后没有任何初始 navigation —— 我们再自己 Navigate(data_url),
//!    NavigationCompleted 只会为这一次 navigation 触发,无"初始页 vs data URL"竞态。
//! 4. **PRINT_LOCK 全局锁**:WebView2 文档明确"PrintToPdf 同时只能一个 in-flight",
//!    用 `tokio::Mutex` 排队防止并发崩溃。
//! 5. **oneshot 桥接**:`with_webview` 是同步闭包,内部平台 API 是异步的(IAsyncOperation
//!    / block callback / gtk signal),用 `tokio::oneshot` 把结果桥接到 async fn。
//! 6. **超时**:30s 兜底,防平台回调不触发时永久挂起。
//!
//! 平台支持状态:
//! - **Windows (WebView2)**:✅ 完整实现 —— `pdf_windows.rs`
//! - **macOS (WKWebView)**:⏳ 待实现 —— 当前返回 `PdfError::Unsupported`
//! - **Linux (WebKitGTK)**:⏳ 待实现 —— 当前返回 `PdfError::Unsupported`

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
    let printer = WebviewWindowBuilder::new(
        app,
        label,
        // about:blank → tauri-runtime-wry 跳过 with_url,窗口无初始 navigation,
        // 我们在 with_webview 里自己 Navigate(data_url),避免初始页竞态。
        WebviewUrl::CustomProtocol(Url::parse("about:blank").expect("about:blank parses")),
    )
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .inner_size(800.0, 1000.0)
    .build()
    .map_err(|e| PdfError::Platform(format!("create printer window: {e}")))?;

    let (tx, rx) = oneshot::channel::<Result<(), PdfError>>();

    // with_webview 把闭包投递到 webview 线程;打印结果通过 oneshot 桥回 async 上下文。
    // 投递本身失败(窗口已关等)→ 走错误分支,不 await rx(此时 tx 已随闭包 drop,
    // rx 会拿到 canceled,但我们直接报更准确的 with_webview 错误)。
    // html / output_path 是函数参数,move 闭包直接捕获;webview 参数在非 Windows
    // 平台不用,加 _ 前缀抑制 unused 警告。
    let result = match printer.with_webview(move |_webview| {
        // 平台分发:每平台各自实现 HTML 注入 + PrintToPDF + oneshot 回传
        #[cfg(target_os = "windows")]
        {
            // PlatformWebview 在 Windows 上暴露 .controller() 和 .environment()
            let controller = _webview.controller();
            let environment = _webview.environment();
            pdf_windows::print(controller, environment, &html, &output_path, tx);
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

    result
}

#[cfg(target_os = "windows")]
#[path = "pdf_windows.rs"]
mod pdf_windows;

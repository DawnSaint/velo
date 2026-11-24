//! 图片导出(PNG / JPEG)—— 通过 with_webview 调 WebView2 CapturePreview。
//!
//! 设计要点:
//! 1. **复用前端 HTML**:与 PDF 导出同一条 `buildExportHtml` 管线,这里只负责
//!    把 HTML 塞进 webview、量出整篇高度、调 CapturePreview 写盘。
//! 2. **离屏可见窗口,而非隐藏窗口**:PrintToPdf 会强制渲染,隐藏窗口也能打印;
//!    但 CapturePreview 抓的是**已渲染的视觉树**,HWND 隐藏时 WebView2 停渲染,
//!    抓出来是空白。所以窗口建在屏幕外(-32000),用 `SW_SHOWNOACTIVATE` 显示
//!    (不抢焦点、skip_taskbar 不进 Alt-Tab),渲染正常进行,用户无感。
//! 3. **整篇长图**:CapturePreview 只抓 controller bounds 区域,不会自动展开
//!    滚动内容。NavigationCompleted 后轮询 `scrollHeight`(等 fonts.ready /
//!    图片 complete),把窗口 + controller bounds 撑到整篇高度再抓。
//! 4. **2× 光栅化(尽力)**:SetRasterizationScale(2.0),CSS 宽固定 880(导出
//!    body 的 max-width)。scale 可能被系统 DPI 覆写,ready 阶段按页面回传的
//!    实际 dpr 自校正物理尺寸(见 image_windows.rs)。整篇物理高度上限 16000
//!    (贴 D3D 纹理 16384 上限),超限报 TooTall 引导改用 PDF。
//! 5. **PNG / JPEG 都是 CapturePreview 原生格式**,不需要额外编解码依赖。
//! 6. HTML 临时文件 / asset 协议 / oneshot 桥接 / 超时兜底均复用 PDF 路径的
//!    设施(`pdf.rs` 的 pub(crate) helper),原因见那边注释(data URL 2MB 上限等)。
//!
//! 平台支持状态:
//! - **Windows (WebView2)**:✅ 完整实现 —— `image_windows.rs`
//! - **macOS / Linux**:⏳ 待实现 —— 当前返回 `ImageError::Unsupported`
//!   (WKWebView / WebKitGTK 的快照 API 与窗口高度撑开策略需另行适配)

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, Mutex};

use crate::pdf::{asset_url_for_path, cleanup_export_html, prepare_export_html};

/// 输出格式 —— CapturePreview 原生支持两种,无需额外编解码依赖。
#[derive(Clone, Copy)]
pub enum ImageFormat {
    Png,
    Jpeg,
}

/// 图片导出错误,序列化给前端。
#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("Webview not ready: {0}")]
    WebviewNotReady(String),

    #[error("CapturePreview failed: {0}")]
    Platform(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Image export timed out after {0}s")]
    Timeout(u64),

    /// 整篇物理高度超过单张纹理上限(D3D 16384 物理像素留余量到 16000)。
    /// CSS 上限随显示器 dpr 浮动,见 image_windows.rs。
    #[error("Document too tall for image export ({0}px, exceeds the single-image texture limit); use PDF export instead")]
    TooTall(u32),

    /// 平台尚未实现(阶段性只交付 Windows,同 PDF)
    #[error("Image export is not supported on this platform yet ({0})")]
    #[allow(dead_code)] // 非 Windows 平台使用
    Unsupported(&'static str),
}

impl serde::Serialize for ImageError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// 全局并发锁:与 PDF 的 PRINT_LOCK 分开,但同语义 —— 排队防止并发截图窗口互相干扰。
static CAPTURE_LOCK: Mutex<()> = Mutex::const_new(());

/// 截图超时上限(含字体加载 / 高度轮询 / CapturePreview)。
const IMAGE_TIMEOUT: Duration = Duration::from_secs(30);

/// 离屏截图窗口 label 自增计数器,同 PDF PRINTER_ID 的防冲突理由。
static CAPTURE_ID: AtomicU64 = AtomicU64::new(0);

/// 把 HTML 字符串导出成 PNG / JPEG 长图,写到 `output_path`。
///
/// `format` 取 "png" / "jpeg"(前端按 saveDialog 选中的扩展名传入)。
pub async fn export_image(
    window: WebviewWindow,
    output_path: String,
    html: String,
    format: String,
) -> Result<(), ImageError> {
    let image_format = match format.as_str() {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        other => {
            return Err(ImageError::Platform(format!(
                "unknown image format: {other}"
            )))
        }
    };

    let _guard = CAPTURE_LOCK.lock().await;

    let app = window.app_handle();
    let label = format!(
        "velo-image-capture-{}",
        CAPTURE_ID.fetch_add(1, Ordering::Relaxed)
    );

    // HTML 落临时文件 + asset 协议导航,同 PDF(见 pdf.rs 注释:data URL 2MB 上限)。
    let html_file = prepare_export_html(app, &label, &html)?;
    let asset_url = match asset_url_for_path(&html_file) {
        Ok(url) => url,
        Err(e) => {
            cleanup_export_html(&html_file);
            return Err(ImageError::Platform(format!("asset url: {e}")));
        }
    };

    // 关键区别于 PDF:**不能 visible(false) 一路到底** —— CapturePreview 抓的是
    // 渲染结果,隐藏 HWND 不渲染。这里先按隐藏建窗(避免创建瞬间闪现),
    // with_webview 里拿到 HWND 后 SW_SHOWNOACTIVATE 离屏显示。
    // decorations(false):SetWindowPos 的尺寸 == 客户区尺寸,撑高度时不受边框干扰。
    let capture = WebviewWindowBuilder::new(
        app,
        label.clone(),
        WebviewUrl::CustomProtocol(Url::parse("about:blank").expect("about:blank parses")),
    )
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .decorations(false)
    .position(-32000.0, -32000.0)
    .inner_size(880.0, 1000.0)
    .build()
    .map_err(|e| {
        cleanup_export_html(&html_file);
        ImageError::Platform(format!("create capture window: {e}"))
    })?;

    let (tx, rx) = oneshot::channel::<Result<(), ImageError>>();

    #[cfg(not(target_os = "windows"))]
    let _ = (&asset_url, &output_path, &image_format);
    let result = match capture.with_webview(move |_webview| {
        #[cfg(target_os = "windows")]
        {
            let controller = _webview.controller();
            image_windows::capture(controller, &asset_url, &output_path, image_format, tx);
        }

        #[cfg(target_os = "macos")]
        {
            let _ = tx.send(Err(ImageError::Unsupported("macOS")));
        }

        #[cfg(target_os = "linux")]
        {
            let _ = tx.send(Err(ImageError::Unsupported("linux")));
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = tx.send(Err(ImageError::Unsupported("this platform")));
        }
    }) {
        Ok(()) => match tokio::time::timeout(IMAGE_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_canceled)) => Err(ImageError::WebviewNotReady(
                "platform callback channel closed".into(),
            )),
            Err(_elapsed) => Err(ImageError::Timeout(IMAGE_TIMEOUT.as_secs())),
        },
        Err(e) => Err(ImageError::Platform(format!("with_webview dispatch: {e}"))),
    };

    let _ = capture.close();
    cleanup_export_html(&html_file);

    result
}

#[cfg(target_os = "windows")]
#[path = "image_windows.rs"]
mod image_windows;
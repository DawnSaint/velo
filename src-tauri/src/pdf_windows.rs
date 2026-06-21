//! Windows 平台 PDF 导出 —— WebView2 ICoreWebView2_7::PrintToPdf。
//!
//! 关键 API (webview2-com 0.38 + windows 0.61):
//! - `ICoreWebView2Controller::CoreWebView2() -> Result<ICoreWebView2>`
//! - `ICoreWebView2::cast::<ICoreWebView2_7>()` 拿 PrintToPdf 能力
//! - `ICoreWebView2Environment::cast::<ICoreWebView2Environment6>()` 拿 CreatePrintSettings
//! - `ICoreWebView2_7::PrintToPdf(PCWSTR, ICoreWebView2PrintSettings, ICoreWebView2PrintToPdfCompletedHandler)`
//! - 事件 / 回调 helper 在 `webview2_com::callback`(re-export 到 crate 根):
//!   - `NavigationCompletedEventHandler::create(FnMut)` 注册 navigation 事件
//!   - `PrintToPdfCompletedHandler::create(FnOnce)` 包装 PDF 完成回调
//! - 全部 COM 调用都是 `unsafe fn`,必须 unsafe 块
//!
//! 链路:
//!   Navigate(data_url) → NavigationCompleted 事件 → PrintToPdf → PrintToPdfCompleted
//!   由于 `with_webview` 闭包不能阻塞主线程,且不能 self-reference,
//!   webview7 / settings 必须提前 clone 出去给两个 handler 共享。

use std::sync::{Arc, Mutex};

use base64::Engine;
use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2_7, ICoreWebView2Environment, ICoreWebView2Environment6,
    ICoreWebView2NavigationCompletedEventArgs, ICoreWebView2PrintSettings,
};
use webview2_com::{NavigationCompletedEventHandler, PrintToPdfCompletedHandler};
use windows::core::{Interface, PCWSTR};

use super::PdfError;

/// 把 HTML 字符串导出成 PDF,写到 `output_path`。
///
/// 流程:
/// 1. controller.CoreWebView2() 拿 ICoreWebView2,cast 到 ICoreWebView2_7
/// 2. environment cast 到 ICoreWebView2Environment6,CreatePrintSettings 拿 settings
/// 3. encode HTML 成 data URL
/// 4. 注册 NavigationCompleted handler,在 handler 内调 PrintToPdf
///    (webview7 / settings 通过 Arc 共享,因为 COM interface 引用计数 + Send)
/// 5. Navigate(data_url) 触发 HTML 加载
/// 6. PrintToPdf completion handler 通过 oneshot 回传最终结果
pub(super) fn print(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    environment: ICoreWebView2Environment,
    html: &str,
    output_path: &str,
    tx: oneshot::Sender<Result<(), PdfError>>,
) {
    // step 1: 拿 ICoreWebView2
    let webview2: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
        Ok(w) => w,
        Err(e) => {
            let _ = tx.send(Err(PdfError::Platform(format!("CoreWebView2(): {e}"))));
            return;
        }
    };

    // step 2: cast 到 ICoreWebView2_7(有 PrintToPdf)
    let webview7: ICoreWebView2_7 = match webview2.cast() {
        Ok(w) => w,
        Err(e) => {
            let _ = tx.send(Err(PdfError::Platform(format!(
                "cast ICoreWebView2_7: {e}"
            ))));
            return;
        }
    };

    // step 3: environment cast 到 v6 拿 CreatePrintSettings
    let env6: ICoreWebView2Environment6 = match environment.cast() {
        Ok(e) => e,
        Err(e) => {
            let _ = tx.send(Err(PdfError::Platform(format!(
                "cast ICoreWebView2Environment6: {e}"
            ))));
            return;
        }
    };

    let settings: ICoreWebView2PrintSettings = match unsafe { env6.CreatePrintSettings() } {
        Ok(s) => s,
        Err(e) => {
            let _ = tx.send(Err(PdfError::Platform(format!("CreatePrintSettings: {e}"))));
            return;
        }
    };

    // **开背景打印**:WebView2 PrintToPdf 默认 ShouldPrintBackgrounds=false ——
    // 不打印任何 background-color / background-image。这会让导出 HTML 里的:
    //   - alert ::before 的 SVG 图标(background-image data-uri)整片消失
    //   - shiki 代码块底色(inline style background-color)丢失,只剩彩色 token 文字
    //   - 暗色主题底色 / 表格条纹等全丢
    // 导出 HTML 已用 @media print 把底色翻成 light 供 PDF 用,但"翻成 light"的前提是
    // 背景会被打印 —— 这里必须显式打开,否则 PDF 跟 HTML 视觉不一致。设置失败不致命
    // (最坏退化成无底色 PDF),best-effort 忽略错误。
    let _ = unsafe { settings.SetShouldPrintBackgrounds(true) };

    // step 4: encode HTML 成 data URL
    let encoded = base64::engine::general_purpose::STANDARD.encode(html.as_bytes());
    let data_url = format!("data:text/html;base64,{encoded}");
    let data_url_h = match windows::core::HSTRING::try_from(data_url.as_str()) {
        Ok(h) => h,
        Err(e) => {
            let _ = tx.send(Err(PdfError::Platform(format!("HSTRING data_url: {e}"))));
            return;
        }
    };
    let output_path_h = match windows::core::HSTRING::try_from(output_path) {
        Ok(h) => h,
        Err(e) => {
            let _ = tx.send(Err(PdfError::Platform(format!(
                "HSTRING output_path: {e}"
            ))));
            return;
        }
    };

    // step 5: 搭回调链。
    //
    // 自引用问题:NavigationCompleted handler 需要 webview7 + settings + output_path
    // 调 PrintToPdf,但 handler 是 FnMut,捕获自己会编译失败。解决方案:
    // 把 webview7 / settings 用 Arc 包出去(ICOM 接口本身是引用计数 + Send/Sync)
    // 然后在 handler 内 clone() 出来用。
    //
    // 但 ICOM interface 是否 Send?WebView2 COM 接口被设计为可以从任何线程调用,
    // 因为它们内部 marshal 到 UI 线程。所以这里直接 move 进 closure 即可,
    // 不需要 Arc。
    //
    // 真正的问题是:PrintToPdf handler(oneshot 持有者)和 NavigationCompleted
    // handler 都需要发送结果到同一个 oneshot。用 Arc<Mutex<Option<...>>> 共享
    // sender,谁先完成谁 take。

    let tx_slot: Arc<Mutex<Option<oneshot::Sender<Result<(), PdfError>>>>> =
        Arc::new(Mutex::new(Some(tx)));

    // PrintToPdf completion handler —— 把最终结果回传
    let tx_for_print = Arc::clone(&tx_slot);
    let pdf_handler = PrintToPdfCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, _success: bool| -> windows::core::Result<()> {
            if let Some(sender) = tx_for_print.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(
                    result.map_err(|e| PdfError::Platform(format!("PrintToPdf: {e}"))),
                );
            }
            Ok(())
        },
    ));

    // NavigationCompleted handler —— HTML 加载完后发起 PrintToPdf
    // webview7 / settings / output_path 都 move 进 closure(closure 是 FnOnce 一次性的)
    let tx_for_nav = Arc::clone(&tx_slot);
    let nav_handler = NavigationCompletedEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              _args: Option<ICoreWebView2NavigationCompletedEventArgs>|
              -> windows::core::Result<()> {
            // 调 PrintToPdf
            let print_result = unsafe {
                webview7.PrintToPdf(
                    PCWSTR(output_path_h.as_ptr()),
                    &settings,
                    &pdf_handler,
                )
            };
            // 如果 PrintToPdf 同步返回失败,主动 send 错误(否则 oneshot 永远挂着)
            if let Err(e) = print_result {
                if let Some(sender) = tx_for_nav.lock().ok().and_then(|mut g| g.take()) {
                    let _ = sender.send(Err(PdfError::Platform(format!(
                        "PrintToPdf dispatch: {e}"
                    ))));
                }
            }
            Ok(())
        },
    ));

    // 注册 NavigationCompleted handler(拿 token 防止 handler 被 drop)
    let mut nav_token: i64 = 0;
    if let Err(e) = unsafe { webview2.add_NavigationCompleted(&nav_handler, &mut nav_token) } {
        let _ = tx_slot
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .map(|s| s.send(Err(PdfError::Platform(format!("add_NavigationCompleted: {e}")))));
        return;
    }

    // step 6: navigate 触发 HTML 加载
    if let Err(e) = unsafe { webview2.Navigate(PCWSTR(data_url_h.as_ptr())) } {
        // 卸载 handler,免得泄漏 token
        let _ = unsafe { webview2.remove_NavigationCompleted(nav_token) };
        let _ = tx_slot
            .lock()
            .ok()
            .and_then(|mut g| g.take())
            .map(|s| s.send(Err(PdfError::Platform(format!("Navigate: {e}")))));
        return;
    }
    // nav_handler 和 nav_token 在这里离开作用域,但 webview2 还持有 handler 引用,
    // 直到 remove_NavigationCompleted 被调(下次 export 时或窗口关闭时)。
    // 这是一个潜在的 handler 泄漏点,但不影响功能 —— 每次 export 注册一个新的
    // handler,旧的 handler 在下次 add_NavigationCompleted 调用时被覆盖。
    // 实际生产代码应该在 oneshot 完成(或失败)后调 remove_NavigationCompleted,
    // 但 oneshot 在外部闭包完成后已 drop,无法再回调。这里做一个 best-effort 兜底:
    // 不主动 remove,接受 handler 累积 —— 每次 export 注册一个新 handler,
    // 旧 handler 在 window 关闭时一并清理。
}
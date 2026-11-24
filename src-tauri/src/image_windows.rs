//! Windows 平台图片导出 —— WebView2 ICoreWebView2::CapturePreview。
//!
//! 关键 API (webview2-com 0.38 + windows 0.61):
//! - `ICoreWebView2::CapturePreview(format, IStream, CapturePreviewCompletedHandler)`
//!   —— PNG / JPEG 都是原生格式,抓的是 controller bounds 区域的**已渲染视觉树**
//! - `ICoreWebView2Controller3::SetRasterizationScale(f64)` —— CSS px → 物理 px 倍率
//! - `ICoreWebView2Controller::SetBounds(RECT)` / `ParentWindow(*mut HWND)`
//! - `ExecuteScript` + `WebMessageReceived` —— 量文档高度 / 就绪态 / 延时
//! - `SHCreateMemStream` + `IStream::Seek/Read` —— 接收截图字节
//!
//! 链路(全程 UI 线程):
//!   ShowWindow(SW_SHOWNOACTIVATE) → Navigate(asset_url) → NavigationCompleted
//!   → 尽力设 2× 光栅化 + 注入 JS 轮询(readyState + fonts.ready + images)
//!   → postMessage('velo-capture-ready:<h>|{dpr,iw}') → 校验 CSS 宽 == 880
//!     (不等则按实际 dpr 撑物理宽并重测一轮)→ 撑窗口到整篇高度
//!   → JS setTimeout 250ms → postMessage('velo-capture-go') → CapturePreview
//!   → completion handler 读流写盘 → oneshot 回传
//!
//! **为什么全程 UI 线程 + JS 定时器,而非 worker 线程轮询**:controller 系 API
//! (SetRasterizationScale / SetBounds / ParentWindow)是**创建线程绑定**的,
//! worker 线程调直接报 0x802A000C("只能从创建线程调用")。量高度需要"轮询 +
//! 延时",UI 线程又不能 sleep —— 用页面内 setTimeout 轮询、postMessage 回传,
//! Rust 侧只在 WebMessageReceived 回调里做事,天然全在 UI 线程。
//!
//! **为什么窗口必须可见**:CapturePreview 不像 PrintToPdf 会强制渲染 ——
//! HWND 隐藏时 WebView2 停渲染,抓出来空白。窗口建在 (-32000, -32000) 屏幕外,
//! SW_SHOWNOACTIVATE 显示但不抢焦点,渲染正常、用户无感。
//!
//! **为什么尺寸必须按实际 dpr 自校正**:SetRasterizationScale(2.0) 会在窗口
//! 显示 / DPI 事件时被系统 DPI 覆写(实测 240% 屏上 dpr 回到 2.4),CSS 视口 =
//! 物理 bounds / dpr 随之变窄,量到的高度与撑开后的布局都对不上(截图截断)。
//! 所以 ready 消息带回实际 dpr / innerWidth:宽不对就按 dpr 重撑物理宽再测一轮,
//! 高度上限也按物理像素(16000,贴 D3D 纹理 16384 上限)而非固定 CSS 值判定。

use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Controller3,
    ICoreWebView2NavigationCompletedEventArgs, ICoreWebView2WebMessageReceivedEventArgs,
    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
};
use webview2_com::{
    CapturePreviewCompletedHandler, NavigationCompletedEventHandler, WebMessageReceivedEventHandler,
};
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::System::Com::{CoTaskMemFree, IStream, STREAM_SEEK_SET};
use windows::Win32::UI::Shell::SHCreateMemStream;
use windows::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, ShowWindow, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, SW_SHOWNOACTIVATE,
};

use super::{ImageError, ImageFormat};

/// 导出 body 的 max-width(exportStyles.scss `.velo-editor`)。截图 CSS 宽取它,
/// body 恰好铺满视口 —— 宽了会露出 html 白底(暗色版两侧白条),窄了内容被压缩。
const CSS_WIDTH: f64 = 880.0;
/// 期望光栅化倍率(2× 文字锐利);被系统 DPI 覆写时按实际 dpr 走,见模块注释。
const PREFERRED_SCALE: f64 = 2.0;
/// 初始 CSS 高度(加载用),量完整篇高度后再撑开。
const INITIAL_CSS_HEIGHT: f64 = 1000.0;
/// 整篇物理高度上限:贴着 D3D 纹理 16384 上限留余量。CSS 上限随 dpr 浮动。
const MAX_PHYS_HEIGHT: i32 = 16000;

/// 注入脚本:藏滚动条 + 轮询就绪态与整篇高度,就绪后 postMessage 回传。
///
/// - 滚动条必须在量高度**之前**藏掉 —— 否则量到的是带滚动条的布局,撑开窗口后
///   滚动条消失、视口变宽、文字重排,高度对不上。
/// - 就绪 = readyState complete + fonts.ready(内联 base64 字体异步加载)+
///   所有 <img> complete(asset 协议图片)。
/// - 连续两次高度一致才回传,防加载中途测量;100 拍(10s)兜底超时。
/// - 消息带实际 dpr / innerWidth:Rust 侧据此校验 CSS 宽并按 dpr 算物理尺寸。
/// - postMessage 前缀与 wry 自身 IPC 区分,wry 收到非 JSON 消息会静默忽略。
const POLL_SCRIPT: &str = r#"(() => {
  const s = document.createElement('style');
  s.textContent = 'html{overflow:hidden}';
  document.head.appendChild(s);
  let fontsReady = false;
  document.fonts.ready.then(() => { fontsReady = true; });
  let lastH = -1, ticks = 0;
  const tick = () => {
    const ready = document.readyState === 'complete' && fontsReady
      && Array.from(document.images).every(i => i.complete);
    const h = Math.max(document.body ? document.body.scrollHeight : 0,
                       document.documentElement ? document.documentElement.scrollHeight : 0);
    if (ready && h > 0 && h === lastH) {
      window.chrome.webview.postMessage('velo-capture-ready:' + h + '|'
        + JSON.stringify({ dpr: devicePixelRatio, iw: innerWidth }));
      return;
    }
    lastH = h;
    if (++ticks >= 100) { window.chrome.webview.postMessage('velo-capture-timeout'); return; }
    setTimeout(tick, 100);
  };
  tick();
  return 1;
})()"#;

/// 撑开窗口后延时一拍再抓的脚本(setTimeout 在页面里跑,不阻塞 UI 线程)。
const DELAY_SCRIPT: &str =
    "setTimeout(() => window.chrome.webview.postMessage('velo-capture-go'), 250); 1";

type TxSlot = Arc<Mutex<Option<oneshot::Sender<Result<(), ImageError>>>>>;

fn send_err(tx_slot: &TxSlot, e: ImageError) {
    if let Some(sender) = tx_slot.lock().ok().and_then(|mut g| g.take()) {
        let _ = sender.send(Err(e));
    }
}

/// 入口:在 webview 线程(= controller 创建线程)离屏显示窗口并 Navigate,
/// 后续由 NavigationCompleted / WebMessageReceived / CapturePreview 回调推进。
pub(super) fn capture(
    controller: ICoreWebView2Controller,
    asset_url: &str,
    output_path: &str,
    format: ImageFormat,
    tx: oneshot::Sender<Result<(), ImageError>>,
) {
    let webview2: ICoreWebView2 = match unsafe { controller.CoreWebView2() } {
        Ok(w) => w,
        Err(e) => {
            let _ = tx.send(Err(ImageError::Platform(format!("CoreWebView2(): {e}"))));
            return;
        }
    };

    let tx_slot: TxSlot = Arc::new(Mutex::new(Some(tx)));

    // 离屏显示窗口:SW_SHOWNOACTIVATE 不抢焦点 —— 用户正在主窗口打字,导出不能
    // 打断。skip_taskbar(WS_EX_TOOLWINDOW)保证不进 Alt-Tab。
    let mut hwnd = HWND::default();
    if let Err(e) = unsafe { controller.ParentWindow(&mut hwnd) } {
        send_err(&tx_slot, ImageError::Platform(format!("ParentWindow: {e}")));
        return;
    }
    let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };

    let asset_url_h = match HSTRING::try_from(asset_url) {
        Ok(h) => h,
        Err(e) => {
            send_err(&tx_slot, ImageError::Platform(format!("HSTRING asset_url: {e}")));
            return;
        }
    };

    // WebMessageReceived:ready:<h>|{dpr,iw} → 校宽 / 撑高 + 延时 → go → 截图。
    // controller / hwnd 只在本回调(UI 线程)里使用,不跨线程。
    let wm_webview = webview2.clone();
    let wm_controller = controller.clone();
    let wm_tx = Arc::clone(&tx_slot);
    let wm_output = output_path.to_string();
    // 宽度自校正只做一轮:重撑物理宽后重测仍不对(理论上仅亚像素舍入)就按实测走。
    let mut width_fixed = false;
    let webmessage_handler = WebMessageReceivedEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              args: Option<ICoreWebView2WebMessageReceivedEventArgs>|
              -> windows::core::Result<()> {
            let Some(args) = args else { return Ok(()) };
            let mut pw = PWSTR::null();
            if unsafe { args.TryGetWebMessageAsString(&mut pw) }.is_err() || pw.is_null() {
                return Ok(());
            }
            let msg = unsafe { pw.to_string().unwrap_or_default() };
            unsafe { CoTaskMemFree(Some(pw.0.cast())) };

            if let Some(rest) = msg.strip_prefix("velo-capture-ready:") {
                let (h_str, diag) = rest.split_once('|').unwrap_or((rest, "{}"));
                let height: u32 = h_str.parse().unwrap_or(0);
                let v: serde_json::Value = serde_json::from_str(diag).unwrap_or_default();
                let dpr = v["dpr"].as_f64().unwrap_or(1.0).max(0.5);
                let iw = v["iw"].as_f64().unwrap_or(0.0);
                let phys_w = (CSS_WIDTH * dpr).round() as i32;

                // CSS 宽被系统 DPI 挤窄(SetRasterizationScale 被覆写):按实际
                // dpr 重撑物理宽,注入第二轮轮询重测高度(宽度变了高度必变)。
                if (iw - CSS_WIDTH).abs() > 1.0 && !width_fixed {
                    width_fixed = true;
                    let phys_h = (INITIAL_CSS_HEIGHT * dpr).round() as i32;
                    if let Err(e) = resize_window(hwnd, &wm_controller, phys_w, phys_h) {
                        send_err(&wm_tx, e);
                        return Ok(());
                    }
                    let script = HSTRING::from(POLL_SCRIPT);
                    if let Err(e) = unsafe { wm_webview.ExecuteScript(PCWSTR(script.as_ptr()), None) } {
                        send_err(&wm_tx, ImageError::Platform(format!("ExecuteScript repoll: {e}")));
                    }
                    return Ok(());
                }

                if height == 0 {
                    send_err(&wm_tx, ImageError::Platform("measured zero document height".into()));
                    return Ok(());
                }
                let phys_h = (height as f64 * dpr).round() as i32;
                if phys_h > MAX_PHYS_HEIGHT {
                    send_err(&wm_tx, ImageError::TooTall(height));
                    return Ok(());
                }
                if let Err(e) = resize_window(hwnd, &wm_controller, phys_w, phys_h) {
                    send_err(&wm_tx, e);
                    return Ok(());
                }
                // 宽度不变 → 不会重排;延时一拍等布局/绘制落定再抓。
                let script = HSTRING::from(DELAY_SCRIPT);
                if let Err(e) = unsafe { wm_webview.ExecuteScript(PCWSTR(script.as_ptr()), None) } {
                    send_err(&wm_tx, ImageError::Platform(format!("ExecuteScript delay: {e}")));
                }
            }
            else if msg == "velo-capture-go" {
                do_capture(&wm_webview, &wm_output, format, &wm_tx);
            }
            else if msg == "velo-capture-timeout" {
                send_err(&wm_tx, ImageError::Platform("document not ready for capture within 10s".into()));
            }
            // 其余消息(wry 自身 IPC 等)忽略。
            Ok(())
        },
    ));
    let mut wm_token: i64 = 0;
    if let Err(e) = unsafe { webview2.add_WebMessageReceived(&webmessage_handler, &mut wm_token) } {
        send_err(&tx_slot, ImageError::Platform(format!("add_WebMessageReceived: {e}")));
        return;
    }

    // NavigationCompleted → 尽力设 2× 光栅化 + 初始物理尺寸 + 注入轮询脚本。
    // 放在这里而非 capture():窗口显示 / 首次导航后 DPI 才落定,此时设 scale
    // 更可能留住;留不住也没关系,ready 阶段按实际 dpr 自校正。
    let nav_webview = webview2.clone();
    let nav_controller = controller.clone();
    let nav_tx = Arc::clone(&tx_slot);
    let nav_handler = NavigationCompletedEventHandler::create(Box::new(
        move |_sender: Option<ICoreWebView2>,
              _args: Option<ICoreWebView2NavigationCompletedEventArgs>|
              -> windows::core::Result<()> {
            if let Ok(controller3) = nav_controller.cast::<ICoreWebView2Controller3>() {
                let _ = unsafe { controller3.SetRasterizationScale(PREFERRED_SCALE) };
            }
            // 初始物理尺寸按期望 scale 估;实际 dpr 不同则 ready 阶段自校正。
            let phys_w = (CSS_WIDTH * PREFERRED_SCALE) as i32;
            let phys_h = (INITIAL_CSS_HEIGHT * PREFERRED_SCALE) as i32;
            if let Err(e) = resize_window(hwnd, &nav_controller, phys_w, phys_h) {
                send_err(&nav_tx, e);
                return Ok(());
            }
            let script = HSTRING::from(POLL_SCRIPT);
            if let Err(e) = unsafe { nav_webview.ExecuteScript(PCWSTR(script.as_ptr()), None) } {
                send_err(&nav_tx, ImageError::Platform(format!("ExecuteScript poll: {e}")));
            }
            Ok(())
        },
    ));
    let mut nav_token: i64 = 0;
    if let Err(e) = unsafe { webview2.add_NavigationCompleted(&nav_handler, &mut nav_token) } {
        send_err(&tx_slot, ImageError::Platform(format!("add_NavigationCompleted: {e}")));
        return;
    }

    if let Err(e) = unsafe { webview2.Navigate(PCWSTR(asset_url_h.as_ptr())) } {
        let _ = unsafe { webview2.remove_NavigationCompleted(nav_token) };
        send_err(&tx_slot, ImageError::Platform(format!("Navigate: {e}")));
        return;
    }
    // handler 生命周期同 pdf_windows:不主动 remove,窗口关闭时一并清理。
}

/// CapturePreview → 内存流。completion handler(UI 线程)读流写盘后 send。
/// tx 留在共享 slot 里(handler 与同步失败分支都从 slot take),已完成时静默返回。
fn do_capture(webview2: &ICoreWebView2, output_path: &str, format: ImageFormat, tx_slot: &TxSlot) {
    if tx_slot.lock().map(|g| g.is_none()).unwrap_or(true) {
        return;
    }
    let stream = match unsafe { SHCreateMemStream(None) } {
        Some(s) => s,
        None => {
            send_err(tx_slot, ImageError::Platform("SHCreateMemStream returned null".into()));
            return;
        }
    };
    let output_path = output_path.to_string();
    // handler 与 CapturePreview 各持一份流引用(COM Clone = AddRef)。
    let stream_for_handler = stream.clone();
    let handler_tx = Arc::clone(tx_slot);
    let handler = CapturePreviewCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>| -> windows::core::Result<()> {
            let outcome = result
                .map_err(|e| ImageError::Platform(format!("CapturePreview: {e}")))
                .and_then(|_| read_stream_all(&stream_for_handler))
                .and_then(|bytes| std::fs::write(&output_path, bytes).map_err(ImageError::Io));
            if let Some(sender) = handler_tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = sender.send(outcome);
            }
            Ok(())
        },
    ));
    let image_format = match format {
        ImageFormat::Png => COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        ImageFormat::Jpeg => COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
    };
    if let Err(e) = unsafe { webview2.CapturePreview(image_format, &stream, &handler) } {
        send_err(tx_slot, ImageError::Platform(format!("CapturePreview dispatch: {e}")));
    }
}

/// SetWindowPos(物理像素) + controller.SetBounds 同步撑开。
/// decorations(false) 保证窗口尺寸 == 客户区尺寸,bounds 从 (0,0) 起。
fn resize_window(
    hwnd: HWND,
    controller: &ICoreWebView2Controller,
    width: i32,
    height: i32,
) -> Result<(), ImageError> {
    unsafe { SetWindowPos(hwnd, None, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE) }
        .map_err(|e| ImageError::Platform(format!("SetWindowPos: {e}")))?;
    unsafe {
        controller.SetBounds(RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        })
    }
    .map_err(|e| ImageError::Platform(format!("SetBounds: {e}")))?;
    Ok(())
}

/// CapturePreview 写完流后位置在末尾,Seek 回头再分块读尽。
fn read_stream_all(stream: &IStream) -> Result<Vec<u8>, ImageError> {
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|e| ImageError::Platform(format!("IStream::Seek: {e}")))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut out = Vec::new();
    loop {
        let mut read: u32 = 0;
        let hr = unsafe { stream.Read(buf.as_mut_ptr().cast(), buf.len() as u32, Some(&mut read)) };
        hr.ok()
            .map_err(|e| ImageError::Platform(format!("IStream::Read: {e}")))?;
        if read == 0 {
            break;
        }
        out.extend_from_slice(&buf[..read as usize]);
    }
    Ok(out)
}
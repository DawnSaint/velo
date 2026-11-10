import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { tauriOnly } from './fs'

export interface CliArgsPayload {
  files: string[]
  dirs: string[]
}

function normalizePayload(payload?: Partial<CliArgsPayload>): CliArgsPayload {
  return {
    files: payload?.files ?? [],
    dirs: payload?.dirs ?? [],
  }
}

export function getCurrentWindowLabel(): string {
  return getCurrentWindow().label
}

export async function takeWindowCliArgs(label: string): Promise<CliArgsPayload> {
  return await invoke<CliArgsPayload>('take_window_cli_args', { label })
}

export async function newAppWindow(payload?: Partial<CliArgsPayload>): Promise<string> {
  return await invoke<string>('new_app_window', { payload: normalizePayload(payload) })
}

/** 首帧渲染完成后把当前窗口显示出来。Rust 侧所有窗口都以 visible(false)
 *  创建，避免 WebView2 导航期的默认白底闪一帧；Rust 另有 3s 兜底，
 *  前端异常 / JS 加载失败也不会让窗口永久隐藏。
 *  非 Tauri（浏览器 dev）环境静默跳过。 */
export async function showMainWindow(): Promise<void> {
  if (!tauriOnly()) return
  try {
    await invoke<void>('show_main_window')
  }
  catch (e) {
    // 不抛给调用方：Rust 的兜底线程会补一次 show，启动不该被这个失败打断。
    console.warn('[window] show_main_window 调用失败，等待 Rust 兜底', e)
  }
}

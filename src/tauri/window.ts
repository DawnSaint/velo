import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

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

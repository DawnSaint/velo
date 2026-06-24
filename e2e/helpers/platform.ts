// 平台守门。Velo E2E 走 tauri-driver + msedgedriver,只能在 Windows 跑。
// 非 Windows 退码 0,避免误伤跨平台开发者的 git hook / 本地脚本。

export function assertWindows(): void {
  if (process.platform !== 'win32') {
    console.error('[velo-e2e] Velo E2E is Windows-only (tauri-driver + msedgedriver / WebView2).')
    process.exit(0)
  }
}

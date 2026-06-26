export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
    return true
  }
  catch {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return true
      }
    }
    catch { /* swallow */ }
  }
  return false
}

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

/** 把磁盘图片文件写入系统剪贴板(仅 Tauri)。
 *  writeImage 直接传 raw bytes 会被 Rust 当作 RGBA 像素数据,报
 *  "expected RGBA image data, found raw bytes"。需先用 canvas 解码为 RGBA
 *  像素,再构造 Tauri Image 对象。失败 throw,调用方决定反馈策略。 */
export async function writeClipboardImage(absPath: string): Promise<void> {
  const { readFile } = await import('@/tauri/fs')
  const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager')
  const { Image: TauriImage } = await import('@tauri-apps/api/image')
  const bytes = await readFile(absPath)
  const blob = new Blob([bytes])
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(bitmap, 0, 0)
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  bitmap.close()
  const img = await TauriImage.new(
    new Uint8Array(imageData.data.buffer),
    canvas.width,
    canvas.height,
  )
  await writeImage(img)
}

// 错误形态统一 → 字符串。Tauri / ProseMirror / 浏览器 API 抛出的错误不一致
// (Error / string / 未知对象),统一抽成字符串塞进 message 弹窗 / 日志。
//
// 原 stores/document.ts 与 stores/export.ts 各有一份同构实现,抽到 utils 复用。
export function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

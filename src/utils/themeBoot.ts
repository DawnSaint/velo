// 首屏主题定色：**异步读盘之前**就能确定深浅色，避免 hydrate 时整页翻面。
//
// 磁盘上的 velo-settings.json 是权威数据源，localStorage 只是一份轻量镜像：
// 让 index.html 里的 public/theme-boot.js（同步、早于所有外部 CSS）和 Vue store
// 在创建的第一刻就拿到上次保存的 themeMode，从而与异步 hydrate 后的最终值一致。
//
// ⚠️ 改动这里的 KEY / 枚举 / 判定逻辑时，必须同步改 public/theme-boot.js ——
// 那个文件是纯 JS，不能 import 本模块（CSP 的 script-src 只允许 'self'，
// 不含 'unsafe-inline'，所以首帧脚本是外部同步脚本而非内联 <script>）。

/** localStorage 镜像 key。与 public/theme-boot.js 的 KEY 保持一致。 */
export const THEME_MODE_KEY = 'velo.theme-mode'

export type ThemeMode = 'system' | 'light' | 'dark'

/** 读取上次保存的主题偏好；无镜像 / 非法值 / localStorage 不可用时回退 'system'。 */
export function readThemeModeMirror(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_MODE_KEY)
    if (raw === 'system' || raw === 'light' || raw === 'dark') return raw
  }
  catch { /* 隐私模式 / 存储被禁用：按默认走，不阻塞启动 */ }
  return 'system'
}

/** 写镜像。写失败只影响下次启动的首帧定色，不影响当前会话。 */
export function writeThemeModeMirror(mode: ThemeMode): void {
  try { localStorage.setItem(THEME_MODE_KEY, mode) }
  catch { /* 存储被禁用：静默降级 */ }
}

/** 当前系统是否深色。测试环境（jsdom）没有 matchMedia，防御式返回 false。 */
export function readSystemDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 主题偏好 + 系统偏好 → 最终深浅色。与 public/theme-boot.js 算法一致。 */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'dark') return true
  if (mode === 'light') return false
  return readSystemDark()
}

/** --surface-0 的亮/暗值，与 src/styles/index.scss 的变量表保持一致。 */
export const BOOT_SURFACE_0 = { light: '#e9ebf0', dark: '#15171c' } as const

/* 首帧主题定色 —— 必须同步执行、且早于所有外部 CSS，否则 WebView 会先用
   默认白底 / 默认浅色变量画一帧，等 velo-settings.json 异步读回来再整页翻面。

   为什么是外部脚本而不是内联 <script>：tauri.conf.json 的 CSP
   script-src 是 "'self' 'unsafe-eval' 'wasm-unsafe-eval'"，不含 'unsafe-inline'，
   内联脚本会被拦；同源的 /theme-boot.js 走 'self' 合法放行。

   这里的 KEY / 枚举 / 判定 / 色值必须与 src/utils/themeBoot.ts 保持一致
   （本文件在 Vite 之前由浏览器直接执行，不能 import TS 模块）。 */
(function () {
  var KEY = 'velo.theme-mode'
  var mode = 'system'
  try {
    var stored = localStorage.getItem(KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') mode = stored
  } catch { /* localStorage 不可用：按系统偏好走 */ }

  var systemDark = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
  var dark = mode === 'dark' || (mode === 'system' && systemDark)

  var root = document.documentElement
  root.classList.toggle('dark', dark)
  // CSS 还没加载时给 html 一层不透明兜底背景，颜色 = index.scss 的 --surface-0。
  // CSS 生效后 body 的 background-color 会盖住它，两者同色，无跳变。
  root.style.backgroundColor = dark ? '#15171c' : '#e9ebf0'
})()

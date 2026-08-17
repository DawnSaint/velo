import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
    // C1: decode-named-character-reference（remark-parse 传递依赖）有条件导出:
    //   "worker": index.js（纯 JS 查表）
    //   "browser": index.dom.js（document.createElement）
    // Vite dev server 用主 resolve.conditions 解析 Worker 的依赖（worker.resolve.conditions
    // 只在 build 时生效），所以必须把 'worker' 加到主 resolve.conditions 才能在 dev 模式
    // 让 Worker 拿到 index.js 而非 index.dom.js。index.js 在浏览器主线程也能正常工作。
    conditions: ['module', 'worker', 'browser', 'development', 'production', 'default'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5273,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/__tests__/**', '**/docs/**', '**/e2e/**', '**/scripts/**'],
    },
    proxy: {
      // dev 环境代理 GitHub API,避免 WebView2 跨域/CSP/混合内容拦截
      '/github-api': {
        target: 'https://api.github.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/github-api/, ''),
      },
      // dev 环境代理 raw.githubusercontent.com,用于 fetch docs/RELEASE_NOTES.md
      '/github-raw': {
        target: 'https://raw.githubusercontent.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/github-raw/, ''),
      },
    },
  },
  css: {
    devSourcemap: true,
  },
  build: {
    cssCodeSplit: false,
    chunkSizeWarningLimit: 20000,
  },
})

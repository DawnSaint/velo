import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 5273,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
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

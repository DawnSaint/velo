import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [vue()],
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
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
})

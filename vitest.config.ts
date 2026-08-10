import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    // bench 文件匹配（vitest bench 子命令使用）
    bench: {
      include: ['src/**/*.bench.ts'],
    },
    setupFiles: ['./src/test/setup.ts'],
    passWithNoTests: true,
  },
})

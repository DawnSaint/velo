// ESLint 9 flat config — Vue 3 + TypeScript
//
// 设计原则（见 ROADMAP #eslint-setup）：
// - 初期宽松规则 + baseline 过渡，渐进式收紧
// - 推荐规则集统一降为 warn（不阻断 CI），逐步收敛后升级为 error
// - Prettier 负责格式，ESLint 负责代码质量 / 最佳实践，eslint-config-prettier 关闭冲突规则
import js from '@eslint/js'
import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettierConfig from 'eslint-config-prettier'

export default ts.config(
  // ── 全局忽略 ──────────────────────────────────────────────
  {
    ignores: [
      'dist/**',
      'src-tauri/**',
      'node_modules/**',
      'src-tauri/gen/**',
      'src-tauri/target/**',
      'package-lock.json',
      'CHANGELOG.md',
      'docs/research/ocr-integration.md',
    ],
  },

  // ── 基础推荐规则 ──────────────────────────────────────────
  js.configs.recommended,

  // ── TypeScript 推荐规则 ───────────────────────────────────
  ...ts.configs.recommended,

  // ── Vue 推荐规则（flat/recommended 含 Vue 3 基础规则） ────
  ...vue.configs['flat/recommended'],

  // ── 关闭与 Prettier 冲突的规则 ────────────────────────────
  prettierConfig,

  // ── Vue SFC：让 <script lang="ts"> 用 TS parser ──────────
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
      },
    },
  },

  // ── 项目级规则覆盖 ────────────────────────────────────────
  {
    files: ['**/*.{ts,vue,js,mjs,cjs}'],
    languageOptions: {
      globals: {
        // 浏览器环境（Tauri WebView）
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        DragEvent: 'readonly',
        ClipboardEvent: 'readonly',
        File: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        FormData: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        matchMedia: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        getComputedStyle: 'readonly',
        // Tauri
        __TAURI_INTERNALS__: 'readonly',
      },
    },
    rules: {
      // ── 降级为 warn：渐进式收紧，不阻断 CI ──
      'no-unused-vars': 'off', // 交给 @typescript-eslint/no-unused-vars
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',

      // ── 代码质量：降级为 warn，逐步修复 ──
      'prefer-const': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',
      'no-sparse-arrays': 'warn',
      'no-control-regex': 'warn',
      // no-console 关闭：由 lint:console 专用脚本管 console.log/debug
      // ESLint 的 no-console 会把 console.warn/error 也报为 warning，全是噪音
      'no-console': 'off',

      // ── 关闭：与 TS strict 模式重复或不适用的规则 ──
      'no-undef': 'off', // TS 已覆盖
      'no-redeclare': 'off', // TS 已覆盖
      'no-dupe-keys': 'off', // TS 已覆盖

      // ── Vue 规则调整 ──
      'vue/multi-word-component-names': 'off', // Velo 有单词组件名（如 Breadcrumbs.vue）
      'vue/max-attributes-per-line': 'off', // Prettier 已管格式
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off', // Prettier 已管
      'vue/html-indent': 'off', // Prettier 已管
      'vue/attributes-order': 'warn',
      'vue/no-v-html': 'off', // Velo 用 v-html 渲染导出 HTML（已 DOMPurify）
    },
  },

  // ── 测试文件：允许 any / non-null assertion ───────────────
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
    },
  },

  // ── .cjs 文件：允许 require() ──────────────────────────────
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ── 脚本文件：允许 console ────────────────────────────────
  {
    files: ['scripts/**/*.{mjs,cjs,js}', 'vite.config.ts', 'vitest.config.ts'],
    rules: {
      'no-console': 'off',
    },
  },
)

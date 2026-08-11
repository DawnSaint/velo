/** @type {import('dependency-cruiser').IConfiguration} */
//
// Velo 依赖图分层约束（见 ROADMAP #dep-cruiser）
//
// 分层模型（从下往上，上层可 import 下层，下层不可 import 上层）：
//
//   Layer 0 (leaf):     src/lib/          — 纯叶模块，不依赖框架 / UI / 状态
//   Layer 1 (platform): src/tauri/        — Tauri API 薄封装
//   Layer 2 (state):    src/stores/       — Pinia 状态层
//   Layer 3 (UI):       src/components/   — Vue 组件
//                        src/composables/  — Vue composables（UI 层）
//                        src/directives/   — Vue 指令（UI 层）
//                        src/utils/        — 工具函数（UI 层，非叶模块）
//
// 规则：
//   1. no-circular       — 全 src/ 禁止循环依赖
//   2. leaf-no-upper     — src/lib/ 不允许 import stores / components / composables
//   3. stores-no-ui      — src/stores/ 不允许 import components / composables
//
// 白名单：每条豁免必须带注释原因（参考 vmark .dependency-cruiser.cjs 做法）。
// 理想状态是白名单为空——豁免项应随着重构逐步消除。
//
module.exports = {
  forbidden: [
    // ── 规则 1：禁止循环依赖 ──────────────────────────────────
    {
      name: 'no-circular',
      comment: '循环依赖会导致初始化顺序不确定、热更新断裂',
      severity: 'error',
      from: { path: 'src/' },
      to: { circular: true },
    },

    // ── 规则 2：叶模块（src/lib/）不允许 import 上层 ──────────
    {
      name: 'leaf-no-upper',
      comment:
        'src/lib/ 是纯叶模块，不允许 import stores / components / composables',
      severity: 'error',
      from: {
        path: 'src/lib/',
        // 白名单：以下文件暂时豁免，每条必须写明原因
        pathNot: [
          // htmlRenderer 复用编辑器的 remark 插件链 + markdownIO 来保持
          // 导出 HTML 与编辑器 WYSIWYG 预览一致的渲染管线。
          // TODO: 将 remark 插件 + markdownIO 抽取到 src/lib/ 消除此耦合
          'src/lib/export/htmlRenderer\\.ts',
          // shikiHtml 需要 CodeBlockLangs 的语言列表来决定代码高亮主题。
          // TODO: 将语言列表抽取到 src/lib/ 消除此耦合
          'src/lib/export/shikiHtml\\.ts',
        ],
      },
      to: {
        path: ['src/stores/', 'src/components/', 'src/composables/'],
      },
    },

    // ── 规则 3：状态层（src/stores/）不允许 import UI 层 ──────
    {
      name: 'stores-no-ui',
      comment:
        'src/stores/ 是状态层，不允许 import components / composables（状态不应依赖 UI）',
      severity: 'error',
      from: {
        path: 'src/stores/',
        // 白名单：以下文件暂时豁免，每条必须写明原因
        pathNot: [
          // document store 需要 markdownIO（fromMarkdown / toMarkdown）和 schema
          // 来解析 / 序列化 markdown。这是 Velo 最核心的耦合点。
          // TODO: 将 markdownIO + schema 抽取到 src/lib/ 消除此耦合
          'src/stores/document\\.ts',
          // editor store 需要 CodeBlockLangs 的 DEFAULT_LIGHT_THEME / DEFAULT_DARK_THEME
          // 来初始化 shiki 代码高亮主题。
          // TODO: 将主题常量抽取到 src/lib/ 或 src/styles/ 消除此耦合
          'src/stores/editor\\.ts',
        ],
      },
      to: {
        path: ['src/components/', 'src/composables/'],
      },
    },

    // ── 规则 4：平台层（src/tauri/）不允许 import 上层 ────────
    {
      name: 'tauri-no-upper',
      comment:
        'src/tauri/ 是平台封装层，不允许 import stores / components / composables',
      severity: 'error',
      from: { path: 'src/tauri/' },
      to: {
        path: ['src/stores/', 'src/components/', 'src/composables/'],
      },
    },

    // ── 规则 5：禁止 orphan（文件无人引用） ──────────────────
    {
      name: 'no-orphans',
      comment: '源码文件应该被其他模块引用，孤立的文件通常是死码',
      severity: 'warn',
      from: {
        orphan: true,
        path: 'src/',
        pathNot: [
          '\\.test\\.ts$',
          '\\.bench\\.ts$',
          'src/test/setup\\.ts$',
          'src/vite-env\\.d\\.ts$',
        ],
      },
      to: {},
    },
  ],

  options: {
    // TypeScript 路径别名：tsConfig.paths 中 @/ → src/ 由此解析
    tsConfig: { fileName: 'tsconfig.json' },
    // 不跟踪 node_modules / dist / src-tauri 内部依赖
    doNotFollow: [
      'node_modules',
      'dist',
      'src-tauri',
    ],
    // 排除非源码文件（bench / test / __tests__）
    exclude: [
      'src/bench/',
      'src/test/',
      '__tests__/',
      '\\.test\\.ts$',
      '\\.bench\\.ts$',
    ],
    // 跳过无规则需要的分析以加速
    skipAnalysisNotInRules: true,
    // 增强解析：与 vite.config.ts resolve.conditions 对齐
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['module', 'worker', 'browser', 'development', 'production', 'default'],
    },
  },
}

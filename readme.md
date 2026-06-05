# CLAUDE.md

## 项目概述

**velo** 是一个基于 Milkdown 的 Markdown 编辑器桌面应用。

| 属性 | 值 |
|------|-----|
| 项目名称 | velo |
| 版本 | 0.1.0 |
| 运行环境 | Tauri 2.0 桌面应用 |

## 技术栈

| 类别 | 技术 | 版本 | 用途 |
|------|------|------|------|
| 前端框架 | Vue 3 (Composition API) | ^3.5.13 | UI 框架 |
| 状态管理 | Pinia | ^3.0.4 | 编辑器全局状态 |
| 语言 | TypeScript | ^6.0 | 严格模式 |
| 构建 | Vite | ^8.0 | 构建工具 |
| 桌面壳 | Tauri 2.0 | ^2 | 桌面打包（插件：fs, dialog, shell） |
| CSS 框架 | Tailwind CSS 3 | ^3.4.17 | App Shell 样式 |
| CSS 预处理 | Sass | ^1.83 | SCSS 编译 |
| 编辑器 | Milkdown (ProseMirror) | ^7.21.1 | WYSIWYG 编辑 |
| 数学公式 | KaTeX | ^0.16.21 | 公式渲染 + 行内编辑 |
| 图表 | Mermaid | ^11 | 图表渲染 + 行内编辑 |

### 编辑器插件

| 插件 | 来源 | 用途 |
|------|------|------|
| commonmark | `@milkdown/kit/preset/commonmark` | 基础 Markdown 语法 |
| gfm | `@milkdown/kit/preset/gfm` | GFM 扩展（表格/任务列表等） |
| history | `@milkdown/kit/plugin/history` | 撤销/重做 |
| math | `@milkdown/plugin-math` | LaTeX 公式解析 |
| mathEditPlugin | `./MathNodeViews` | 自定义：点击公式 → textarea 行内编辑 + KaTeX 实时预览 |
| mermaidSyntax | `./MermaidSyntax` | Remark 插件 + $nodeSchema：将 ` ```mermaid ` 转为自定义节点 |
| mermaidEditPlugin | `./MermaidNodeView` | 自定义：点击图表 → textarea 行内编辑 + Mermaid 实时预览 |
| listener | `@milkdown/kit/plugin/listener` | Markdown 变化回调 → v-model |

---

## 目录结构

```
velo/
├── index.html                # HTML 入口
├── package.json              # 依赖与脚本
├── vite.config.ts            # Vite 8 配置（tsconfigPaths 内置）
├── tsconfig.json             # TS 6 strict
├── tsconfig.node.json        # Node 端 TS 配置
├── postcss.config.js         # PostCSS: tailwindcss + autoprefixer
├── tailwind.config.cjs       # Tailwind 配置（darkMode: 'class'）
├── CLAUDE.md                 # 本文件
│
├── src/
│   ├── main.ts               # createApp + Pinia + 全局样式
│   ├── App.vue               # 主布局：大纲面板 + 编辑器 + 设置面板
│   ├── vite-env.d.ts         # Vite 类型声明
│   ├── assets/
│   │   ├── sample.md         # 示例 Markdown（含 mermaid 示例）
│   │   └── Velo.png          # Logo
│   ├── stores/
│   │   └── editor.ts         # Pinia store：fontSize / primaryColor / darkMode 等
│   ├── styles/
│   │   ├── index.scss        # Tailwind 指令 + 全局样式 + 侧边面板过渡
│   │   ├── _variables.scss   # Sass 变量
│   │   ├── _plugin-common.scss # 公式 & Mermaid 公用编辑样式
│   │   ├── _math.scss        # 公式专属样式
│   │   └── _mermaid.scss     # Mermaid 专属样式
│   └── components/
│       ├── EditorOutline.vue        # 左侧大纲面板：解析标题 → 树形展示
│       ├── EditorSettings.vue       # 右侧设置面板：字号/主色/暗色等
│       └── MilkdownEditor/
│           ├── index.vue            # 编辑器主体（props 驱动，所有基础样式内联）
│           ├── MathNodeViews.ts     # 行内 & 块级公式 NodeView（行内编辑）
│           ├── MermaidSyntax.ts     # Remark 插件 + mermaid $nodeSchema
│           └── MermaidNodeView.ts   # Mermaid NodeView（异步渲染 + 行内编辑）
│
├── src-tauri/                # Tauri 2.0 桌面壳
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       └── lib.rs
```

---

## 数据流

```
App.vue (markdownContent ref)
    ↓ v-model
MilkdownEditor/index.vue (props.modelValue)
    ↓ defaultValueCtx
Milkdown Editor.make() → ProseMirror 编辑器实例
    ↓ listenerCtx.markdownUpdated()
emit('update:modelValue', markdown)
    ↓
App.vue (markdownContent 同步更新)
    ├── EditorOutline (props.modelValue) → 实时解析标题 → 树形展示
    └── EditorSettings → Pinia store → props → editorStyle CSS 变量
```

### 大纲流

```
markdownContent → EditorOutline.vue
    ├── parseHeadings(): 栈式算法构建标题树
    ├── flatList computed: 展平树（参考 collapsedKeys Set）
    ├── 点击标题 → querySelector .ProseMirror h{n} → scrollIntoView + 高亮
    └── 箭头 → set.add/delete 折叠/展开子标题
```

### 公式编辑流

```
点击公式 → startEdit()
    ├── 行内：input + 下方 edit-preview（实时 KaTeX）
    ├── 块级：textarea + 下方 edit-preview（实时 KaTeX）
    ├── input 事件 → KaTeX.render() → 更新 edit-preview
    ├── blur → save() → view.dispatch(setNodeAttribute) → ProseMirror update()
    └── Escape → cancel() → 恢复渲染态
```

### Mermaid 编辑流

```
MermaidSyntax.ts（remark 插件）
    └── MDAST code(lang=mermaid) → type: 'mermaid' → $nodeSchema parseMarkdown.match

MermaidNodeView.ts（NodeView）
    ├── 显示态：mermaid.parse() 校验 → mermaid.render() 异步渲染 → 注入 SVG
    │   ├── 空 → 虚线占位 "点击添加 Mermaid 图表"
    │   ├── 渲染中 → Loading
    │   └── 错误 → 红色错误框 + 错误信息
    ├── 编辑态：textarea + 下方 edit-preview（400ms debounce 实时 Mermaid）
    ├── blur → save() → dispatch setNodeAttribute → update() → 重新渲染
    └── Escape → cancel() → 恢复渲染态
```

---

## 构建与启动

| 命令 | 说明 |
|------|------|
| `npm run dev` | Vite 开发服务器（`--host`） |
| `npm run build` | vue-tsc 类型检查 + Vite 生产构建 |
| `npm run preview` | Vite 预览（需先 build） |
| `npm run type-check` | 仅类型检查 |
| `npm run tauri:dev` | Tauri 桌面开发模式 |
| `npm run tauri:build` | Tauri 生产构建 |

---

## 约定

1. **路径别名** — `@/` → `src/`（Vite 8 内置 `tsconfigPaths` 解析）
2. **暗色模式** — Tailwind `class` 策略 + Pinia `darkMode` → 同步 `<html>` class
3. **组件样式** — MilkdownEditor 基础样式在 `index.vue` 内联 `<style>`，公式/Mermaid 独立 SCSS 引入
4. **NodeView 模式** — ignoreMutation() + stopPropagation 隔离 ProseMirror，blur 触发 save
5. **Tauri 安全策略** — 声明式权限系统（`capabilities/default.json`）：`fs:default` + `dialog:default` + `shell:allow-open`

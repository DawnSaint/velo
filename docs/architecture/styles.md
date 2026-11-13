# Styles Architecture

> **本文件负责**：样式系统的分工规约 —— SCSS / Tailwind / Vue scoped style / TS 行内样式各自的使用边界、暗色模式策略、CSS 变量、class 命名与公共样式类。
>
> **何时阅读**：新增 / 修改任何样式来源、加 CSS 变量、加 / 删 class 名、处理暗色模式、判断"这个样式该写在哪"时。
>
> **代码入口**：`src/styles/index.scss`（入口 + `@layer base`）、`src/styles/_*.scss`、`src/styles/tailwind.css`、`src/lib/export/exportStyles.scss`、`src/directives/veloScroll.ts`、`public/theme-boot.js`。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [编辑器架构](./editor.md) · [导出架构](./export.md)

## 红线

- **DOM 由谁创建决定样式写在哪**：Vue 模板 → Tailwind / scoped；PM 命令式 DOM → TS 设 class + SCSS 写规则；全局 → `index.scss` `@layer base`；导出 → `exportStyles.scss`。
- **UI chrome 背景一律走海拔变量** `bg-[var(--surface-N)]`，不写 `bg-white dark:bg-[#xxx]` 硬编码；文字走 `--chrome-text-*`。
- **不要定义"看起来可自定义但从未被注入"的变量**；不需要运行时切换的颜色直接写硬编码。
- **海拔灰阶里不混强调色**：`--surface-*` 保持中性微冷，主题色只点交互 / 选中 / 标题。
- **Vue 组件暗色优先 Tailwind `dark:` variant**；scoped style 里无法用 Tailwind 表达时才 `:global(.dark ...)`。
- **SCSS 编辑器内容的暗色保持三路写法**（`html.dark` / `.dark` / `.velo-editor.dark`），用 `:is()` 折叠；不要集中到 `_editor-dark.scss`（那里只放跨模块通用规则）。
- **不写"有 class 名但无 CSS 规则"的幽灵 class**；需要 JS 选择器 / 语义标记一律用 `data-` 属性（或 `data-testid`）。
- **scoped style 里不硬编码与 Tailwind 调色板重复的 RGB 值**，改用 `var(--color-gray-100)`（Tailwind v4 暴露）或在注释标明对应色阶。
- **不要把 Tailwind import 合并进 SCSS**：Sass 会拦截 `@import`，Tailwind 入口必须是独立的 `tailwind.css`。

## 架构

### 样式来源分工

| 场景 | 用什么 | 位置 |
| --- | --- | --- |
| PM 编辑器内容（NodeView / Decoration 创建的 DOM） | SCSS partials | `src/styles/_*.scss` → `index.scss` |
| Vue 组件布局 / 间距 / 简单状态色 | Tailwind v4 工具类 | `tailwind.css` + 模板 `class=""` |
| Vue 组件复杂交互（伪元素 / 动画 / 多层选择器） | `<style scoped>` | 各 `.vue` |
| 跨组件全局样式（scrollbar / reset） | SCSS `@layer base` | `index.scss` |
| TS 命令式 DOM 的 class 定义 | SCSS partials | `src/styles/_*.scss` |
| 导出 HTML 独立样式表 | `exportStyles.scss` | `src/lib/export/` |

决策树：

```
这个样式服务的 DOM 是谁创建的？
├─ Vue 模板 → 能用 Tailwind 表达？ → class=""
│            → 需要伪元素 / 动画 / 复杂选择器？ → <style scoped>
├─ PM NodeView / Decoration → TS 设 className，SCSS partial 写规则
├─ 全局（scrollbar / reset）→ index.scss @layer base
└─ 导出 HTML → exportStyles.scss
```

### SCSS partials

`index.scss` 统一 `@forward`。命名：编辑器 DOM 用 `_editor-<功能>.scss`，独立组件（math / mermaid / footnote / context-menu / settings）不带前缀。

| partial | 覆盖 |
| --- | --- |
| `_fonts.scss` | JetBrains Mono `@font-face` + `--font-mono` fallback |
| `_editor-base.scss` | PM 壳 / 选区 / find 高亮 / drop-cursor / 专注模式 / 阅读模式 / 公共 icon 按钮 |
| `_editor-typography.scss` | 标题 / 段落 / 引用 / 链接 / kbd / mark / details |
| `_editor-lists.scss` | ul / ol / li + 任务列表 checkbox |
| `_editor-code.scss` | 行内 code + shiki 双主题 + 代码块 header + 语言下拉 + CM6 源码模式 |
| `_editor-tables.scss`、`_editor-image.scss`、`_editor-html-blocks.scss`、`_editor-alerts.scss`、`_editor-toc.scss`、`_editor-fold.scss`、`_editor-hr.scss`、`_editor-frontmatter.scss` | 同名功能 |
| `_editor-dark.scss` | 跨模块通用暗色规则（非 alert / 非 image） |
| `_editor-diff.scss` | WYSIWYG diff 装饰 |
| `_math.scss`、`_mermaid.scss`、`_footnote.scss` | 独立 NodeView |
| `_context-menu.scss` | 右键菜单通用项 + `.velo-kbd` |
| `_settings.scss` | 设置页共享控件（row / switch / select / slider） |

新增编辑器节点样式：建 partial → `index.scss` 加 `@forward` → 暗色规则写在同一 partial 内。

### Tailwind v4

- 无配置文件（CSS-first），入口 `src/styles/tailwind.css` 只有 `@import "tailwindcss"` + 自定义 dark variant。
- 自定义 dark variant：`@custom-variant dark (&:where(.dark, .dark *))`，把 `.dark` 类作为暗色触发器（而非默认 `prefers-color-scheme`）。
- `vite.config.ts` 中 `cssCodeSplit: false`，所有 CSS 打包成单文件。

### Vue scoped style

14 个组件有 `<style scoped>`，其中 `TabBar.vue` / `FileTree.vue` 用 `lang="scss"`，其余纯 CSS。

### TS 行内样式

仅用于静态 CSS 无法表达的运行期值：dropdown 定位（`top`/`left`）、textarea autoSize（`height`）、shiki token 颜色（`--shiki-light/dark` 写进 `Decoration.inline` 的 `style`）、TOC 层级缩进（`--toc-level`）。**静态样式不要写成行内 style。**

### 暗色模式

- **三态**：`editorStore.themeMode` = `'system'`（默认）/ `'light'` / `'dark'`；`darkMode` 是 computed，不直接持久化。旧设置文件的 `darkMode: boolean` 在 hydrate 时迁移。
- **首屏定色**：`themeMode` 有一份 localStorage 镜像（`src/utils/themeBoot.ts`），供 `index.html` 的同步脚本 `public/theme-boot.js` 在外部 CSS 之前定下 `.dark`；store 初值也读镜像，磁盘 hydrate 后回写。三者同源，避免异步读盘导致整页翻面。改 KEY / 枚举 / 色值必须同步 `public/theme-boot.js`（纯 JS，不能 import TS；CSP 只允许 `'self'`）。
- **两种触发源**：Vue 组件 UI 用全局 `<html class="dark">` / 根 div `.dark`（Tailwind `dark:`）；编辑器内容用 `.velo-editor.dark`（SCSS 三路选择器，`_editor-dark.scss` 用 `:is(.dark .velo-editor, .velo-editor.dark)` 折叠）。
- **导出 HTML** 无运行时 class 切换，走 `@media (prefers-color-scheme: dark)`。

### CSS 变量

**海拔系统**：四级 surface + 配套 border / hover / pressed / shadow，定义在 `index.scss` 的 `:root`（亮）与 `.dark`（暗）。组件只声明「我是第几层」，切换时改的是变量表。

- 暗色靠「填色叠白」做台阶（每层约 5% 白），阴影退役；亮色靠「阴影 + 边框」做浮起，填色退到灰里。两套引擎手段相反，不可简单取反。
- 全程微冷色相（B 略高于 R），亮暗共用同一条中性轴。
- 外推规则：popover = `--surface-3` + `--shadow-popover`；行 hover = `--surface-hover`；pressed / 选中 = `--surface-pressed`；禁用态把文字透明度降到 38–45%，不新建灰。

| 变量 | 用途 | 动态注入 |
| --- | --- | --- |
| `--surface-0..3` / `--surface-border` / `--surface-hover` / `--surface-pressed` / `--shadow-card` / `--shadow-popover` | 海拔填色与浮层 | ✗（dark 靠 CSS cascade） |
| `--editor-text-muted`、`--chrome-text-secondary/primary/active`、`--chrome-accent-blue` | 编辑器与 chrome 文字 | ✗ |
| `--md-primary-color` | 主题强调色（UI chrome / 导出） | ✓ `store.primaryColor` |
| `--md-doc-primary-color` | 文档内容强调色 | ✓ 仅 `themeColorAffectsDoc` 开启时注入 |
| `--md-font-family` / `--md-font-size` | 正文字体族 / 字号 | ✓ store 字体偏好 / `props.fontSize` |
| `--font-mono` | 等宽字体栈 | ✓ store（`_fonts.scss` 的 `:root` 值作 fallback） |
| `--shiki-light` / `--shiki-dark` | shiki token 颜色 | ✗ |
| `--diff-*`（add/del/fmt 线条语义色） | diff 标记 | ✗ |
| `--toc-level` | TOC 缩进层级 | ✓ 运行时计算 |

### class 命名

`velo-` 前缀 = Velo 自定义 class，主要用于 PM 编辑器内容（避免与第三方 / Tailwind 冲突）；独立组件（math / mermaid / footnote）可无前缀，因为选择器都嵌在 `.velo-editor` 下天然隔离。

### 公共样式类

- **`velo-icon-btn`**（`_editor-base.scss`）：编辑器内纯图标按钮基类，已含 flex 居中、1.75em 尺寸、透明底、`svg { width/height: 1em }`、统一 transition。变体 `--danger`（hover 红）、`--hidden`（`opacity:0` + `visibility:hidden`，由父 hover / `.selected` 显现）。暗色 hover 浅灰底与 danger 暗色红都在公共类里，新增按钮**只写差异**（定位 / 尺寸 override / 显现机制）。
- **`velo-kbd`**（`_context-menu.scss`）：快捷键提示，统一 `var(--font-mono)` / `0.625rem` / `--surface-pressed` pill 底 / 自适应文字色，默认 `margin-left: 1.25rem`（配合 `flex:1` 的 label 右对齐），需要防压缩时加 `shrink-0`。用于 `TableContextMenu` / `FileMenuButton` / `QuickCommandPanel`。
- **`.velo-scroll` 浮动滚动条**（`index.scss` layer 外 + `src/directives/veloScroll.ts`）：原生滚动条 `width:0` 隐藏，JS 创建 `position:fixed` 的 `.velo-scroll-thumb` 浮在内容右侧。相比 `::-webkit-scrollbar` 的两个优势：不占布局空间（整行高亮可紧贴右边框）、淡入淡出可靠（自己的 DOM transition）。用法：模板用 `v-velo-scroll` 指令（不要手写 class）；命令式 DOM（CM6 `.cm-scroller`）用 `attachVeloScroll` / `detachVeloScroll`。适用于工作区常驻滚动容器（编辑器 / 文件树 / 大纲 / 搜索 / 资产 / 设置 / 源码模式），弹出式容器继续用全局 `::-webkit-scrollbar`。

### 颜色门禁

`lint:design-tokens`（`scripts/lint-design-tokens.mjs`）检测 SCSS / Vue `<style>` 中的硬编码颜色（`#hex` / `rgb()` / `rgba()` / `hsl()`），baseline 棘轮模式防新增。baseline 在 `scripts/lint-design-tokens-baseline.json`（212 条，按 `file:color` 记录，行号变动不漂移），**机器可读的存量清单以此为准**。

规则：UI chrome 背景走海拔变量、主题色走 `var(--md-primary-color)`；`var(--xxx, #fallback)` 的 fallback 与注释里的颜色放行。新增颜色先确认能否复用，确需新增再跑 `npm run lint-design-tokens:baseline` 更新 baseline。

语义分组（用于判断该复用哪一类，不是逐行清单）：

| 分组 | 位置 | 说明 |
| --- | --- | --- |
| UI chrome 海拔色 | `index.scss` 变量定义处 | 封闭四级 + 配套层，不建议新增 |
| UI chrome 滚动条 | 三套滚动条共用色阶 | 改一处必须三处同步 |
| UI chrome scoped | `_settings.scss` / `TabBar` / `AssetPanel` / `WindowControls` | 已迁移到 `--chrome-text-*` 的不再列入 |
| 右键菜单 danger | `_context-menu.scss` | 删除类操作 |
| 设置页交互 | `_settings.scss` | switch / slider / select |
| 编辑器语法高亮 | `_editor-code.scss` / `_editor-dark.scss` | 对齐 GitHub Primer 色板，不建议随意改 |
| 编辑器文字灰阶 | 各 `_editor-*.scss` | 次要文字优先用 `--editor-text-muted` |
| 编辑器链接 / 强调 | `_typography` / `_editor-tables` / `_math` / `_mermaid` / `_editor-fold` | — |
| 导出样式 | `exportStyles.scss` | 与编辑器内容镜像 |
| diff 线条语义 | `_editor-diff.scss` 的 `--diff-*` | 见 [editor.md](./editor.md) diff 节 |

## 关键取舍

- **Tailwind 与 Sass 必须分开入口**：Sass 拦截 `.scss` 里的 `@import`，所以 Tailwind 走独立 `tailwind.css`，与 `index.scss` 在 `main.ts` 同步引入。
- **编辑器内容不经过 Vue 模板，也无法走 Tailwind**，因此 PM 侧只能 class + SCSS；这是分工的硬约束，不是风格偏好。
- **行内 code 不做语法着色**：文字 `color: inherit` 跟随正文色，底色用 `color-mix(in srgb, currentColor 7%, transparent)` 由当前文字色派生，亮暗自动翻面，也不需要 dark 覆盖规则。
- **导出样式靠 `@forward` 复用编辑器 partials**：新增节点样式时，若该节点会出现在导出 HTML 中（非纯交互 widget），确认对应 partial 已被 `exportStyles.scss` forward；交互类样式（find 高亮 / drop-cursor / fold toggle）不需要 forward —— CSS 没命中选择器就不会画。
- **加新 Vue 组件**：布局 / 间距 / 颜色用 Tailwind → 复杂样式用 scoped → 暗色优先 `dark:` → 不在 scoped 里硬编码与 Tailwind 重复的 RGB。

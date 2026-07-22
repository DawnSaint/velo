# Styles Architecture

> **本文件负责**: 样式系统的分工规约——SCSS / Tailwind / Vue scoped style / TS 行内样式各自的使用边界、暗色模式统一策略、CSS 变量管理、class 命名约定。
>
> **何时阅读**: 新增 / 修改任何样式来源、加 CSS 变量、加 / 删 class 名、处理暗色模式、判断"这个样式该写在哪"时。
>
> **先记住**:
> - 编辑器内容（ProseMirror DOM）→ SCSS partials；Vue 组件布局 → Tailwind；复杂交互 → scoped style；命令式 DOM → TS 设 class + SCSS 定义规则。
> - Vue 组件内暗色一律走 Tailwind `dark:` variant；SCSS 编辑器内容保持三路写法（`html.dark` / `.dark` / `.velo-editor.dark`）。
> - 不要在 Vue 模板里写"有 class 名但无 CSS 规则"的幽灵 class——需要 JS 选择器用 `data-` 属性，需要语义标记也用 `data-`。
> - CSS 变量只在需要运行时动态切换（主题色 / 字体 / shiki 双主题）时使用；静态颜色值直接写硬编码。
>
> **相关文件**: [架构入口](../ARCHITECTURE.md) / [编辑器架构](./editor.md) / [导出架构](./export.md)

---

## 样式来源分工

项目有四套样式来源，各有明确的使用边界：

| 场景 | 用什么 | 入口 / 位置 | 理由 |
|------|--------|------------|------|
| ProseMirror 编辑器内容（NodeView / Decoration 创建的 DOM） | **SCSS partials** | `src/styles/_*.scss` → `index.scss` | 命令式 DOM 不经过 Vue 模板，class → SCSS 是 ProseMirror 的固有模式 |
| Vue 组件布局 / 间距 / 简单状态色 | **Tailwind v4 工具类** | `src/styles/tailwind.css` + Vue 模板 `class=""` | 原子类、零自定义 CSS、`dark:` variant 原生支持 |
| Vue 组件复杂交互（伪元素 / 动画 / 多层选择器 / SCSS 嵌套） | **Vue `<style scoped>`** | 各 `.vue` 文件 | scoped 隔离防泄漏；能用 Tailwind 表达的不要写 scoped |
| 跨组件全局样式（scrollbar / splitter 等） | **SCSS `index.scss` `@layer base`** | `src/styles/index.scss` | 全局生效，不跟任何组件绑定 |
| TS 命令式 DOM 的 class 定义 | **SCSS partials**（同编辑器内容） | `src/styles/_*.scss` | class 名写在 TS 里，样式规则写在 SCSS 里 |
| 导出 HTML 独立样式表 | **`exportStyles.scss`** | `src/lib/export/exportStyles.scss` | forward 编辑器 partials + 导出专用 dark 媒体查询 |

### 判断"该写在哪"的决策树

```
这个样式服务的 DOM 是谁创建的？
├─ Vue 模板（<template> 里写的标签）
│  ├─ 能用 Tailwind 工具类表达？ → 写在 class="" 里
│  └─ 需要伪元素 / 动画 / 复杂选择器？ → 写在 <style scoped> 里
├─ ProseMirror NodeView / Decoration（TS 里 document.createElement）
│  → TS 设 className，SCSS partial 写规则
├─ 全局（scrollbar / reset 等）
│  → SCSS index.scss @layer base
└─ 导出 HTML
   → exportStyles.scss
```

---

## 各来源现状

### SCSS partials（`src/styles/`）

```
index.scss              ← 入口：@forward 全部 partial + @layer base 全局 reset
_fonts.scss             ← JetBrains Mono @font-face + --font-mono
_editor-base.scss       ← ProseMirror 壳 / 选区 / find 高亮 / drop-cursor / 专注模式 / 阅读模式
_editor-typography.scss ← 标题 / 段落 / 引用 / 链接 / kbd / mark / details
_editor-lists.scss      ← ul / ol / li + 任务列表 checkbox
_editor-code.scss       ← 行内 code + shiki 双主题 + 代码块 header widget + 语言下拉 + CM6 源码模式
_editor-tables.scss     ← 表格
_editor-image.scss      ← image NodeView + 编辑按钮 + 源码编辑态
_editor-html-blocks.scss← HTML 透传容器 + link/html source edit + 块级源码切换按钮
_editor-alerts.scss     ← GFM alert / callout
_editor-toc.scss        ← TOC 目录 widget
_editor-fold.scss       ← 块级折叠 toggle / placeholder
_editor-hr.scss         ← hr 选中态
_editor-frontmatter.scss ← YAML front matter NodeView（Typora 风格 styled code block）
_editor-dark.scss       ← 暗色模式（非 alert / 非 image 部分）
_math.scss              ← 数学公式 NodeView + 编辑壳
_mermaid.scss           ← mermaid widget / toolbar / error / loading
_footnote.scss          ← 脚注 reference / definition
_context-menu.scss      ← 右键菜单通用项样式（.ctx-menu-item / --danger / separator），跨 4 份 *ContextMenu 组件共用
_settings.scss          ← 设置页共享样式（.velo-setting-row / .velo-switch / .velo-select / .velo-slider-* 等），跨 SettingsPage + 各分组组件共用
```

按功能域拆分，`index.scss` 统一 `@forward`。新增编辑器节点样式时在 `index.scss` 加一行 `@forward`，文件名用 `_editor-<功能>.scss` 或 `_<功能>.scss`（编辑器 DOM 用 `_editor-` 前缀，独立组件如 math / mermaid / footnote 不带）。

### Tailwind v4

- 无配置文件（v4 CSS-first），入口 `src/styles/tailwind.css` 只有 `@import "tailwindcss"` + 自定义 dark variant
- 自定义 dark variant：`@custom-variant dark (&:where(.dark, .dark *))` —— 把 `.dark` 类作为暗色触发器（而非默认的 `prefers-color-scheme`）
- `main.ts` 中与 `index.scss` 同步引入
- `vite.config.ts` 中 `cssCodeSplit: false` —— 所有 CSS 打包成单文件

### Vue scoped style

12 个组件有 `<style scoped>` 块。其中 `TabBar.vue` 和 `FileTree.vue` 用 `lang="scss"`，其余用纯 CSS。

scoped style 中如需引用暗色模式，优先走 Tailwind `dark:` variant（在模板 `class=""` 里写 `dark:bg-gray-800`）；只有当选择器无法用 Tailwind 表达（如 `:hover` 伪类组合、`::before` 伪元素）时才用 `:global(.dark ...)`。

### TS 行内样式与 class

ProseMirror NodeView / Decoration 通过 `document.createElement` 命令式创建 DOM。class 名直接写在 TS 代码里，对应的 CSS 规则在 SCSS partials 中定义。这是 ProseMirror 的固有模式——命令式 DOM 无法走 Vue 模板。

少数场景需要动态 inline style：
- dropdown 定位（`style.top` / `style.left` 动态计算）
- textarea autoSize（`style.height` 跟随 `scrollHeight`）
- shiki token 颜色（`--shiki-light` / `--shiki-dark` 局部 CSS 变量写进 `Decoration.inline` 的 `style`）
- TOC 层级缩进（`style.setProperty('--toc-level', ...)`）

这些动态值无法用静态 CSS 表达，行内 style 是合理的。**静态样式不要写成行内 style**——统一走 class + SCSS。

---

## 暗色模式

### 两种触发源

项目有两套暗色触发源，覆盖不同场景：

| 触发源 | 写法 | 适用场景 |
|--------|------|---------|
| 全局 `<html class="dark">` 或根 div `.dark` | Tailwind `dark:` variant | Vue 组件 UI（顶栏 / 侧栏 / 状态栏 / 面板） |
| 编辑器容器 `.velo-editor.dark` | SCSS 三路选择器 | ProseMirror 编辑器内容 |

`App.vue` 在根 div 上绑定 `:class="{ 'dark': store.darkMode }"`。`ProseMirrorEditor/index.vue` 和 `SourceModeEditor.vue` 在编辑器容器上额外绑 `:class="{ 'dark': props.darkMode }"`。

### SCSS 三路 dark 命中

编辑器内容（ProseMirror DOM）不经过 Tailwind，暗色模式靠 SCSS 选择器翻面。同一份 dark 规则需要覆盖三种触发源：

```scss
html.dark .velo-editor pre,        // 全局 <html class="dark">
.dark .velo-editor pre,             // 父级 .dark 容器
.velo-editor.dark pre {             // 编辑器自身 .dark
  // dark 规则
}
```

用 `:is()` 折叠前缀避免每条规则写三遍（见 `_editor-dark.scss`）：

```scss
:is(.dark .velo-editor, .velo-editor.dark) {
  // dark 规则
}
```

部分文件（如 `_editor-code.scss`）因选择器特异性需求保持三路展开写法，不强制折叠。

### Vue scoped style 中的暗色

优先走 Tailwind `dark:` variant。无法用 Tailwind 表达时用 `:global(.dark ...)`：

```css
/* 优先：模板里用 Tailwind dark: */
<button class="bg-white dark:bg-gray-800">

/* scoped style 中伪元素等无法走 Tailwind 的场景 */
:global(.dark .my-element:hover) {
  background: rgba(255, 255, 255, 0.08);
}
```

### 导出 HTML 的暗色

导出 HTML 没有运行时 class 切换，走 `@media (prefers-color-scheme: dark)` 自适应（见 `exportStyles.scss`）。

---

## CSS 变量管理

### 已定义的变量

| 变量 | 定义位置 | 用途 | 动态注入 |
|------|---------|------|---------|
| `--md-primary-color` | `App.vue` 设到 `<html>` | 主题强调色(UI chrome / 导出) | ✓ store.primaryColor |
| `--md-doc-primary-color` | `App.vue` 设到 `<html>`(条件) | 文档内容强调色 | ✓ store.primaryColor(仅 themeColorAffectsDoc 开启时注入) |
| `--md-font-family` | 同上 | 正文字体族 | ✓ props.fontFamily |
| `--md-font-size` | 同上 | 正文字号 | ✓ props.fontSize |
| `--font-mono` | `_fonts.scss` `:root` | 等宽字体栈 | ✗ 静态 |
| `--shiki-light` / `--shiki-dark` 等 | `_editor-code.scss` `:root` | shiki 双主题 token 颜色 | ✗ 静态（dark 切换靠 CSS cascade） |
| `--toc-level` | `TocDecoration.ts` 行内 `style.setProperty` | TOC 缩进层级 | ✓ 运行时计算 |

### 禁令

- **不要定义"看起来可自定义但从未被注入"的变量**。如果颜色不需要运行时切换，直接写硬编码值，不要包 `var(--xxx, fallback)`——这会让维护者误以为变量可以自定义。
- **不要在 scoped style 中硬编码与 Tailwind 调色板重复的 RGB 值**。如果颜色与 Tailwind gray-100 等一致，优先在模板里用 Tailwind class；确需在 scoped style 中引用时用 `var(--color-gray-100)`（Tailwind v4 暴露的 CSS 变量）或注释标明对应的 Tailwind 色阶。

---

## 公共 icon 按钮

编辑器内的纯图标交互按钮（代码块 header 的 fold/copy/wrap、mermaid 工具栏、TOC 删除、图片编辑、fold toggle、frontmatter 折叠等）共享公共类 `velo-icon-btn`，定义在 `_editor-base.scss`。

### 变体

| 变体类 | 语义 | 效果 |
|--------|------|------|
| `velo-icon-btn` | 基础按钮 | flex 居中、1.75em × 1.75em、透明底、SVG 跟随字号（1em）、统一过渡（opacity/visibility/background/color/transform 全部 0.12s ease）、hover 浅灰底 |
| `velo-icon-btn--danger` | 删除类按钮（覆盖 hover） | hover 红色（亮色 `#cf222e` / 暗色 `#f85149`）+ 浅红底 |
| `velo-icon-btn--hidden` | 默认隐藏、由父 hover / `.selected` 显现 | `opacity: 0` + `visibility: hidden`（opacity 做过渡，visibility 禁止交互直到显现） |

暗色规则：`.velo-icon-btn:hover` 浅灰底 → `rgba(255,255,255,0.08)`；danger 暗色红 — 统一写在公共类里，不需要各按钮单独声明。

### 使用规则

- **新增纯图标按钮**：`className` 加 `velo-icon-btn` + 内嵌 svg，SCSS 只写自己的差异（尺寸 override、颜色、定位、显现机制、折叠旋转）。
- **不再重复声明的基础属性**：display、align-items、justify-content、padding、border、border-radius、background、cursor、user-select、line-height、vertical-align、width/height（1.75em）、transition、svg 尺寸。这些都由公共类提供。
- **尺寸需 override 时**：在各自的按钮类里写 `width`/`height`（如 fold-toggle 固定 24px、frontmatter-fold 1.4em）。公共类用的是 `em` 单位，override 成 `px` 或别的 `em` 值即可覆盖。
- **颜色需差异化时**：给该按钮写 `color` + 可能的 `:hover` color（如 fold toggle / frontmatter fold 的 hover 主色）。danger 红色不需要自行声明，加 `--danger` 变体即可。
- **SVG 跟随字号是默认行为**：因为公共类设了 `svg { width: 1em; height: 1em }`。只有 `velo-icon-btn` 本身字号链入 `--md-font-size` 才生效——大多数按钮都已经通过容器继承链完成链接。
- **暗色 hover 不需要逐条声明**：所有按钮的暗色 hover 浅灰底和 danger 暗色红都由公共类的暗色规则覆盖。

### 示例

新增一个纯图标按钮的正确姿势：

```ts
// TS: className 加 velo-icon-btn
btn.className = 'velo-icon-btn my-comp-btn'
```

```scss
// SCSS: 只写差异
.my-comp-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  // 无需声明 display/flex/border/cursor/尺寸/transition/svg 1em
  // 它们全部由 .velo-icon-btn 提供
}
```

---

## 工作区浮动滚动条（`.velo-scroll`）

工作区常驻滚动容器用**浮动 thumb**方案：原生滚动条隐藏（`width:0` 不占布局空间），由 JS 创建 `position:fixed` 的 `.velo-scroll-thumb` DOM 浮在内容右侧。CSS 定义在 `index.scss`（`@layer base` 之外），JS 实现在 `src/directives/veloScroll.ts`。

**两个设计目标**（纯 CSS `::-webkit-scrollbar` 做不到）：
1. **不占布局空间** —— 原生自定义滚动条是 classic 模式（占宽度），整行高亮无法紧贴右侧 border；浮动 thumb 悬浮在内容之上，内容占满容器宽度。
2. **可靠淡入淡出** —— thumb 默认 `opacity:0`，`mouseenter` 容器时 JS 给 thumb 加 `.velo-scroll-thumb-visible` → `opacity` transition（0.18s）淡入；`mouseleave` 淡出。自己的 DOM transition 100% 可靠（webkit scrollbar 伪元素 transition 不稳定，且 transparent thumb 时容器 `:hover` 不驱动重绘）。

| 滚动条 | 位置 | 显示策略 | 占空间 | 适用 |
|--------|------|---------|--------|------|
| 全局 `::-webkit-scrollbar` | `index.scss` `@layer base` | 常驻 8px | 是 | 弹出菜单 / dialog / popover |
| `.velo-scroll` 浮动 thumb | `index.scss`（layer 外）+ `veloScroll.ts` | 鼠标进入容器淡入(0.18s)，离开淡出 | 否 | 工作区常驻滚动容器 |
| code_block / table | `_editor-code.scss` / `_editor-tables.scss` | 常驻淡显示，10px track / ~6px thumb | 是 | 编辑器内容局部滚动 |

### 颜色统一约定

三套滚动条颜色已统一为同一套色阶（亮色灰色系 / 暗色白色系），仅显示策略不同：

| 模式 | thumb | hover |
|------|-------|-------|
| 亮色 | `rgba(144, 146, 152, 0.3)` | `rgba(144, 146, 152, 0.5)` |
| 暗色 | `rgba(255, 255, 255, 0.2)` | `rgba(255, 255, 255, 0.35)` |

**维护约束**：改任意一处滚动条颜色时，三处（全局 / 浮动 thumb / code_block·table）必须同步，保持视觉一致。浮动 thumb 的 hover/dragging 态对应 webkit 伪元素的 `:hover` 态，透明度值相同。

### thumb 定位机制

thumb 作为滚动容器的**子元素**（JS `appendChild`），`position:fixed` 使其不随内容滚动、不被 `overflow` 裁剪（前提：容器及祖先无 `transform`，已确认工作区滚动容器链路无 transform）。`updateThumb` 在 scroll / resize / DOM 变化时读容器的 `getBoundingClientRect()` 计算 thumb 的 fixed 屏幕坐标（`top` / `left`），并按 `scrollTop / (scrollHeight - clientHeight)` 比例算 thumb 高度和位置。

- 淡入淡出：`transition: opacity 0.18s ease`（thumb 自己的 DOM，可靠）
- 拖拽：`mousedown` thumb → 全局 `mousemove`/`mouseup`，按拖拽距离换算 `scrollTop`
- 节流：rAF（每帧最多一次 `updateThumb`）
- 内容不足：`display: none`（不占位、不可交互）
- 暗色模式：`.velo-scroll-thumb` 是容器 DOM 后代，自然命中 `.dark` 祖先选择器

### 用法

- **Vue 模板**：用 `v-velo-scroll` 指令（全局注册于 `main.ts`，实现在 `src/directives/veloScroll.ts`）。指令负责隐藏原生滚动条 + 创建/管理 thumb，模板里**不要**再写 `velo-scroll` class。
- **命令式 DOM**（CM6 `.cm-scroller`）：`attachVeloScroll(view.scrollDOM)` 挂载、`detachVeloScroll` 卸载。

**适用范围**：编辑器主区域 / 文件树 / 大纲 / 搜索结果 / 资产面板 / 设置页 / 源码模式。弹出式容器（右键菜单 / QuickCommandPanel / 子菜单 / Dialog / popover）不适用，继续用全局滚动条。

---

## class 命名约定

### 前缀

| 前缀 | 含义 | 示例 |
|------|------|------|
| `velo-` | Velo 项目自定义 class | `velo-editor` / `velo-code-header-widget` / `velo-find-match` |
| 无前缀 | 通用语义 class / BEM 块名 | `task-checkbox` / `mermaid-toolbar` / `math-error` |

编辑器内容（ProseMirror DOM）的 class 一律用 `velo-` 前缀，避免与第三方库 / Tailwind 冲突。独立组件（math / mermaid / footnote）的 class 可以不带前缀，因为它们的选择器都嵌在 `.velo-editor` 下，天然隔离。

### 禁令

- **不要写"有 class 名但无 CSS 规则"的幽灵 class**。class 要么有对应的 CSS 规则，要么有 JS querySelector 引用。如果两者都没有，删除。
- **需要 JS 选择器时用 `data-` 属性**，不要用 class。`data-` 属性语义更明确，不会让人误以为有样式规则。已有约定：`data-fr-panel` / `data-quick-command-panel` / `data-statusbar-popover` 等。
- **需要语义标记（debug / 测试定位）时也用 `data-` 属性**，如 `data-testid`。

---

## 维护者注意点

### 加新编辑器节点样式

1. TS 文件中 `createElement` + 设 `className`
2. 新建 `src/styles/_editor-<功能>.scss` 或复用已有 partial
3. `index.scss` 加 `@forward`
4. 暗色规则写在同一 partial 内（用 `:is(.dark .velo-editor, .velo-editor.dark)` 前缀），不要集中到 `_editor-dark.scss`（只有跨模块的通用暗色规则才进 `_editor-dark.scss`）

### 加新 Vue 组件

1. 布局 / 间距 / 颜色用 Tailwind class
2. 复杂样式（伪元素 / 动画）用 `<style scoped>`
3. 暗色模式优先 Tailwind `dark:`，无法表达时 `:global(.dark ...)`
4. 不要在 scoped style 里硬编码与 Tailwind 重复的 RGB 值

### Tailwind v4 与 Sass 的共存限制

Sass 会拦截 `.scss` 文件里的 `@import`，导致 Tailwind v4 的 `@import "tailwindcss"` 无法写在 `.scss` 中。因此 Tailwind 入口是独立的 `tailwind.css` 文件，在 `main.ts` 中与 `index.scss` 同步引入。**不要尝试把 Tailwind import 合并进 SCSS**。

### 导出样式复用

`exportStyles.scss` 通过 `@forward` 复用编辑器 partials，让导出 HTML 与编辑器视觉一致。新增编辑器节点样式时，如果该节点会出现在导出 HTML 中（非纯编辑器交互如 widget toolbar），确保对应的 SCSS partial 被 `exportStyles.scss` forward。编辑器交互类样式（find 高亮 / drop-cursor / fold toggle 等）不需要 forward——CSS 没命中选择器就不会画，零干扰。

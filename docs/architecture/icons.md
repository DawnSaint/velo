# Icons

> **本文件负责**：项目内所有 UI 图标（工具栏 / 侧边栏 / 状态栏 / 命令面板 / ProseMirror Widget 工具栏）的来源、组织方式与维护约定。
>
> **何时阅读**：新增 / 替换任意图标，改动 ProseMirror Widget 的 SVG 字符串，或想知道某个语义图标该用哪个组件 / 常量时。
>
> **代码入口**：`src/components/icons/widgetIcons.ts`、`src/components/WindowControls.vue`、`package.json`（`@lucide/vue`）。
>
> **相关文档**：[架构入口](../ARCHITECTURE.md) · [样式架构](./styles.md)

## 红线

- **禁止在 `.vue` / `.ts` 里新写内联 `<svg>` 标签或 SVG path 字符串**（`WindowControls.vue` 的 16×16 原生窗口按钮是唯一例外）。
- **两条路径不可混用**：Vue template 用 `@lucide/vue` 组件；TS 字符串拼接 innerHTML 的场景用 `widgetIcons.ts` 工厂函数。前者拿不到字符串，后者拿不到组件。
- **图标尺寸通过 `:size` prop 传**，不用 Tailwind `size-*` 类改 SVG 本身。
- **stroke-width 默认 2**，需要更细线条时显式传 `:stroke-width="1.5"`；`checkSvg` 固定 2.5、`imageOffSvg` 固定 1.5。
- **新增图标先查 `@lucide/vue`**（https://lucide.dev 可搜），有则直接 import，无再讨论自建。

## 架构

### 两条路径

| 场景 | 用什么 | 示例 |
| --- | --- | --- |
| Vue template | `@lucide/vue` 组件 | `<FilePlus :size="16" :stroke-width="2" />` |
| ProseMirror Decoration / Widget（`innerHTML`） | `widgetIcons.ts` 工厂函数 | `el.innerHTML = trashSvg(14)` |

`@lucide/vue` 组件默认 `stroke="currentColor"`、`fill="none"`、`stroke-linecap="round"`、`stroke-linejoin="round"`，颜色继承父元素 `color`，无需额外配置。

### 目录结构

```
src/components/icons/
└── widgetIcons.ts        # Widget innerHTML 专用的 SVG 工厂函数
```

不设 `Icon.vue` 包装组件、不设图标注册表 —— `@lucide/vue` 本身就是组件库，再包一层只增加间接性。

### Widget 工厂函数

`widgetIcons.ts` 导出工厂函数（非固定字符串），接受 `size` 参数返回完整 `<svg>` 字符串，内部固定 `viewBox="0 0 24 24"` + lucide 描边约定；path 与 `@lucide/vue` 同名图标对齐。

| 工厂函数 | 用途 | 调用点（尺寸） |
| --- | --- | --- |
| `chevronDownSvg` | 代码块语言下拉 / 折叠展开 | `CodeHighlightWidget`(14)、`FoldDecoration`(16)、`FrontmatterNodeView` |
| `chevronUpSvg` | mermaid 收起 | `MermaidDecoration`(14) |
| `copySvg` | 代码块复制 | `CodeHighlightWidget`(12) |
| `checkSvg`（描边 2.5） | 复制成功对勾 | `CodeHighlightWidget`(12) |
| `trashSvg` | mermaid / TOC 删除 | `MermaidDecoration`(14)、`TocDecoration`(16) |
| `codeXmlSvg` | HTML 图片 / 块级 HTML 源码切换 | `editor/imageNodeView.ts`(12)、`HtmlNodeView`(12) |
| `wrapTextSvg` / `nowrapSvg` | 代码块软换行切换 | `CodeHighlightWidget`(14) |
| `listOrderedSvg` / `alignJustifySvg` | 代码块行号切换 | `CodeHighlightWidget`(14) |
| `imageOffSvg`（描边 1.5） | 图片加载失败占位 | `editor/imageErrorPlaceholder.ts`(20) |

## 关键取舍

- **选 `@lucide/vue` 而非自建注册中心**：项目现有图标本就是逐字抄的 lucide path，引入库等于把抄来的东西归还原主，零视觉迁移成本；`sideEffects: false` + ESM，tree-shaking 后只打进用到的图标（增量约几 KB）；数千个图标现成可用，后续加图标零成本。`@lucide/vue` 是官方活跃维护包，`lucide-vue-next` 已 deprecated。
- **Widget 场景单独一个 `widgetIcons.ts`**：ProseMirror 的 Decoration / Widget 通过 `innerHTML` 注入 DOM，拿不到 Vue 组件实例只能用字符串。集中到一个文件而非散落在各自的 `.ts` 里，目的是消除 `CodeHighlightWidget.ts` / `MermaidDecoration.ts` / `TocDecoration.ts` 三处各自复制 chevron / trash 的问题，path 数据与 lucide 标准对齐时只改一处。该文件的字符串**只服务于 Widget innerHTML**，不暴露给 Vue 组件用。
- **`WindowControls.vue` 是例外**：Windows 原生窗口按钮走 `viewBox="0 0 16 16"` 的极简风格，与 lucide 的 24×24 网格不兼容，保留原内联 SVG，不纳入本体系。
- **图标视觉锁 lucide 标准**：所有图标统一为 lucide 24×24 网格、`stroke-width="2"`。已知视觉变化：原项目搜索图标用 `circle r=7`，迁移后统一为 lucide 标准 `r=8`（圆略大一点），属刻意消除 drift，不是回归。
- **`save-as` / `export` 视觉匹配 `Upload` / `Download`**（原项目就是抄的这两个 path），不是 `SaveAll` / `FileOutput`，迁移时保持视觉不变。

## 附录

### Vue 组件使用分布

24 个文件 import `@lucide/vue`。按位置分组：

| 位置 | 图标 |
| --- | --- |
| `QuickCommandPanel.vue` | `FilePlusCorner`（新建）、`FileSearch`（快速打开）、`FileUp`（打开）、`AppWindowMac`（新窗口）、`Save`、`Upload`（另存为）、`Download`（导出）、`Search`、`Replace`、`Settings`、`Code2`、`History`、`List`、`Folders`、`FolderX`、`FolderOpen`、`Terminal` / `AtSign` / `ListOrdered`（前缀介绍行）、`Moon` / `SunMoon`（外观）、`PenOff`（只读）、`Pin`（置顶）、`TextCursorInput`（行号跳转） |
| `ActivityBar.vue` | `Search`、`Settings`、`History`、`List` |
| `Sidebar/RootActionButtons.vue` | `FilePlus`、`FolderPlus`、`RefreshCw`、`ChevronsDownUp`、`Check` |
| `Sidebar/FileTree.vue` | `Folder`、`Image`、`ChevronRight` |
| `Sidebar/EditorOutline.vue` | `ChevronsDownUp`、`List`、`ChevronRight` |
| `Sidebar/AssetPanel.vue` | `Image`、`ChevronRight` |
| `Sidebar/VersionHistoryPanel.vue` | `RefreshCw`、`History` |
| `findreplace/FindReplace.vue` | `Search`、`Replace`、`X`、`ChevronUp`、`ChevronDown`、`ChevronRight` |
| `WorkspaceSearchPanel.vue` | `Search`、`Replace`、`X`、`ChevronDown`、`ChevronRight` |
| `StatusBar.vue` | `Code2`、`Eye`、`PenOff` |
| `DiffView.vue` | `Code2`、`Eye` |
| `WelcomeDialog.vue` | `FilePlus`、`FolderOpen` |
| `Breadcrumbs.vue` / `FileMenuButton.vue` / `TabBar.vue` | `ChevronRight` / `Settings` 等 |

### 使用方式

```vue
<script setup>
import { FilePlus, Search, X } from '@lucide/vue'
</script>

<template>
  <FilePlus :size="16" :stroke-width="2" />
  <Search :size="20" />
  <X :size="14" />
</template>
```

```ts
import { trashSvg, copySvg } from '@/components/icons/widgetIcons'

const el = document.createElement('button')
el.innerHTML = trashSvg(14)
```

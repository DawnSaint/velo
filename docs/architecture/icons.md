# 图标管理 (icons)

## 本文件负责

项目内所有 UI 图标(工具栏 / 侧边栏 / 状态栏 / 命令面板 / ProseMirror Widget 工具栏)的来源、组织方式与维护约定。

## 何时阅读

- 新增 / 替换任意图标
- 改动涉及 ProseMirror Widget(代码块工具栏、mermaid 工具栏、TOC 删除按钮)的 SVG 字符串
- 想知道某个语义图标该用哪个组件 / 常量

## 先记住

1. **单一来源**:通用图标一律来自 `@lucide/vue`(Vue 组件),Widget innerHTML 场景的少量 SVG 字符串集中存放在 `src/components/icons/widgetIcons.ts`。**禁止在 .vue / .ts 里新写内联 `<svg>` 标签或 SVG path 字符串。**
2. **两条路径不可混用**:Vue template 里用 `<File :size="16" />` 组件;TS 字符串拼接 innerHTML 的场景(ProseMirror Decoration/Widget)用 `import { trashSvg } from '@/components/icons/widgetIcons'`。前者拿不到字符串,后者拿不到组件。
3. **`WindowControls.vue` 是例外**:Windows 原生窗口按钮走 `viewBox="0 0 16 16"` 的极简风格,与 lucide 的 24×24 网格不兼容,保留原内联 SVG,不纳入本体系。
4. **图标视觉锁 lucide 标准**:迁移后所有图标统一为 lucide 24×24 网格、`stroke-width="2"`。已知视觉变化:原项目搜索图标用 `circle r=7`,迁移后统一为 lucide 标准 `r=8`(圆略大一点),属刻意消除 drift,不是回归。

## 设计取舍

### 为什么选 `@lucide/vue` 而非自建注册中心

- 项目现有图标本就是逐字抄的 lucide path(代码注释里两次自述 "lucide 风格"),引入库等于把抄来的东西归还原主,零视觉迁移成本
- `sideEffects: false` + ESM,tree-shaking 后只打进用到的图标,实测增量约几 KB
- 5952 个图标现成可用,后续加图标零成本;自建注册中心每个新图标都要手抄 path
- `@lucide/vue` 1.21.0 是官方活跃维护包;`lucide-vue-next` 已 deprecated

### 为什么 Widget 场景要单独一个 `widgetIcons.ts`

ProseMirror 的 Decoration/Widget 通过 `innerHTML` 注入 DOM(代码块工具栏、mermaid 工具栏、TOC 删除按钮),这些地方拿不到 Vue 组件实例,只能用字符串。把这些字符串集中到一个文件,而不是散落在各自的 .ts 里,目的是:
- 消除当前 `CodeHighlightWidget.ts` / `MermaidDecoration.ts` / `TocDecoration.ts` 三处各自复制 chevron / trash 的问题
- path 数据与 lucide 标准对齐时只改一处

`widgetIcons.ts` 里的字符串**只服务于 Widget innerHTML**,不暴露给 Vue 组件用(Vue 组件直接用 `@lucide/vue`)。

## 目录结构

```
src/components/icons/
└── widgetIcons.ts        # Widget innerHTML 专用的 SVG 工厂函数
```

不设 `Icon.vue` 包装组件、不设图标注册表——`@lucide/vue` 本身就是组件库,直接 `import { File } from '@lucide/vue'` 即可,再包一层只增加间接性。

## 图标映射表

### Vue 组件场景 → `@lucide/vue`

| 语义 | 组件 | 出现位置 |
|------|------|---------|
| 文件 | `File` | ActivityBar, FileTree, QuickOpenPanel, CommandPalette |
| 文件+加号(新建) | `FilePlusCorner` | FileActionsPanel, CommandPalette |
| 文件+放大镜(快速打开) | `FileSearch` | CommandPalette |
| 文件+向上箭头(打开) | `FileUp` | FileActionsPanel, CommandPalette |
| 文件夹 | `Folder` | FileTree |
| 文件夹打开 | `FolderOpen` | FileActionsPanel, CommandPalette |
| 图片 | `Image` | FileTree |
| 新窗口(Mac 风格) | `AppWindowMac` | FileActionsPanel, CommandPalette |
| 保存 | `Save` | FileActionsPanel, CommandPalette |
| 另存为 | `Upload` | FileActionsPanel, CommandPalette |
| 导出 | `Download` | FileActionsPanel, CommandPalette |
| 搜索/查找 | `Search` | App, ActivityBar, FindReplace, CommandPalette |
| 替换 | `Replace` | CommandPalette |
| 设置 | `Settings` | ActivityBar, CommandPalette |
| 源码(`<` `>` `/`) | `Code2` | StatusBar, CommandPalette |
| 预览(眼睛) | `Eye` | StatusBar |
| 关闭/清除(叉) | `X` | FindReplace, WorkspaceSearchPanel, EditorOutline |
| 上一个 | `ChevronUp` | FindReplace |
| 下一个 | `ChevronDown` | FindReplace, CommandPalette(展开替换栏) |
| 展开/折叠(右箭头) | `ChevronRight` | FileTree, EditorOutline, FindReplace(收起替换栏) |
| 最近文件(时钟) | `History` | RecentFilesButton, CommandPalette |
| 大纲 | `List` | ActivityBar, CommandPalette |
| 工作区文件(多文件夹) | `Folders` | ActivityBar, CommandPalette |
| 关闭工作区(文件夹+叉) | `FolderX` | CommandPalette |
| 切换工作区 | `FolderOpen` | CommandPalette |

> `save-as` / `export` 视觉匹配的是 `Upload` / `Download`(原项目就是抄的这两个 path),不是 `SaveAll` / `FileOutput`,迁移时保持视觉不变。

### Widget 字符串场景 → `widgetIcons.ts`

| 工厂函数 | 用途 | 调用点(尺寸) |
|---------|------|--------------|
| `chevronDownSvg(size)` | 代码块语言下拉、mermaid 收起 | CodeHighlightWidget(10), MermaidDecoration(14) |
| `chevronUpSvg(size)` | mermaid 展开 | MermaidDecoration(14) |
| `copySvg(size)` | 代码块复制 | CodeHighlightWidget(12) |
| `checkSvg(size)` | 代码块复制成功对勾(描边 2.5) | CodeHighlightWidget(12) |
| `trashSvg(size)` | mermaid 删除、TOC 删除 | MermaidDecoration(14), TocDecoration(16) |

`widgetIcons.ts` 导出工厂函数(非固定字符串),接受 `size` 参数返回完整 `<svg>` 字符串,消除同图标不同尺寸的重复。path 与 `@lucide/vue` 同名图标对齐。

## 使用方式

### Vue 组件

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

`@lucide/vue` 组件默认 `stroke="currentColor"`、`fill="none"`、`stroke-linecap="round"`、`stroke-linejoin="round"`,与原项目内联 SVG 的属性约定完全一致,颜色继承父元素 `color`,无需额外配置。

### Widget 字符串

```ts
import { trashSvg, copySvg } from '@/components/icons/widgetIcons'

const el = document.createElement('button')
el.innerHTML = trashSvg(14)
```

`widgetIcons.ts` 导出工厂函数,接受 `size` 参数返回完整 `<svg>...</svg>` 字符串,内部固定 `viewBox="0 0 24 24"` + lucide 描边约定。`checkSvg` 描边固定 2.5(对勾略粗增强确认感),其余为 2。

## 维护约定

- **新增图标**:先查 `@lucide/vue` 是否有同语义图标(https://lucide.dev 图标库可搜);有则直接 import,无则在 `widgetIcons.ts`(Widget 场景)或与维护者讨论是否自建
- **禁止新内联 SVG**:新代码里不许出现 `<svg` 标签或 SVG path 字符串,除非属于 `WindowControls.vue` 的 16×16 原生窗口按钮
- **图标尺寸**:通过 `:size` prop 传,不用 Tailwind `size-*` 类改 SVG 本身(原项目用 `size-4`/`size-5` 是因为内联 SVG 没有 size prop,迁移后统一用 prop)
- **stroke-width**:默认 2,需要更细的线条时显式传 `:stroke-width="1.5"`

## 相关文件

- `src/components/icons/widgetIcons.ts` — Widget SVG 工厂函数源
- `src/components/WindowControls.vue` — 例外,保留内联 SVG
- `package.json` — `@lucide/vue` 依赖

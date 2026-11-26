# 变更定位 Ruler（`#diff-ruler`）设计调研

> 目标：在版本历史 diff 视图右侧提供类似 VS Code Git diff overview ruler 的全局变更定位条，帮助用户在长文档中一眼掌握增 / 删 / 改分布，并通过点击色块或拖动滑块快速定位。
>
> 结论先说：**无需任何第三方依赖**；推荐采用 **「滚动条与 Ruler 合一（14px 单轨）+ 像素分桶轻 DOM 渲染 + 复用 `#diff-autoscroll` 的 `DiffAnchor`」** 方案。有变更时由 `DiffOverviewRuler` 直接承担滚动条与概览标尺双重职责，不出现双滚动条；配色采用低饱和半透明莫兰迪 / VS Code 语义色系，避免在灰白与暗黑底色上显得刺眼。

---

## 1. 背景与现状约束

阶段 1（`#diff-autoscroll`）已经建立了面向双模式的统一变更锚点模型 `DiffAnchor`（[diffAnchors.ts](../../src/utils/diffAnchors.ts)）：

```ts
export interface DiffAnchor {
  index: number
  kind: 'added' | 'removed' | 'modified'
  startRatio: number   // 0..1，变更在全文中的相对起点
  endRatio: number     // 0..1，变更在全文中的相对终点
  rowIndex?: number    // 源码模式起始行索引
  rowEndIndex?: number // 源码模式结束行索引（不含）
  from?: number        // 预览模式 PM doc pos 起点
  to?: number          // 预览模式 PM doc pos 终点
}
```

实现时需要处理现有 `DiffView` 的两个滚动容器现状：

1. **双滚动容器不统一**：
   - 源码模式的实际滚动容器是 `DiffView.vue` 外层的 `<div ref="sourceScrollRef">`；
   - 预览模式的实际滚动容器是 `WysiwygDiffView.vue` 内部的 `<div ref="scrollContainerRef" class="velo-wysiwyg-diff-container h-full overflow-y-auto">`，此时外层 `sourceScrollRef` 并不滚动。
2. **避免双滚动条**：`v-velo-scroll`（[veloScroll.ts](../../src/directives/veloScroll.ts)）隐藏原生滚动条并在容器右缘画 6px 浮动 `.velo-scroll-thumb`。如果在滚动容器旁再放一条带视口滑块的 ruler，画面右侧会同时出现两条可拖动的滚动条，既冗余又干扰操作。因此应采用 **VS Code 的滚动条与 ruler 合一形态**。

---

## 2. 候选渲染方案对比

| 维度 | A. 像素分桶 DOM `<div>`（推荐） | B. `<canvas>` 2D 绘制 | C. `<svg>` 矢量矩形 |
|---|---|---|---|
| **节点/绘制开销** | 典型文档 5–200 个 hunk 直接渲染；超密变更按 2–3px 像素桶合并，DOM 节点硬上限 `≤ trackHeight / 3`（~200 个内） | 单节点，任意数量 hunk 均为 O(N) 重绘 | 与 A 类似，但 SVG 元素样式与命中区略重 |
| **HiDPI 清晰度** | 原生矢量锐利，无需处理 `devicePixelRatio` 缩放 | 需监听 `ResizeObserver` + `devicePixelRatio` 手动重算画布尺寸与重绘 | 原生矢量锐利 |
| **主题联动** | 直接使用 CSS 变量，亮 / 暗模式切换零 JS 介入 | 需额外监听 `html.dark` class 变化触发 redraw | 支持 CSS 变量 |
| **交互命中** | 每个色块可直接绑定 `data-anchor-idx`、hover 反馈与点击事件 | 需手动反算鼠标 Y 坐标做命中检测 | 支持事件，但与 Tailwind 混用略繁琐 |
| **测试友好度** | Vitest + jsdom 原生可断言 DOM 结构、位置与点击事件 | jsdom 无内置 canvas 2D context，需额外 mock | jsdom 可测，但几何断言不如 HTML 直观 |
| **代码维护成本** | 最低（纯 Vue 组件） | 中等（需管理 canvas 生命周期、DPR、主题监听、命中检测） | 中低 |

**结论**：选 **方案 A（像素分桶 DOM `<div>`）**。Markdown 文档的 diff hunk 数量通常在个位数到两百以内，加上像素桶合并兜底可彻底防止极端大文档的节点膨胀，同时完整保留 CSS 变量主题联动与 jsdom 可测试性。

---

## 3. 坐标映射策略

### 3.1 真实 DOM 像素映射（源码 / 预览双模式统一）

早期估算曾考虑在预览模式直接复用 `doc pos / doc.content.size`；实测含大图、Mermaid 图表或长表格的文档时，单个图片节点仅占 1 字符 pos 却占数百像素高度，会导致 ruler 色块明显偏上、与滚动滑块错位；源码模式下长行自动折行也会产生轻微偏移。

因此双模式均以 **`DiffAnchor` 原始比例作兜底，并在真实布局后按 DOM 像素几何校正**：

- **预览模式（`WysiwygDiffView`）**：通过 `view.nodeDOM(pos)` 读取每个变更块的真实 `getBoundingClientRect()`（单容器块内局部改动优先取内部 diff 元素并集），换算为相对 `scrollContainer.scrollHeight` 的 `[startRatio, endRatio]`；挂载 `ResizeObserver` 监听 `.velo-diff-editor` 高度变化（图片异步加载 / Mermaid 渲染 / 窗口缩放），rAF 节流自动重测。
- **源码模式（`DiffView`）**：查询每个 hunk 首尾 `[data-diff-row-idx]` 行的真实上下边界并归一化到 `scrollHeight`，同样随窗口缩放自动重测。
- **零长度与极短锚点处理**：删除 widget 已挂载时取其真实高度，未挂载时按紧邻块顶部定位并保底最小可视高度 `4px`。

---

## 4. 滚动条与 Ruler 合一架构（结合点）

| 方案 | 形态 | 结论 |
|---|---|---|
| **方案 1：合一单轨（推荐，对齐 VS Code）** | 内容滚动区隐藏原生滚动条（也不渲染 `v-velo-scroll` 浮动 thumb），右侧 `14px` 轨道**同时作为滚动条与 overview ruler**；半透明灰色滑块（slider）叠在色块之上，拖动滑块即滚动文档，点击色块直接滚到对应变更 | **推荐**。彻底消除双滚动条，视觉与交互最自然，源码 / 预览双模式完全一致 |
| **方案 2：滚动条 + 独立 ruler 双轨** | 内容区保留 `v-velo-scroll` 浮动 thumb，右侧再并排一条带视口框的 ruler | 废弃。右侧并存两条可拖动滚动条，视觉冗余且操作割裂 |

**架构结合点**：

1. **隐藏内容区自带滚动条**：源码模式的 `sourceScrollRef` 与预览模式的 `.velo-wysiwyg-diff-container` 统一隐藏原生滚动条（`scrollbar-width: none` / `::-webkit-scrollbar { display: none }`），不再在 `DiffView` 内挂载 `v-velo-scroll` 的浮动 thumb，由右侧单一 `DiffOverviewRuler` 接管滚动条职责（无变更或 loading 时退化为极简纯滚动条，不画色块，或仅在需要滚动时显示滑块）。
2. **统一滚动容器引用**：源码模式直接传 `sourceScrollRef`；预览模式由 `WysiwygDiffView` 通过 `defineExpose` 暴露 `scrollContainerRef`（或 `getScrollElement()`），`DiffOverviewRuler` 统一监听当前容器的 `scroll` 与 `ResizeObserver`。
3. **层级与事件分工（VS Code 风格）**：
   - 底层：变更色块（可点击跳转，支持按 `modified / removed / added` 分 3 条细轨并排，避免相邻异类变更互相遮挡）；
   - 上层：半透明圆角灰色滚动滑块（`rgba` 透出下方色块，风格与 VS Code 一致）；按下滑块可顺滑拖拽滚动，点击非滑块位置的色块直接跳转到对应锚点，点击空白轨道则按位置滚动。

---

## 5. 视觉语义与低饱和配色（最终采纳方案）

采用 **Primer 低饱和双色系（绿增 + 红删）**，取消预览模式中的琥珀色：格式变更与节点类型变更统一改为「删旧 + 增新」，使预览正文与右侧 ruler 视觉高度统一；源码模式维持原有配色不变。

| 角色 | 亮色背景 | 暗色背景 |
|---|---|---|
| **Ruler 新增（右轨）** | `rgba(45, 164, 110, 0.52)` | `rgba(68, 178, 128, 0.58)` |
| **Ruler 删除（左轨）** | `rgba(214, 86, 98, 0.52)` | `rgba(220, 98, 108, 0.60)` |
| **Ruler 滚动滑块 (Thumb)** | `rgba(120, 125, 132, 0.22)`（悬停 `0.36`） | `rgba(154, 160, 168, 0.26)`（悬停 `0.42`） |
| **预览正文新增线/框** | `#389e6d` | `#52b486` |
| **预览正文删除字 / 线** | `#be5863` / `rgba(214, 86, 98, 0.58)` | `#d2767e` / `rgba(220, 98, 108, 0.65)` |

### 轨道排布与交互细节

- **24px 两轨制（对齐 VS Code）**：`24px` 轨道内部采用左右两轨（左轨 `left: 3px; width: 8px`：删除柔红；右轨 `left: 13px; width: 8px`：新增柔绿），同一 hunk 同时包含增删时左右两轨同时落块，互不遮挡。
- **克制交互**：hover 色块不变色；点击色块无蓝色焦点框，直接平滑滚动到位并同步顶部 `n/N` 计数器；拖动滑块或点击空白轨道滚动时不改写 `activeAnchorIndex`。
- **无变更时表现**：`!hasAnchors` 时隐藏 ruler，不留空白轨道。

---

## 6. 第三方依赖评估

**不引入任何第三方依赖**。全部能力基于现有 Vue 3 响应式、`ResizeObserver`、原生 pointer 事件及阶段 1 的 `DiffAnchor` 模型实现，零包体积与维护负担。

---

## 7. 风险点与边界情况

1. **预览模式 `scrollHeight` 动态漂移**：图片异步加载、Mermaid 延迟渲染或代码块折叠会改变 `scrollHeight`。需用 `ResizeObserver` 同时观测滚动容器与其内部 `.ProseMirror` 内容节点，变化时用 rAF 节流重算滑块高度与位置。
2. **滑块与色块的点击冲突**：滑块在色块上方时，若用户想点击被滑块盖住的色块——实际体验中该色块**已在当前视口内**，用户无需再跳；若用户点击滑块外任意色块则立即跳转；按下滑块本身优先响应拖拽滚动（与 VS Code 一致）。
3. **拖拽出界与文字误选**：拖动滑块或轨道时使用 `setPointerCapture`（或 `window` 级监听）并设 `select-none`，避免鼠标移出 14px 窄轨后拖拽中断或误选中正文文字。
4. **切模式 / 切版本条目重置**：切换源码 ↔ 预览或选中不同历史版本时，需解绑旧滚动容器监听并绑定新容器，同步刷新滑块状态。

---

## 8. 推荐路线

1. 抽象独立组件 `DiffOverviewRuler.vue`，承担「统一滚动条 + 变更概览标尺」职责，接收 `anchors: DiffAnchor[]`、`scrollElement: HTMLElement | null`，向上 emit `select(index: number)`。
2. `DiffView.vue` 移除外层 `v-velo-scroll` 改用隐藏原生滚动条的统一 Flex 布局（左滚动区 + 右 14px `DiffOverviewRuler`），`WysiwygDiffView.vue` 同步隐藏原生滚动条并暴露 `scrollContainerRef`。
3. 采用低饱和莫兰迪 / VS Code 语义色板 + 三列微轨布局 + 无蓝框纯滚动跳转，零第三方依赖。

<script setup lang="ts">
import { ref } from 'vue'
import { X, Plus } from '@lucide/vue'
import { useDocumentStore } from '@/stores/document'

const documentStore = useDocumentStore()

async function onClose(id: string) {
  await documentStore.closeTab(id)
}

// ===== 拖拽重排(v0.6.x) =====
// HTML5 native draggable,与 FileTree 内部 move 同款范式(dragDropEnabled:false)。
// dataTransfer 仅承载 tab id(MIME 同名);实际重排用本地 draggingId 判定,
// 避免读不到自定义 MIME 时被外部拖拽误识别(同 webview 内的 drag 事件只有自家来源)。
//
// dropTarget 设计:不指向「鼠标所在 tab」,而是指向「该落点的伪元素归属 tab +
// 哪一侧伪元素」。这样 drop 指示器和 divider 永远落在同一个伪元素上 ——
// 激活 drop 时 divider 自然被同位覆盖,**物理上不可能出现两条线**。
//   - side='before' → 目标 tab 的 ::before(divider 位置)
//   - side='after'  → 目标 tab 的 ::after(末尾 divider 位置,仅最后一个 tab)

const draggingId = ref<string | null>(null)
const dropTarget = ref<{ tabId: string, side: 'before' | 'after' } | null>(null)

function onDragStart(event: DragEvent, id: string) {
  if (!event.dataTransfer) return
  event.dataTransfer.setData('application/x-velo-tab-id', id)
  event.dataTransfer.effectAllowed = 'move'
  draggingId.value = id
}

/** 鼠标在 tab 上 → 重映射到「divider 落点」(下一个 tab 的 ::before / 当前 tab 的 ::after / 当前 tab 的 ::before)。
 *  关键:drop 指示器始终落在「已经有 divider 的伪元素」上 — divider 与 drop 互斥,同一伪元素同时刻只一种状态。 */
function onDragOver(event: DragEvent, tabId: string) {
  if (draggingId.value === null) return
  if (draggingId.value === tabId) {
    // 拖到自己头上 → 清掉 drop 指示(不与自身重排)
    dropTarget.value = null
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const el = event.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  const isAfter = event.clientX - rect.left > rect.width / 2
  if (isAfter) {
    // 「after X」→ 重映射到下一个 tab 的 ::before(那里是 divider);X 是最后一个时落到 X 自己的 ::after
    const idx = documentStore.tabs.findIndex(t => t.id === tabId)
    const nextTab = documentStore.tabs[idx + 1]
    if (nextTab) {
      dropTarget.value = { tabId: nextTab.id, side: 'before' }
    }
    else {
      dropTarget.value = { tabId, side: 'after' }
    }
  }
  else {
    // 「before X」→ 直接用 X 自己的 ::before
    dropTarget.value = { tabId, side: 'before' }
  }
}

function onDragLeave(_tabId: string) {
  // 不可信:子元素冒泡也会触发 → 用 dragend 全局兜底清
}

function onTabDrop(event: DragEvent) {
  event.preventDefault()
  const fromId = draggingId.value
  const target = dropTarget.value
  if (fromId && target) {
    documentStore.reorderTabs(fromId, target.tabId, target.side)
  }
  resetDragState()
}

function onDragOverNewTab(event: DragEvent) {
  if (draggingId.value === null) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  // + 按钮 = 「after last tab」= 最后一个 tab 的 ::after(那里有 tab-divider-right)
  const tabs = documentStore.tabs
  const last = tabs[tabs.length - 1]
  if (last && last.id !== draggingId.value) {
    dropTarget.value = { tabId: last.id, side: 'after' }
  }
}

function onDropToEnd(event: DragEvent) {
  event.preventDefault()
  // 共用 onTabDrop 的逻辑:dropTarget 已经被 onDragOverNewTab 设好
  onTabDrop(event)
}

function onDragEnd() {
  resetDragState()
}

function resetDragState() {
  draggingId.value = null
  dropTarget.value = null
}
</script>

<template>
  <div class="flex h-full min-w-0 flex-1 items-stretch pl-3 border-b border-gray-200 dark:border-gray-800">
    <div class="tab-bar flex min-w-0 items-end">
      <div
        v-for="(tab, i) in documentStore.tabs"
        :key="tab.id"
        class="tab group"
        :class="{
          'tab-active': tab.active,
          'tab-divider': i > 0 && !tab.active && !documentStore.tabs[i - 1].active,
          'tab-divider-right': i === documentStore.tabs.length - 1 && !tab.active,
          'tab-dragging': draggingId === tab.id,
          'tab-drop-before': dropTarget?.tabId === tab.id && dropTarget.side === 'before',
          'tab-drop-after': dropTarget?.tabId === tab.id && dropTarget.side === 'after',
        }"
        role="tab"
        :aria-selected="tab.active"
        :title="tab.fileName + (tab.dirty ? ' •' : '')"
        tabindex="0"
        draggable="true"
        @click="documentStore.switchTab(tab.id)"
        @auxclick.middle.prevent="onClose(tab.id)"
        @keydown.enter="documentStore.switchTab(tab.id)"
        @dragstart="onDragStart($event, tab.id)"
        @dragover="onDragOver($event, tab.id)"
        @dragleave="onDragLeave(tab.id)"
        @drop="onTabDrop($event)"
        @dragend="onDragEnd"
      >
        <div class="tab-content flex w-full items-center gap-1">
          <span class="tab-dot" :class="{ 'tab-dot-on': tab.dirty }" />
          <span class="tab-title">{{ tab.fileName }}</span>
          <button
            type="button"
            class="tab-close"
            :title="`关闭 ${tab.fileName}`"
            @click.stop="onClose(tab.id)"
          >
          <X :size="13" />
          </button>
        </div>
      </div>

      <button
        type="button"
        class="tab-new"
        title="新标签 (Ctrl+N)"
        @click="documentStore.newDoc()"
        @dragover="onDragOverNewTab"
        @drop="onDropToEnd"
      >
        <Plus :size="15" />
      </button>
    </div>
    <!-- 拖拽区(填满标签右侧空白);标签溢出时缩到 0 -->
    <span data-tauri-drag-region class="flex-1" />
  </div>
</template>

<style scoped lang="scss">

/* 默认宽 200px;溢出时 flex-shrink 等比压缩至 min-width 80px。
 * 非活动标签无边框,仅相邻两个非活动标签之间用竖线分隔(类右上角三件套)。
 * hover 高亮落在内层 .tab-content(.tab 留 2px padding 作间隔,呈内嵌灰块);
 * 活动标签 bg 在 .tab 上铺满到底,与编辑器衔接。 */
.tab {
  position: relative;
  display: inline-flex;
  height: 32px;
  padding: 1px 4px 4px 4px;                      /* 与内层 content 的 2px 间隔 */
  flex: 0 1 auto;
  width: 200px;
  min-width: 80px;
  margin-bottom: -1px;
  border: 1px solid transparent;   /* 占位边框:活动态只切颜色不切宽度,避免切换时内容 ~1px 抖动 */
  background: transparent;
  color: rgb(107 114 128);           /* gray-500 */
  user-select: none;
  // transition: background-color 100ms ease, color 100ms ease; 

  /* hover 只作用于非活动标签的内层 content(活动标签已高亮,不再变色) */
  &:not(.tab-active):hover .tab-content {
    background: rgb(229 231 235);    /* gray-200 */
    color: rgb(55 65 81);            /* gray-700 */
  }

  /* 竖线分隔(短竖线 h-5 / w-px,垂直居中,不与栏底 border 相接):
   * 左 ::before — 相邻两个非活动标签之间;
   * 右 ::after  — 末尾非活动标签与 + 按钮之间。
   *
   * ::before / ::after 改常驻(默认透明),divider / drop indicator 复用同一对
   * 锚点 — 单一 indicator、不进 flex 流、不撑开布局、X 不漂移。 */
  &::before,
  &::after {
    content: '';
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 1px;
    height: calc(var(--spacing) * 5);    /* h-5 */
    border-radius: 1px;
    background: transparent;
    pointer-events: none;
  }
  &::before { left: 0; }
  &::after { right: 0; }
  &.tab-divider::before,
  &.tab-divider-right::after {
    background: rgb(229 231 235);      /* gray-200 */
  }

  /* 活动标签:bg 铺满 .tab(含 padding)到底,覆盖容器 border-b 与编辑器连成一片 */
  &.tab-active {
    background: #fff;
    color: rgb(31 41 55);            /* gray-800 */
    border-color: rgb(229 231 235);  /* gray-200 占位边框可见色(基础 .tab 透明边框盖过 Tailwind border class) */
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
    border-bottom-color: #fff;       /* 覆盖容器 border-b,与编辑器衔接 */
    transition: none;
  }

  /* 拖拽源:半透明(原生 dragstart ghost 已自管,这里标的是「起点 tab」本体) */
  &.tab-dragging {
    opacity: 0.5;
  }

  /* 拖入位置指示器:复用 divider 同一对 ::before / ::after,蓝 2px 覆盖在 divider 位置。
   * 定义顺序在 .tab-divider 之后 → 同 specificity 时定义晚的胜出,divider 与 drop 同存时
   * drop 优先(实际不会同存,drop 触发的 tab 同一时刻只有一个 before / after)。 */
  &.tab-drop-before::before,
  &.tab-drop-after::after {
    background: rgb(59 130 246);     /* blue-500 */
    width: 2px;
  }

  /* draggable 元素:grab cursor;拖拽中变 grabbing */
  &[draggable="true"] {
    cursor: grab;
  }
  &.tab-dragging {
    cursor: grabbing;
  }
}

/* 内层 content:hover 时变灰,内嵌于 .tab 的 2px padding 之内;顶部半径随外层略收 */
.tab-content {
  padding: 0 0.5rem;
  border-radius: 6px;
  transition: background-color 100ms ease;
}

.tab-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

/* 脏盘小圆点:默认占位(保持标题宽度稳定不跳),dirty 时填色 */
.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: transparent;
  &.tab-dot-on {
    background: rgb(245 158 11);     /* amber-500 */
  }
}

/* 关闭按钮:hover 标签时显示;活动标签常显。点击关闭(脏盘走 store 内 confirm) */
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: inherit;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 100ms ease, background-color 100ms ease;
}
.tab:hover .tab-close,
.tab-active .tab-close {
  opacity: 0.6;
}
.tab-close:hover {
  opacity: 1 !important;
  background: rgb(229 231 235);       /* gray-200 */
}

/* 新标签 + 按钮 */
.tab-new {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  margin-left: 4px;
  margin-bottom: 4px;
  color: rgb(156 163 175);          /* gray-400 */
  border-radius: 4px;
  transition: background-color 100ms ease, color 100ms ease;
  &:hover {
    background: rgb(243 244 246);    /* gray-100 */
    color: rgb(55 65 81);           /* gray-700 */
  }
}

/* 暗色:非活动 tab 透明显 #111 标题栏底;活动 tab 铺 #1e1e1e 与编辑器衔接。
 * 必须 .dark .xxx,不能 :global(.dark) .xxx — scoped 下 :global(.dark) .tab 会编译成
 * 裸 .dark{}(后代 .tab 被吞),规则落到根 div 上完全不命中;改用 .dark .tab 后只末位 .tab
 * 加 [data-v],.dark 保持全局命中根 div 的 .dark 类。 */
.dark .tab {
  color: rgb(156 163 175);          /* gray-400 */
  &:not(.tab-active):hover .tab-content {
    background: rgb(38 38 38);
    color: rgb(209 213 219);        /* gray-300 */
  }
  &.tab-divider::before,
  &.tab-divider-right::after {
    background: rgb(55 65 81);         /* gray-700 */
  }
  /* 暗色 drop 指示:更亮的 blue-400 在 #1e1e1e 上对比足够 */
  &.tab-drop-before::before,
  &.tab-drop-after::after {
    background: rgb(96 165 250);       /* blue-400 */
  }
  &.tab-active {
    background: #1e1e1e;            /* 编辑器暗底,与编辑器衔接 */
    color: rgb(229 231 235);        /* gray-200 */
    border-color: rgb(31 41 55);    /* gray-800 框 */
    border-bottom-color: #1e1e1e;   /* 覆盖容器 border-b */
  }
}
.dark .tab-close:hover {
  background: rgb(55 65 81);         /* gray-700 */
}
.dark .tab-dot-on {
  background: rgb(251 191 36);       /* amber-400 */
}
.dark .tab-new:hover {
  background: rgb(38 38 38);
  color: rgb(209 213 219);          /* gray-300 */
}
</style>

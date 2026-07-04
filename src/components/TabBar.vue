<script setup lang="ts">
import { X, Plus } from '@lucide/vue'
import { useDocumentStore } from '@/stores/document'

const documentStore = useDocumentStore()

async function onClose(id: string) {
  await documentStore.closeTab(id)
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
        }"
        role="tab"
        :aria-selected="tab.active"
        :title="tab.fileName + (tab.dirty ? ' •' : '')"
        tabindex="0"
        @click="documentStore.switchTab(tab.id)"
        @auxclick.middle.prevent="onClose(tab.id)"
        @keydown.enter="documentStore.switchTab(tab.id)"
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
   * 右 ::after  — 末尾非活动标签与 + 按钮之间 */
  &.tab-divider::before,
  &.tab-divider-right::after {
    content: '';
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 1px;
    height: calc(var(--spacing) * 5);    /* h-5 */
    background: rgb(229 231 235);      /* gray-200 */
    pointer-events: none;
  }
  &.tab-divider::before { left: 0; }
  &.tab-divider-right::after { right: 0; }

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
 * ⚠️ 必须 .dark .xxx,不能 :global(.dark) .xxx — scoped 下 :global(.dark) .tab 会编译成
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

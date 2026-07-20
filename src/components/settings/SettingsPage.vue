<script setup lang="ts">
// 设置页主组件（#settings-panel 重做）
//
// 接管编辑器主区域。左导航(分组列表)复用 EditorOutline 的虚拟模式渲染在
// 左侧功能区大纲位置,设置激活时点开大纲看到的就是设置分类 —— 避免设置页
// 显示上一个文档的大纲造成误导。
//
// **流式布局**:所有分组在一个可纵向滚动的容器里依次排列(类似 macOS 系统设置 /
// GitHub settings)。左侧大纲点击 → scrollToGroup 平滑滚动到对应分区;
// 滚动 → scroll-spy 实时回写当前可视分组到大纲高亮。用户也可不依赖大纲,
// 直接上下滚动浏览所有设置。
//
// 分组来源:registry.ts 的 getSettingsGroups()(由 registerGroups.ts 注册内置 4 组,
// 未来新设置项只需注册一行)。本组件不硬编码任何分组,纯靠 registry 驱动渲染。
//
// activeGroupId 状态提升到 App.vue:SettingsPage scroll-spy emit update → App.vue
// 更新 ref → 侧栏 EditorOutline(虚拟模式)activeKey 变 → 大纲高亮跟随。
// 反向:大纲点击 → App.vue 调 settingsPageRef.scrollToGroup → 平滑滚动。
//
// 关闭/失活途径(两态):设置 tab 可后台保留,切文档 tab 只失活不关闭。
//   彻底关闭(X / 中键)→ TabBar emit('close-settings') → App.vue closeSettings()
//   失活(Escape / 切文档 tab / ActivityBar toggle)→ settingsActive=false,tab 保留
//   Escape 由本组件 emit('close') → App.vue 设 settingsActive=false(不关 settingsOpen)。

import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { getSettingsGroups } from './registry'

const props = defineProps<{
  /** 当前高亮分组 id(scroll-spy 驱动;大纲点击时 App.vue 先即时赋值再 scrollToGroup)。 */
  activeGroupId: string
}>()
const emit = defineEmits<{
  'close': []
  /** scroll-spy 检测到滚动使可视分组变化时触发,App.vue 据此更新 settingsActiveGroupId。 */
  'update:activeGroupId': [id: string]
}>()

const groups = computed(() => getSettingsGroups())

// ========== 滚动容器 + 分区锚点 ==========
// 每个分组包一层 div[data-group-id],scroll-spy 和 scrollToGroup 都靠它定位。
const scrollRef = ref<HTMLElement | null>(null)
const sectionRefs = ref<Record<string, HTMLElement | null>>({})

function setSectionRef(id: string) {
  return (el: Element | ComponentPublicInstance | null) => {
    sectionRefs.value[id] = (el as HTMLElement | null) ?? null
  }
}

// ========== Scroll-spy:跟踪滚动位置,回写当前可视分组 ==========
let scrollRafId: number | null = null
// 防止 scrollToGroup 触发的滚动与 scroll-spy 互相干扰:
// 程序滚动期间允许 scroll-spy 自然更新(平滑滚动过程中高亮跟随是期望行为),
// 无需特殊抑制 —— smooth scroll 的中间态高亮符合直觉。

function findActiveGroup(): string | null {
  const container = scrollRef.value
  if (!container) return null
  const rect = container.getBoundingClientRect()
  // 视口顶线往下 24px 算作当前分区分界线(给标题留呼吸空间)
  const threshold = rect.top + 24

  let activeId: string | null = null
  for (const g of groups.value) {
    const el = sectionRefs.value[g.id]
    if (!el) continue
    if (el.getBoundingClientRect().top <= threshold) {
      activeId = g.id
    } else {
      break
    }
  }
  // 滚到最顶端时回退到首个分组(避免空白高亮)
  if (!activeId && groups.value[0]) {
    activeId = groups.value[0].id
  }
  return activeId
}

function onScroll() {
  if (scrollRafId !== null) return
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = null
    const id = findActiveGroup()
    if (id && id !== props.activeGroupId) {
      emit('update:activeGroupId', id)
    }
  })
}

// ========== 暴露给 App.vue:大纲点击 → 平滑滚动到对应分组 ==========
function scrollToGroup(id: string) {
  const el = sectionRefs.value[id]
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

defineExpose({ scrollToGroup })

// ========== Escape 关闭设置页 ==========
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  // 初始高亮首个分组(与 App.vue 默认值一致;scroll-spy 兜底)
  nextTick(() => {
    const id = findActiveGroup()
    if (id) emit('update:activeGroupId', id)
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId)
    scrollRafId = null
  }
})
</script>

<template>
  <!-- 右内容:居中限宽,纵向滚动(流式:所有分组依次排列)。顶栏由 TabBar 的设置 tab 承担,
       分组列表在侧栏 EditorOutline(虚拟模式)。flex-1 + min-w-0 确保侧栏开合时内容区被
       "压缩"而非被"推动"(见 file-tree.md min-w-0 链)。 -->
  <div class="flex h-full min-w-0 flex-1 overflow-hidden bg-white dark:bg-[#1e1e1e]">
    <div ref="scrollRef" v-velo-scroll class="min-w-0 flex-1 overflow-y-auto" @scroll.passive="onScroll">
      <div class="mx-auto max-w-2xl px-8 py-6">
        <!-- 所有分组依次排列,每个分组包一层带锚点的 div 供 scroll-spy / scrollToGroup 定位。
             scroll-mt-6:scrollIntoView 时给标题留 24px 呼吸空间,不顶到容器最上沿。 -->
        <div
          v-for="(group, index) in groups"
          :key="group.id"
          :ref="setSectionRef(group.id)"
          :data-group-id="group.id"
          :class="index > 0 ? 'mt-16 border-t border-gray-200 pt-16 dark:border-gray-700' : ''"
          class="scroll-mt-6"
        >
          <component :is="group.component" />
        </div>
      </div>
    </div>
  </div>
</template>

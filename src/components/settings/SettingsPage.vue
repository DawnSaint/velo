<script setup lang="ts">
// 设置页主组件（#settings-panel 重做）
//
// 接管编辑器主区域。顶部 Tab 切换设置类目（编辑器 / 外观 / 文档 / 系统），
// 所有分组同时挂载（v-show 切换可见性），让搜索索引能覆盖未激活分组的设置项。
//
// 分组来源:registry.ts 的 getSettingsGroups()(由 registerGroups.ts 注册内置 4 组,
// 未来新设置项只需注册一行)。本组件不硬编码任何分组,纯靠 registry 驱动渲染。
//
// activeGroupId 状态提升到 App.vue:Tab 点击 → emit update:activeGroupId →
// App.vue 更新 ref → 本组件 prop 变化 → 切换显示的分组。状态在 App.vue
// 保证设置失活再激活后能记住上次选中的类目。
//
// 关闭/失活途径(两态):设置 tab 可后台保留,切文档 tab 只失活不关闭。
//   彻底关闭(X / 中键)→ TabBar emit('close-settings') → App.vue closeSettings()
//   失活(Escape / 切文档 tab / ActivityBar toggle)→ settingsActive=false,tab 保留
//   Escape 由本组件 emit('close') → App.vue 设 settingsActive=false(不关 settingsOpen)。

import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { getSettingsGroups } from './registry'
import SettingsGroupWrapper from './SettingsGroupWrapper.vue'
import SettingsSearchBox from './SettingsSearchBox.vue'
import { useSettingsSearchIndex, type SettingsSearchEntry } from '@/composables/useSettingsSearchIndex'

const props = defineProps<{
  /** 当前激活的设置分组 id(Tab 切换驱动)。 */
  activeGroupId: string
}>()
const emit = defineEmits<{
  'close': []
  /** Tab 点击切换分组时触发,App.vue 据此更新 settingsActiveGroupId。 */
  'update:activeGroupId': [id: string]
}>()

const groups = computed(() => getSettingsGroups())

const activeGroup = computed(() =>
  groups.value.find(g => g.id === props.activeGroupId) ?? groups.value[0],
)

function onSelectGroup(id: string) {
  if (id !== props.activeGroupId) {
    emit('update:activeGroupId', id)
  }
}

// ========== 搜索索引 ==========
// groupTitleMap 供搜索结果展示分组标题；register/unregister 经 provide 注入
// 各 <SettingsItem>，SettingsItem 在 onMounted 时自动登记自身。
const groupTitleMap = computed(() => {
  const m = new Map<string, string>()
  for (const g of groups.value) m.set(g.id, g.title)
  return m
})
const { register, unregister, search } = useSettingsSearchIndex(groupTitleMap.value)

provide('settingsSearchRegister', register)
provide('settingsSearchUnregister', unregister)

// 搜索选中：切分组 + 滚动到目标设置项 + 短暂高亮
function onSearchSelect(entry: SettingsSearchEntry) {
  if (entry.groupId !== props.activeGroupId) {
    emit('update:activeGroupId', entry.groupId)
  }
  // 等分组 v-show 切换 + DOM 更新后定位
  nextTick(() => {
    const el = document.querySelector<HTMLElement>(`[data-settings-item="${entry.id}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('velo-settings-hit')
    setTimeout(() => el.classList.remove('velo-settings-hit'), 1500)
  })
}

// ========== Tab 激活下划线滑动动效 ==========
// 单一下划线元素根据当前激活 Tab 的 DOM 位置(left/width)滑动,
// CSS transition 驱动平滑过渡,无需手动 rAF。
const tabRefs = ref<HTMLElement[]>([])
const underlineLeft = ref(0)
const underlineWidth = ref(0)

function updateUnderline() {
  const idx = groups.value.findIndex(g => g.id === props.activeGroupId)
  if (idx === -1) return
  const el = tabRefs.value[idx]
  if (!el) return
  underlineLeft.value = el.offsetLeft
  underlineWidth.value = el.offsetWidth
}

onMounted(() => {
  nextTick(() => updateUnderline())
})
watch(() => props.activeGroupId, () => {
  nextTick(() => updateUnderline())
})

// ========== Escape 关闭设置页 ==========
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <!-- 右内容:顶部 Tab 栏 + 分组内容(所有分组 v-show 共存,纵向滚动)。顶栏由 TabBar 的设置 tab 承担。
       flex-1 + min-w-0 确保侧栏开合时内容区被"压缩"而非被"推动"(见 file-tree.md min-w-0 链)。 -->
  <div class="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface-2)]">
    <!-- 分组内容:居中限宽,纵向滚动,所有分组同时挂载(v-show 切换可见性),
         让搜索索引覆盖未激活分组的设置项。Tab 栏放内容容器顶部(取代各分组组件
         的 h2 标题),靠左摆放,下划线宽度与内容区一致(max-w-2xl)。 -->
    <div v-velo-scroll class="min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-2xl px-8 py-12">
        <!-- Tab 栏:每个分组一个 Tab,点击切换类目。下划线为单一带 transition 的元素,
             根据 activeGroupId 变化滑动到对应 Tab 位置。搜索框放右侧空白处。 -->
        <div class="relative flex items-center gap-1 border-b border-[var(--surface-border)] pb-2">
          <button
            v-for="(group, idx) in groups"
            :key="group.id"
            :ref="el => { if (el) tabRefs[idx] = el as HTMLElement }"
            class="relative px-3 py-1.5 text-sm transition-colors"
            :class="group.id === activeGroup?.id
              ? 'font-medium text-gray-900 dark:text-gray-100'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
            @click="onSelectGroup(group.id)"
          >
            {{ group.title }}
          </button>
          <!-- 激活下划线:单一元素,transition 驱动滑动。bottom-0 让下划线紧贴 border 线 -->
          <span
            class="absolute bottom-0 h-0.5 transition-all duration-200 ease-out"
            :style="{
              left: `${underlineLeft}px`,
              width: `${underlineWidth}px`,
              backgroundColor: 'var(--md-primary-color, #1F71D9)',
            }"
          />
          <SettingsSearchBox :search="search" @select="onSearchSelect" />
        </div>

        <!-- 所有分组同时挂载（v-show 切换），让搜索索引覆盖未激活分组。
             设置分组都是轻量表单控件，全量挂载零性能压力。 -->
        <SettingsGroupWrapper
          v-for="group in groups"
          v-show="group.id === activeGroup?.id"
          :key="group.id"
          :group-id="group.id"
        >
          <component :is="group.component" />
        </SettingsGroupWrapper>
      </div>
    </div>
  </div>
</template>

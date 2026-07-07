<script setup lang="ts">
// 代码块语言选择浮层。
//
// 触发:CodeHighlightWidget 工具条上的 "选择语言" 按钮 click →
// 冒泡 CustomEvent('velo:open-lang-picker', { detail: { pos, lang, anchor } })。
// ProseMirrorEditor/index.vue 监听这个事件 → 调 open() 显示浮层。
//
// 关闭:Esc / 点 backdrop / 选中语言。
// 焦点:不抢 ProseMirror 焦点;open() 不 focus input(克制);close() 也不
// focus 回 ProseMirror —— 用户自己点编辑器继续编辑。

import { computed, onBeforeUnmount, ref } from 'vue'
import type { EditorView } from 'prosemirror-view'
import { LANG_OPTIONS } from './nodes/CodeBlockLangs'
import { setCodeBlockLanguage } from './nodes/CodeHighlightWidget'
import { langIconSvg } from './nodes/langIcons'

const props = defineProps<{
  /** 当前 EditorView(从父级 innerRef.getEditorView() 拿)。 */
  view: EditorView | null
}>()

const open = ref(false)
const pos = ref<number | null>(null)
const currentLang = ref('')
const filter = ref('')
const anchor = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

const filtered = computed(() => {
  const q = filter.value.toLowerCase().trim()
  if (!q) return LANG_OPTIONS
  return LANG_OPTIONS.filter((l) => {
    if (l === '') return q === 'plain' || q === 'text' || q === 'plaintext'
    return l.toLowerCase().includes(q)
  })
})

// 选项里是否有精确匹配(大小写无关)。无匹配 → 回车把 query 当自定义 lang 应用
const hasExactMatch = computed(() => {
  const q = filter.value.trim()
  if (!q) return true
  return LANG_OPTIONS.some(l => l.toLowerCase() === q.toLowerCase())
})

// 浮层位置用 ref 而非 computed —— scroll / resize 时需要主动 updatePosition
// 重算;computed 只在依赖变化时跑,scroll 不算 anchor ref 变化,会脱锚。
const panelStyle = ref<Record<string, string>>({ display: 'none' })

function updatePosition() {
  const a = anchor.value
  if (!a || !open.value) {
    panelStyle.value = { display: 'none' }
    return
  }
  const rect = a.getBoundingClientRect()
  const margin = 4
  const PANEL_W = 180

  const top = rect.bottom + margin
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_W - 8)
  panelStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    zIndex: '9999',
  }
}

// header widget 联动:浮层打开时给对应的 widget 加 .velo-lang-picker-open
// (header 始终可见,此 class 目前无 CSS 效果,保留以备将来需要)。
// anchor(trigger 按钮)是 widget 的子节点,closest 一层就能拿到。
function markWidgetOpen(on: boolean) {
  const w = anchor.value?.closest('.velo-code-header-widget') as HTMLElement | null
  if (!w) return
  w.classList.toggle('velo-lang-picker-open', on)
}

/** 父级调这个方法打开。同 pos 重复点 → 当 close 处理(避免开两次浪费);异
 *  pos 走"先关再开"语义,确保旧 panel 完全卸载(backdrop click 监听)再挂新。 */
function openPicker(payload: { pos: number, lang: string, anchor: HTMLElement }) {
  if (open.value && pos.value === payload.pos) {
    close()
    return
  }
  if (open.value) {
    // 异 pos:先摘旧监听,再装新(保证 backdrop 旧 panel 干净卸载)
    teardownListeners()
    markWidgetOpen(false)
    open.value = false
  }
  pos.value = payload.pos
  currentLang.value = payload.lang
  anchor.value = payload.anchor
  filter.value = ''
  open.value = true
  // 等 panel 挂到 DOM 后(下一帧)再算位置 —— 此时 anchor 已是稳定
  requestAnimationFrame(() => {
    updatePosition()
    setupListeners()
    markWidgetOpen(true)
    // 浮层挂好后立刻 focus 输入框,方便直接打字
    panelEl.value?.querySelector<HTMLInputElement>('.velo-lang-filter')?.focus()
  })
}

function close() {
  if (!open.value) return
  markWidgetOpen(false)
  open.value = false
  teardownListeners()
  pos.value = null
  anchor.value = null
  filter.value = ''
  panelStyle.value = { display: 'none' }
}

function setupListeners() {
  // capture:scroll 包含编辑器内部 scroll 容器,不等冒泡
  window.addEventListener('scroll', updatePosition, { capture: true, passive: true })
  window.addEventListener('resize', updatePosition)
  // 点编辑器内非浮层区域 → 关闭。装在 capture,事件源不在 panel 内就走关闭
  document.addEventListener('mousedown', onDocMouseDown, true)
}

function teardownListeners() {
  window.removeEventListener('scroll', updatePosition, { capture: true } as any)
  window.removeEventListener('resize', updatePosition)
  document.removeEventListener('mousedown', onDocMouseDown, true)
}

function onDocMouseDown(e: MouseEvent) {
  const t = e.target as Node | null
  if (!t) return
  // 点在浮层内部 → 不关(由 panel/li 自己处理)
  if (panelEl.value?.contains(t)) return
  // 点在 trigger 按钮上 → 让 openPicker 处理(同 pos close / 异 pos 换)
  if (anchor.value?.contains(t)) return
  close()
}

// 输入框回车 → 应用过滤后的第一项;无精确匹配则把 query 当自定义 lang
function onFilterKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const q = filter.value.trim()
    if (!q) {
      // 空输入回车 → 恢复空(plain text)
      pickLang('')
      return
    }
    // 优先精确匹配(大小写无关),否则过滤结果第一项,再否则当自定义 lang
    const exact = LANG_OPTIONS.find(l => l.toLowerCase() === q.toLowerCase())
    if (exact !== undefined) {
      pickLang(exact)
      return
    }
    const first = filtered.value[0]
    if (first !== undefined) {
      pickLang(first)
      return
    }
    // 选项列表里完全没有 → 当自定义 lang 应用
    pickLang(q)
  }
}

function pickLang(lang: string) {
  const p = pos.value
  const v = props.view
  if (p == null || !v || v.isDestroyed) {
    close()
    return
  }
  // 先摘 widget 的联动 class(setCodeBlockLanguage 走 setNodeAttribute
  // 触发重建,widget DOM 换新,旧 class 也不会被继承,显式摘干净即可)
  markWidgetOpen(false)
  setCodeBlockLanguage(v.state, p, lang, (tr) => {
    v.dispatch(tr)
    v.focus()
  })
  close()
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) close()
}

defineExpose({ open: openPicker })

onBeforeUnmount(() => {
  // 兜底:组件卸载时若 panel 还开着,把监听摘掉
  teardownListeners()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="velo-lang-backdrop"
      :style="panelStyle"
      @click="onBackdropClick"
    >
      <div ref="panelEl" class="velo-lang-panel" @click.stop>
        <input
          v-model="filter"
          class="velo-lang-filter"
          placeholder="搜索语言"
          @keydown="onFilterKeydown"
        >
        <ul class="velo-lang-list">
          <li
            v-for="l in filtered"
            :key="l || 'plain'"
            :class="{ active: l === currentLang }"
            @click="pickLang(l)"
          >
            <span class="velo-lang-icon" v-html="langIconSvg(l, 16)"></span>{{ l || 'plain text' }}
          </li>
          <li
            v-if="filter.trim() && !hasExactMatch"
            class="velo-lang-custom-suggest"
            @click="pickLang(filter.trim())"
          >
            使用自定义:<b>{{ filter.trim() }}</b>
          </li>
          <li v-if="filtered.length === 0 && !filter.trim()" class="velo-lang-empty">
            无匹配
          </li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>

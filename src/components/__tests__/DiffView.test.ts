import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import DiffView from '../DiffView.vue'

// 版本历史 store 用可控的假实现替身:只暴露 DiffView 真正用到的字段,
// 才能精确控制 loadGitContent 的返回时机去构造竞态。
const state = vi.hoisted(() => ({} as {
  selectedEntryId: any
  entries: any
  loadGitContent: any
  diffOldContentAsync: any
  closeDiffView: any
  sourceMode: any
}))

vi.mock('@/stores/versionHistory', async () => {
  const { computed, reactive, ref } = await import('vue')
  state.selectedEntryId = ref<string | null>(null)
  state.entries = ref<any[]>([])
  state.loadGitContent = vi.fn()
  state.diffOldContentAsync = vi.fn()
  state.closeDiffView = vi.fn()
  const selectedEntry = computed(
    () => state.entries.value.find((e: any) => e.id === state.selectedEntryId.value) ?? null,
  )
  // 用 reactive 包一层:pinia store 读出来是解包后的值,
  // 直接给 computed/ref 会让组件拿到 Ref 对象(selected.timestamp 变 undefined)
  const store = reactive({
    selectedEntryId: state.selectedEntryId,
    selectedEntry,
    loadGitContent: state.loadGitContent,
    diffOldContentAsync: state.diffOldContentAsync,
    closeDiffView: state.closeDiffView,
  })
  return {
    UNSAVED_ID: '__unsaved__',
    useVersionHistoryStore: () => store,
  }
})

vi.mock('@/stores/document', async () => {
  const { reactive, ref } = await import('vue')
  // reactive 解包 ref:pinia store 读出来是值,直接返回 ref 会让 `!isSourceMode` 恒假
  const store = reactive({ sourceMode: ref(false) })
  state.sourceMode = store
  return { useDocumentStore: () => store }
})

vi.mock('@/stores/editor', async () => {
  const { reactive } = await import('vue')
  return { useEditorStore: () => reactive({ fontSize: 14 }) }
})

// 预览 diff 的 PM 渲染与竞态无关,替身掉避免拖慢/引入无关依赖
vi.mock('@/components/ProseMirrorEditor/WysiwygDiffView.vue', () => ({
  default: {
    name: 'WysiwygDiffView',
    props: ['newContent', 'oldContent'],
    template: '<div class="wys-stub" />',
  },
}))

function gitEntry(id: string, timestamp = 1) {
  return {
    id,
    filePath: '/note.md',
    timestamp,
    source: 'git',
    content: null,
    git: { hash: `h-${id}`, shortHash: id.slice(-6), author: 'x', subject: `commit ${id}`, message: '' },
  }
}

describe('DiffView 加载竞态守卫', () => {
  beforeEach(() => {
    state.selectedEntryId.value = null
    state.entries.value = []
    state.loadGitContent.mockReset()
    state.diffOldContentAsync.mockReset()
  })

  /** 当前预览 diff 拿到的「新版本内容」(未加载完时为 null) */
  function shownContent(wrapper: ReturnType<typeof mount>): string | null {
    const stub = wrapper.findComponent({ name: 'WysiwygDiffView' })
    return stub.exists() ? (stub.props('newContent') as string) : null
  }

  it('快速选中 A(Git 慢) → B(本地快):A 晚返回不得覆盖 B', async () => {
    let resolveA!: (v: string) => void
    state.entries.value = [
      gitEntry('git-a'),
      { id: 'local-b', filePath: '/note.md', timestamp: 9, source: 'local', content: 'B NEW CONTENT' },
    ]
    state.loadGitContent.mockImplementation((entry: any) =>
      entry.id === 'git-a'
        ? new Promise<string>((resolve) => { resolveA = resolve })
        : Promise.resolve(entry.content ?? ''))
    state.diffOldContentAsync.mockImplementation(async (id: string) => ({
      content: id === 'git-a' ? 'A OLD' : 'B OLD',
      loading: false,
    }))

    const wrapper = mount(DiffView)
    state.selectedEntryId.value = 'git-a'
    await nextTick()
    // 切到 B,B 立即加载完成
    state.selectedEntryId.value = 'local-b'
    await flushPromises()
    expect(shownContent(wrapper)).toBe('B NEW CONTENT')

    // A 的 git show 此时才返回 —— 必须被丢弃
    resolveA('A NEW CONTENT')
    await flushPromises()
    await nextTick()

    expect(shownContent(wrapper)).toBe('B NEW CONTENT')
  })

  it('过期请求结束时不得关闭新请求的 loading 态', async () => {
    let resolveA!: (v: string) => void
    let resolveB!: (v: string) => void
    state.entries.value = [gitEntry('git-a', 1), gitEntry('git-b', 2)]
    state.loadGitContent.mockImplementation((entry: any) =>
      new Promise<string>((resolve) => {
        if (entry.id === 'git-a') resolveA = resolve
        else resolveB = resolve
      }))
    state.diffOldContentAsync.mockImplementation(async () => ({ content: 'OLD', loading: false }))

    const wrapper = mount(DiffView)
    state.selectedEntryId.value = 'git-a'
    await nextTick()
    state.selectedEntryId.value = 'git-b'
    await nextTick()

    // A 先返回 → 不能把 B 的 loading 关掉(否则用户看到「无 diff 内容」空态)
    resolveA('A CONTENT')
    await flushPromises()
    expect(wrapper.find('.animate-spin').exists()).toBe(true)
    expect(shownContent(wrapper)).toBeNull()

    resolveB('B CONTENT')
    await flushPromises()
    expect(wrapper.find('.animate-spin').exists()).toBe(false)
    expect(shownContent(wrapper)).toBe('B CONTENT')
  })

  // 状态栏「未保存」入口(openUnsavedDiff)选中 UNSAVED_ID 后,
  // DiffView 必须按未保存语义渲染:标题「未保存内容」+「回退修改」按钮,
  // 正文 new 方是编辑器当前内容,old 方是上一版本。
  it('未保存条目:渲染「未保存内容 + 回退修改」,正文取当前内容', async () => {
    state.entries.value = [
      { id: '__unsaved__', filePath: '/note.md', timestamp: 5, source: 'unsaved', content: 'UNSAVED BODY' },
    ]
    state.diffOldContentAsync.mockImplementation(async () => ({ content: 'LAST SAVED', loading: false }))

    const wrapper = mount(DiffView)
    state.selectedEntryId.value = '__unsaved__'
    await flushPromises()

    expect(wrapper.text()).toContain('未保存内容')
    expect(wrapper.text()).toContain('回退修改')
    expect(wrapper.text()).not.toContain('恢复此版本')
    expect(shownContent(wrapper)).toBe('UNSAVED BODY')
  })
})

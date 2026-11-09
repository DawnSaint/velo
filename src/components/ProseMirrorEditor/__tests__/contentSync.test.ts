// 编辑器内容回写 ↔ 大纲一致性回归测试。
//
// 大纲只读 documentStore.content,而 WYSIWYG 的回写走 150ms debounce。
// 一旦待回写的编辑被 modelValue watch 的 cancelPendingEmit 吞掉,就会出现
// "编辑器里内容已删、大纲仍挂旧 title、点击找不到 DOM" 的永久不一致。
// 这里覆盖三条路径:普通删除、echo 回环撞上后一笔编辑、debounce 窗口内切标签。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { useDocumentStore } from '@/stores/document'
import EditorInner from '../EditorInner.vue'
import EditorOutline from '@/components/Sidebar/EditorOutline.vue'

const INITIAL = '# A\n\ntext\n\n## B\n\ntext2\n\n## C\n\ntext3\n'

const Harness = defineComponent({
  setup() {
    const store = useDocumentStore()
    return () => h('div', [
      h(EditorInner, {
        modelValue: store.content,
        'onUpdate:modelValue': (v: string) => store.setContent(v),
      }),
      h(EditorOutline, { modelValue: store.content, filePath: null }),
    ])
  },
})

interface InnerExposed {
  getEditorView: () => EditorView | null
}

function editorView(wrapper: VueWrapper): EditorView {
  const vm = wrapper.findComponent(EditorInner).vm as unknown as InnerExposed
  const view = vm.getEditorView()
  if (!view) throw new Error('EditorView 未挂载')
  return view
}

function headingPos(doc: PMNode, text: string): number {
  let found = -1
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && node.textContent === text) found = pos
  })
  return found
}

/** 删掉 ## B 整段(从 B 标题起点到 C 标题起点)。 */
function deleteSectionB(view: EditorView) {
  const from = headingPos(view.state.doc, 'B')
  const to = headingPos(view.state.doc, 'C')
  if (from < 0 || to < 0) throw new Error('测试文档缺少标题 B / C')
  view.dispatch(view.state.tr.delete(from, to))
}

function outlineText(wrapper: VueWrapper): string {
  return wrapper.findComponent(EditorOutline).text()
}

describe('内容回写与大纲同步', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('删除标题后 debounce 到期回写,大纲移除旧 title', async () => {
    const store = useDocumentStore()
    store.init(INITIAL)
    const wrapper = mount(Harness, { attachTo: document.body })
    await nextTick()
    const view = editorView(wrapper)

    deleteSectionB(view)
    await nextTick()
    vi.advanceTimersByTime(200)
    await nextTick()

    expect(store.content).not.toContain('## B')
    expect(outlineText(wrapper)).not.toContain('B')
  })

  it('echo 回环撞上后一笔编辑时不吞编辑(DOM 新 / content 旧 / 大纲旧)', async () => {
    const store = useDocumentStore()
    store.init(INITIAL)
    const wrapper = mount(Harness, { attachTo: document.body })
    await nextTick()
    const view = editorView(wrapper)

    // 第一笔编辑 emit 后,echo 的 modelValue watch 还没 flush(未 await nextTick),
    // 此刻立刻删掉 ## B —— 旧实现会在 echo 分支前 cancelPendingEmit 把它丢掉。
    view.dispatch(view.state.tr.insertText('x', 2))
    vi.advanceTimersByTime(200)
    deleteSectionB(view)
    await nextTick()
    vi.advanceTimersByTime(200)
    await nextTick()

    expect(view.dom.textContent).not.toContain('text2')
    expect(store.content).not.toContain('## B')
    expect(outlineText(wrapper)).not.toContain('B')
  })

  it('debounce 窗口内切标签再切回:编辑不丢失,大纲不残留旧 title', async () => {
    const store = useDocumentStore()
    store.init(INITIAL)
    const firstId = store.activeId
    const tab2 = store.createTab()
    const wrapper = mount(Harness, { attachTo: document.body })
    await nextTick()

    deleteSectionB(editorView(wrapper))
    await nextTick()
    store.switchTab(tab2)
    await nextTick()
    store.switchTab(firstId)
    await nextTick()
    vi.advanceTimersByTime(200)
    await nextTick()

    expect(store.content).not.toContain('## B')
    expect(editorView(wrapper).dom.textContent).not.toContain('text2')
    expect(outlineText(wrapper)).not.toContain('B')
  })

  it('点击已不存在的旧标题时按 DOM 真实标题重建大纲', async () => {
    const editor = document.createElement('div')
    editor.className = 'velo-editor'
    editor.innerHTML = '<div class="ProseMirror"><h1>A</h1><h2>C</h2></div>'
    document.body.appendChild(editor)

    const wrapper = mount(EditorOutline, {
      props: { modelValue: '# A\n\n## B\n\n## C\n', filePath: null },
      attachTo: document.body,
    })
    await nextTick()
    expect(wrapper.text()).toContain('B')

    await wrapper.find('[title="B"]').trigger('click')
    await nextTick()

    expect(wrapper.text()).not.toContain('B')
    expect(wrapper.text()).toContain('C')
  })
})

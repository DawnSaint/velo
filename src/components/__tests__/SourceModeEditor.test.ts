// SourceModeEditor 的代码块主题切换回归测试(CM6 迁移版)。
//
// 关注点不变:**代码块主题切换必须驱动 CM6 用新主题色重渲 shiki decoration,
// 中间不出现"全黑"一闪**。旧版(pre+textarea backdrop)的修复链路是本地镜像
// ref + ensureTheme 串行 + computed 重渲;CM6 版机制等价,dispatch target 从
// Vue ref 改 CM6 state effect(setShikiTheme):
//   - SourceModeEditor watch(editorStore.codeXxxTheme) → ensureTheme(light)
//     → ensureTheme(dark) 串行 → resolve 后 dispatch setShikiTheme effect
//     → shikiCmPlugin 的 ViewPlugin.update 拿到新主题名 rebuild decorations。
//   - build 只读 StateField 主题名镜像,**不**直接读 editorStore —— store
//     mutate 不触发 rebuild,只有 effect dispatch 后(= ensureTheme 已完成 =
//     shiki 已拿到真 hex)才 rebuild,不会出现中间全黑帧。
//
// 本测试用简化的 "fake shiki" 模拟生产(沿用旧版 mock 范式):
//   - getTokensSync(hl, code, lang, light, dark):light/dark 主题**未在 hl 登记**
//     → token color 'not-loaded'(对应生产的全黑);已登记 → 'loaded-{theme}'。
//   - ensureTheme(theme):手动可控 resolve;resolve 时把 theme id 写进 hl
//     的 loadedThemes,模拟"装上主题 hex 后下次 codeToTokens 出真色"。
//
// 断言对象从旧版 backdrop `<pre>` innerHTML 改为 CM6 渲染出的 token span
// inline style(含 `--shiki-light:..`)。核心断言(对应修复链路):
//   1) 初始挂载:默认主题已 loaded → decoration 用 loaded hex
//   2) 切主题但 ensureTheme 未 resolve → decoration **不变**,仍是旧色
//      'loaded-one-light'(对应修复前是 'not-loaded' = 全黑)
//   3) ensureTheme resolve 后 → decoration 切到 'loaded-{newTheme}'
//   4) ensureTheme 串行 await:light resolve 后才进 dark
//   5) 重复切换都正确

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useEditorStore } from '@/stores/editor'

// ============================================================
//  Mock @/components/ProseMirrorEditor/nodes/CodeBlockLangs
// ============================================================

const pendingEnsure: Array<{ themeId: string, resolve: () => void }> = []

/** 假 hl:loadedThemes 记录 ensureTheme resolve 进来的主题 id 集合。 */
const fakeHl = {
  loadedThemes: new Set<string>(),
  loadedLanguages: new Set<string>(['markdown']),
}

/** mock shiki 的 tokenize 输出。theme 未登记 → '#not-loaded';已登记 → '#loaded-{theme}'。 */
function fakeTokenize(code: string, lightTheme: string, _darkTheme: string) {
  const lightLoaded = fakeHl.loadedThemes.has(lightTheme)
  const lines = code.split('\n').map((line) => [{
    content: line,
    offset: 0,
    variants: {
      light: { color: lightLoaded ? `#loaded-${lightTheme}` : '#not-loaded-light' },
      dark: { color: '#not-loaded-dark-stub' },
    },
  }])
  return { tokens: lines }
}

vi.mock('@/components/ProseMirrorEditor/nodes/CodeBlockLangs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ProseMirrorEditor/nodes/CodeBlockLangs')>()
  return {
    ...actual,
    getHighlighterSync: () => fakeHl,
    getTokensSync: (
      _hl: unknown,
      code: string,
      _lang: string,
      lightTheme: string,
      darkTheme: string,
    ) => fakeTokenize(code, lightTheme, darkTheme),
    // 手动可控的 ensureTheme:resolve 时把 theme id 写进 fakeHl.loadedThemes,
    // 模拟"hl 装上主题 hex 后下次 codeToTokens 出真色"。resolve 由测试代码控制。
    ensureTheme: (themeId: string) => new Promise<void>((resolve) => {
      pendingEnsure.push({
        themeId,
        resolve: () => {
          fakeHl.loadedThemes.add(themeId)
          resolve()
        },
      })
    }),
    ensureMarkdownGrammar: async () => {},
    // 测试无关的导出,挂上占位避免 TS / 调用方报错
    setDecorationRebuildCallback: () => {},
    ensureLanguage: async () => {},
  }
})

// ============================================================
//  受测组件 = SourceModeEditor (CM6 版)
// ============================================================

import SourceModeEditor from '../SourceModeEditor.vue'

// ============================================================
//  工具
// ============================================================

/** 取 CM6 渲染出的 token span inline style 文本(整个 host innerHTML)。
 *  shikiCmPlugin 把每个 token 包成 `<span style="--shiki-light:..;--shiki-dark:..">`,
 *  断言在 host innerHTML 里查子串即可(等价于旧版查 backdrop pre innerHTML)。 */
function cmHtml(wrapper: VueWrapper): string {
  return wrapper.find('.velo-cm-host').html()
}

/** 跑完多轮 microtask + 一轮 macrotask,让 Vue reactivity / CM6 update / await 链落地。 */
async function flushAll(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await nextTick()
    await Promise.resolve()
  }
  await new Promise<void>((r) => setTimeout(r, 0))
  await nextTick()
}

/** 解析 pendingEnsure 队列:每轮先 resolve 当前所有 pending,然后让 watcher await
 *  链跑一段(可能推进到下一个 ensureTheme),再 resolve 新一轮。重复到 pendingEnsure
 *  连续空 2 轮。 */
async function resolveAllPending(): Promise<void> {
  let stableRounds = 0
  while (stableRounds < 2) {
    while (pendingEnsure.length) {
      const next = pendingEnsure.shift()!
      next.resolve()
    }
    await flushAll()
    if (pendingEnsure.length === 0) stableRounds++
    else stableRounds = 0
  }
  await flushAll()
}

describe('SourceModeEditor 代码块主题切换 (CM6)', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    pendingEnsure.length = 0
    fakeHl.loadedThemes.clear()
    // 默认主题('one-light' / 'one-dark-pro')在 production 是 bootstrap 期
    // App.vue codeBlockReady 已 ensure 过。测试里也预装,模拟"初始挂载时主题已可用"。
    fakeHl.loadedThemes.add('one-light')
    fakeHl.loadedThemes.add('one-dark-pro')
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    pendingEnsure.length = 0
    fakeHl.loadedThemes.clear()
  })

  it('初始挂载:默认主题已 loaded,CM6 decoration 用 loaded hex 渲染', async () => {
    wrapper = mount(SourceModeEditor, {
      props: { modelValue: '# hello' },
    })
    await flushAll()

    const html = cmHtml(wrapper)
    expect(html).toContain('#loaded-one-light')
    expect(html).not.toContain('#not-loaded-light')
  })

  it('切主题:ensureTheme 未 resolve 时 decoration 不重渲(不出现全黑一闪)', async () => {
    wrapper = mount(SourceModeEditor, {
      props: { modelValue: '# hello' },
    })
    await flushAll()

    expect(cmHtml(wrapper)).toContain('#loaded-one-light')

    const store = useEditorStore()
    store.codeLightTheme = 'dracula'
    await flushAll()

    // 'dracula' 进了 pendingEnsure,但 hl.loadedThemes 还没加它
    expect(pendingEnsure.map((p) => p.themeId)).toContain('dracula')
    expect(fakeHl.loadedThemes.has('dracula')).toBe(false)

    // **关键断言**:ensureTheme 未 resolve → setShikiTheme effect 未 dispatch →
    // ViewPlugin 不 rebuild → decoration 仍是旧色 'one-light'。修复前这里会
    // 出现 '#not-loaded' (= 生产的全黑 fallback) 一闪;修复后由于 effect 还没
    // dispatch,decoration 静默保持旧色直到 ensureTheme resolve 后才切新色。
    const htmlDuringAwait = cmHtml(wrapper)
    expect(htmlDuringAwait).toContain('#loaded-one-light')
    expect(htmlDuringAwait).not.toContain('#loaded-dracula')
    expect(htmlDuringAwait).not.toContain('#not-loaded-light')

    // resolve 后:hl 装上 dracula,effect dispatch,ViewPlugin rebuild,
    // decoration 切到新色
    await resolveAllPending()
    expect(fakeHl.loadedThemes.has('dracula')).toBe(true)
    const htmlAfter = cmHtml(wrapper)
    expect(htmlAfter).toContain('#loaded-dracula')
    expect(htmlAfter).not.toContain('#loaded-one-light')
  })

  it('同时切 light + dark:ensureTheme 串行 await(light 先,light resolve 后才进 dark)', async () => {
    wrapper = mount(SourceModeEditor, {
      props: { modelValue: '# hello' },
    })
    await flushAll()

    const store = useEditorStore()
    store.codeLightTheme = 'dracula'
    store.codeDarkTheme = 'solarized-dark'
    await flushAll()

    // 第一轮:只 light 进了 pending(watcher 是 await 串行,second ensureTheme
    // 必须等 first resolve 才调起)
    expect(pendingEnsure.map((p) => p.themeId)).toEqual(['dracula'])

    // resolve light → 第二个 ensureTheme(dark)才进 pending,但 effect 还没
    // dispatch(两个 ensureTheme 都 resolve 后才 dispatch),decoration 不变
    const first = pendingEnsure.shift()!
    first.resolve()
    await flushAll()

    expect(pendingEnsure.map((p) => p.themeId)).toEqual(['solarized-dark'])
    expect(cmHtml(wrapper)).toContain('#loaded-one-light')

    // resolve dark → 两个都 resolve → effect dispatch → ViewPlugin rebuild
    const second = pendingEnsure.shift()!
    second.resolve()
    await flushAll()

    const html = cmHtml(wrapper)
    expect(html).toContain('#loaded-dracula')
    expect(html).not.toContain('#loaded-one-light')
  })

  it('emits initial cursor position after mount', async () => {
    wrapper = mount(SourceModeEditor, {
      props: { modelValue: 'one\ntwo' },
    })
    await flushAll()

    expect(wrapper.emitted('cursor-position-change')?.[0]).toEqual([{ line: 1, column: 1 }])
  })

  it('emits cursor position when the CodeMirror selection changes', async () => {
    wrapper = mount(SourceModeEditor, {
      props: { modelValue: 'one\ntwo' },
    })
    await flushAll()

    const view = (wrapper.vm as unknown as { view: import('@codemirror/view').EditorView }).view
    view.dispatch({ selection: { anchor: 6 } })
    await flushAll()

    expect(wrapper.emitted('cursor-position-change')?.at(-1)).toEqual([{ line: 2, column: 3 }])
  })
})

// v0.5.12 块级折叠(heading / list_item)plugin 回归测试。
//
// 关注路径:
//  1. makeStableKey 派生规律 + 文本 normalize(trim / spaces collapse / 80 截断)
//  2. foldDecoPlugin apply 行为(toggle / initCollapsed / doc mapping 跟住折叠点)
//  3. heading fold 范围:吃到下一个 level ≤ 同级 heading 之前;末位 heading → doc.content.size
//  4. list_item fold 范围:仅隐藏首段之后的 block 子项;外层 bullet_list / 外层 list_item
//     **不**被 velo-folded(关键回归:之前 `nodesBetween` 误把外层祖先也算进去导致整个
//      list 都 display:none,本测试锁死 visitBlocksInRange 行为)
//  5. cross-plugin 同步时机:apply 阶段同步 foldedCodeBlockPosSet / foldedMermaidPosSet,
//     让 lineNumberPlugin / MermaidDecoration 在本帧装饰渲染前看到最新集合
//     (覆盖 #23 的时机修复 + #25 新增 mermaid 集合)
//  6. ensureFoldExpandedAt:fold 触发点本身的 pos 能展开,折叠区段外的 pos no-op

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema } from '../editor/schema'
import { fromMarkdown } from '../editor/markdownIO'
import {
  foldDecoration,
  foldKey,
  makeStableKey,
  collectFoldableKeys,
  ensureFoldExpandedAt,
  isCodeBlockFolded,
  isMermaidFolded,
  foldDeleteCommand,
  foldEnterCommand,
} from '../nodes/FoldDecoration'

// ============================================================
//  Helpers
// ============================================================

function makeView(initialMd: string, plugins: any[] = [foldDecoration]): EditorView {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const state = EditorState.create({
    schema,
    doc: fromMarkdown(initialMd, schema),
    plugins,
  })
  return new EditorView(container, { state })
}

/** 查 doc 里第一个 textContent 包含 needle 的 heading,返回
 *  { node, pos, contentStart }。contentStart 是 heading 的 content 起点
 *  (open token 之后),也是 fold store / setMeta 用的统一折叠点坐标。 */
function findHeadingByText(view: EditorView, needle: string): { node: any, pos: number, contentStart: number } | null {
  let out: { node: any, pos: number, contentStart: number } | null = null
  view.state.doc.descendants((node, p) => {
    if (!out && node.type.name === 'heading' && node.textContent.includes(needle)) {
      out = { node, pos: p, contentStart: p + 1 }
      return false
    }
    return true
  })
  return out
}

/** 查 doc 里第一个 list_item(其首段文本包含 needle)。 */
function findListItemByText(view: EditorView, needle: string): { node: any, pos: number, contentStart: number } | null {
  let out: { node: any, pos: number, contentStart: number } | null = null
  view.state.doc.descendants((node, p) => {
    if (
      !out
      && node.type.name === 'list_item'
      && node.firstChild?.textContent?.includes(needle)
    ) {
      out = { node, pos: p, contentStart: p + 1 }
      return false
    }
    return true
  })
  return out
}

/** 查 doc 里第一个 fold_placeholder 节点(真实 inline atom 节点,非 widget)。 */
function findFoldPlaceholder(view: EditorView): { node: any, pos: number } | null {
  let out: { node: any, pos: number } | null = null
  view.state.doc.descendants((node, p) => {
    if (!out && node.type.name === 'fold_placeholder') {
      out = { node, pos: p }
      return false
    }
    return true
  })
  return out
}
beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  document.querySelectorAll('.ProseMirror').forEach((el) => {
    el.parentElement?.remove()
  })
})

// ============================================================
//  makeStableKey
// ============================================================

describe('makeStableKey', () => {
  it('heading → "h{level}:{text}"', () => {
    const view = makeView('## Hello World')
    const { node } = findHeadingByText(view, 'Hello')!
    expect(makeStableKey(node)).toBe('h2:Hello World')
    view.destroy()
  })

  it('heading textContent normalize:trim + 多空格折叠成单空格', () => {
    // heading 的 textContent 不带换行,但有多余空格也要 normalize 掉
    // markdown 解析时会去多余空格(textContent 比较 clean);这里走人工
    // 制造的尾部/前导空格来验
    const view = makeView('#   foo   bar  baz  ')
    const { node } = findHeadingByText(view, 'foo')!
    expect(makeStableKey(node)).toBe('h1:foo bar baz')
    view.destroy()
  })

  it('heading text 截断到 80 字符', () => {
    const longText = 'A'.repeat(80) + 'BCDE'
    const view = makeView(`## ${longText}`)
    const { node } = findHeadingByText(view, 'AAAA')!
    const key = makeStableKey(node)
    expect(key.startsWith('h2:')).toBe(true)
    expect(key).toBe(`h2:${'A'.repeat(80)}`) // 正好 80 A
    expect(key.length).toBe(2 + 1 + 80)
    view.destroy()
  })

  it('list_item:折叠 key 跟首段挂钩(嵌套结构不影响)', () => {
    const view = makeView('- top\n  - nested')
    const { node } = findListItemByText(view, 'top')!
    expect(makeStableKey(node)).toBe('li:top')
    view.destroy()
  })

  it('非 foldable node 返回 ""(为空 / 默认空文本)', () => {
    const view = makeView('plain paragraph')
    // doc 里只有 paragraph,不是 heading / list_item
    // makeStableKey 应返回 ''
    view.state.doc.descendants((node) => {
      if (node.type.name === 'paragraph') {
        expect(makeStableKey(node)).toBe('')
      }
      return true
    })
    view.destroy()
  })
})

// ============================================================
//  collectFoldableKeys
// ============================================================

describe('collectFoldableKeys', () => {
  it('收集有可折叠内容的 heading / list_item', () => {
    // list_item 必须有 nested block 子项才算 foldable(`- list\n  - nested`)
    const md = ['# H1', '', '## H2', '', '- list', '  - nested'].join('\n')
    const view = makeView(md)
    const keys = collectFoldableKeys(view.state.doc)
    expect(keys).toHaveLength(3)
    const sigs = keys.map(k => `${k.type}:${k.stableKey}`).sort()
    expect(sigs).toEqual(
      ['heading:h1:H1', 'heading:h2:H2', 'list_item:li:list'].sort(),
    )
    view.destroy()
  })

  it('空 heading / 单段 list_item 不算 foldable', () => {
    // '# \n' 是空 heading(仅 open + close token);'- lone\n' 是单段 list_item
    const md = ['# ', '', '- lone'].join('\n')
    const view = makeView(md)
    const keys = collectFoldableKeys(view.state.doc)
    expect(keys.filter(k => k.type === 'heading')).toHaveLength(0)
    expect(keys.filter(k => k.type === 'list_item')).toHaveLength(0)
    view.destroy()
  })

  it('空 code_block 也算 foldable(header 始终渲染 chevron)', () => {
    // 空 code_block 的 header(含折叠 chevron)始终渲染,折叠状态需能持久化
    // 恢复,所以 collectFoldableKeys 不能因 content.size===0 跳过。
    const md = ['```js', '```'].join('\n')
    const view = makeView(md)
    const keys = collectFoldableKeys(view.state.doc)
    expect(keys.filter(k => k.type === 'code_block')).toHaveLength(1)
    view.destroy()
  })

  it('contentStart 是从 stable key 反查 pos 的关键(同一个 heading 多次调用稳定)', () => {
    const md = ['# Stable', '', 'p'].join('\n')
    const view = makeView(md)
    const keys1 = collectFoldableKeys(view.state.doc)
    const keys2 = collectFoldableKeys(view.state.doc)
    expect(keys1[0].contentStart).toBe(keys2[0].contentStart)
    expect(keys1[0].stableKey).toBe(keys2[0].stableKey)
    view.destroy()
  })
})

// ============================================================
//  foldDecoPlugin apply:state 变化路径
// ============================================================

describe('foldDecoPlugin apply', () => {
  it('toggle:初次折叠 → collapsedSet 加入 contentStart', () => {
    const view = makeView('# A\n\np')
    // heading pos = 0 → contentStart = 1
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: 1 }))
    expect(foldKey.getState(view.state)!.collapsedSet.has(1)).toBe(true)
    view.destroy()
  })

  it('toggle:再次 → collapsedSet 移除(contentStart)', () => {
    const view = makeView('# A\n\np')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: 1 }))
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: 1 }))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    view.destroy()
  })

  it('initCollapsed:覆盖整个 set(file 切换启动时灌入模拟)', () => {
    const md = ['# H1', '', '## H2'].join('\n')
    const view = makeView(md)
    const h1 = findHeadingByText(view, 'H1')!
    const h2 = findHeadingByText(view, 'H2')!
    view.dispatch(view.state.tr.setMeta(foldKey, {
      initCollapsed: [h2.contentStart],
    }))
    const set = foldKey.getState(view.state)!.collapsedSet
    expect(set.has(h2.contentStart)).toBe(true)
    expect(set.has(h1.contentStart)).toBe(false)
    expect(set.size).toBe(1)
    view.destroy()
  })

  it('doc 变化:在折叠 heading 内输入文本 → 折叠点 pos 跟 mapping 不变', () => {
    const view = makeView('# A\n\np')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: 1 }))
    const before = foldKey.getState(view.state)!.collapsedSet
    expect(before.size).toBe(1)
    // heading 内容起点 pos=1,插入文本到 heading content(在 pos=1 插入)
    // tr.mapping.map(1, -1) => 1(unchanged)
    view.dispatch(view.state.tr.insertText('A heading text', 1))
    const after = foldKey.getState(view.state)!.collapsedSet
    expect(after.size).toBe(1)
    view.destroy()
  })

  it('doc 变化:折叠点被删 → collapsedSet 失效 pos 丢弃', () => {
    const view = makeView('# A\n\np')
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: 1 }))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)
    // 删除整个 heading:# A nodeSize = 3(open + 'A' + close)= 3
    const headingEnd = 0 + view.state.doc.nodeAt(0)!.nodeSize
    view.dispatch(view.state.tr.delete(0, headingEnd))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    view.destroy()
  })
})

// ============================================================
//  heading fold 范围(关键回归)
// ============================================================

describe('heading fold 范围', () => {
  it('吃到下一个 level ≤ 当前 level heading 之前', () => {
    // # H1
    //   ## H2  ← fold trigger(level 2)
    //     ### H3  (在 fold 内)
    //   ## H2b  (level 2,fold end → 不被折叠)
    const md = [
      '# H1',
      '',
      '## H2',
      '',
      '### H3',
      '',
      '## H2b',
    ].join('\n')
    const view = makeView(md)
    const h2 = findHeadingByText(view, 'H2')! // 第一个 ## H2(fold trigger)
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h2.contentStart }))

    // ### H3 应该被 velo-folded
    const h3Dom = view.dom.querySelector('h3')
    expect(h3Dom?.closest('.velo-folded')).not.toBeNull()

    // ## H2b 不应被 velo-folded(level 2 fold end)
    const allH2 = view.dom.querySelectorAll('h2')
    expect(allH2).toHaveLength(2)
    const h2bDom = allH2[1]
    expect(h2bDom?.closest('.velo-folded')).toBeNull()

    view.destroy()
  })

  it('末位 heading fold:折到 doc.content.size(没有 next 同级 heading 拦)', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    const foldedCount = view.dom.querySelectorAll('.velo-folded').length
    expect(foldedCount).toBe(2) // p1, p2
    view.destroy()
  })
})

// ============================================================
//  list_item fold 范围(关键回归:外层容器**不**被 velo-folded)
// ============================================================

describe('list_item fold 范围', () => {
  it('fold range 仅隐藏首段之后的 block 子项,外层 bullet_list / list_item 不被挂', () => {
    // - top
    //   - nested
    // 折叠 top:
    //   - 期望:velo-folded 数 = 1(只挂嵌套的 bullet_list)
    //   - 外层 bullet_list / 外层 li "top" 不应被 velo-folded
    //   - 视觉:nested li "disappears"(因父 bullet_list display:none 级联)
    const md = ['- top', '  - nested'].join('\n')
    const view = makeView(md)
    const top = findListItemByText(view, 'top')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: top.contentStart }))

    // velo-folded 只有嵌套 bullet_list 一个
    const foldedCount = view.dom.querySelectorAll('.velo-folded').length
    expect(foldedCount).toBe(1)

    // 外层 ul 没 velo-folded class
    const outerUl = view.dom.querySelector('ul')
    expect(outerUl?.classList.contains('velo-folded')).toBe(false)

    // 第一个 li(顶层 "top")没 velo-folded
    const allLis = view.dom.querySelectorAll('li')
    expect(allLis.length).toBeGreaterThan(0)
    const topLiDom = allLis[0] as HTMLElement
    expect(topLiDom.closest('.velo-folded')).toBeNull()

    view.destroy()
  })

  it('无 block 子项的 list_item 不挂 toggle(无东西可折)', () => {
    // - lone  ← list_item,无后续 block child
    //   - 折 key 不应被 foldDecoPlugin 加 toggle(computeFoldRange 返回 null → no-op)
    const md = '- lone'
    const view = makeView(md)
    const lone = findListItemByText(view, 'lone')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: lone.contentStart }))
    // 不应有 velo-folded(lone 自身不算 foldable)
    expect(view.dom.querySelectorAll('.velo-folded').length).toBe(0)
    // 不应有 toggle button(lone 自身没折叠 key)
    expect(view.dom.querySelectorAll('.velo-fold-toggle').length).toBe(0)
    view.destroy()
  })
})

// ============================================================
//  cross-plugin 集合同步:apply 阶段更新
// ============================================================

describe('foldedCodeBlockPosSet / foldedMermaidPosSet apply-phase sync', () => {
  it('折叠 heading 含 code_block → isCodeBlockFolded 翻 true,展开 → 翻 false', () => {
    const md = [
      '# A',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
    ].join('\n')
    const view = makeView(md)

    // 查找 code_block pos 的辅助(fold_placeholder 插入/删除后位置会偏移)
    const findCodePos = () => {
      let pos = -1
      view.state.doc.descendants((node, p) => {
        if (node.type.name === 'code_block' && pos < 0) { pos = p; return false }
        return true
      })
      return pos
    }
    expect(findCodePos()).toBeGreaterThan(-1)
    expect(isCodeBlockFolded(findCodePos())).toBe(false)

    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    // fold_placeholder 插入后 code_block pos 偏移 +1,需重新查找
    expect(isCodeBlockFolded(findCodePos())).toBe(true)

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(isCodeBlockFolded(findCodePos())).toBe(false)

    view.destroy()
  })

  it('折叠 heading 含 mermaid → isMermaidFolded 翻 true,展开 → 翻 false', () => {
    const md = [
      '# A',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
    ].join('\n')
    const view = makeView(md)
    const findMermaidPos = () => {
      let pos = -1
      view.state.doc.descendants((node, p) => {
        if (
          node.type.name === 'code_block'
          && (node.attrs.language as string) === 'mermaid'
          && pos < 0
        ) {
          pos = p
          return false
        }
        return true
      })
      return pos
    }
    expect(findMermaidPos()).toBeGreaterThan(-1)
    expect(isMermaidFolded(findMermaidPos())).toBe(false)

    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    // fold_placeholder 插入后 mermaid code_block pos 偏移,需重新查找
    expect(isMermaidFolded(findMermaidPos())).toBe(true)

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(isMermaidFolded(findMermaidPos())).toBe(false)

    view.destroy()
  })

  it('多 foldable blocks 折叠时,集合合并而非覆盖', () => {
    const md = [
      '# A',
      '',
      '```js',
      'x',
      '```',
      '',
      '# B',
      '',
      '```py',
      'y',
      '```',
      '',
    ].join('\n')
    const view = makeView(md)
    const a = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: a.contentStart }))
    // fold_placeholder 插入 A heading 后 B 的位置偏移,需重新查找
    const b = findHeadingByText(view, 'B')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: b.contentStart }))

    const set = foldKey.getState(view.state)!.collapsedSet
    expect(set.size).toBe(2)
    expect(set.has(a.contentStart)).toBe(true)
    expect(set.has(b.contentStart)).toBe(true)

    // 两个 code_block 都应在 folded set 内
    const codePositions: number[] = []
    view.state.doc.descendants((node, p) => {
      if (node.type.name === 'code_block') codePositions.push(p)
      return true
    })
    expect(codePositions).toHaveLength(2)
    expect(isCodeBlockFolded(codePositions[0])).toBe(true)
    expect(isCodeBlockFolded(codePositions[1])).toBe(true)

    view.destroy()
  })
})

// ============================================================
//  集成:codeLineNumber × fold + mermaid × fold
//
//  这两个集成用例单独抽到 foldCrossPlugins.test.ts(见同目录)运行,
//  避免在 foldDecoration 单测 suite 里跟其他 fork dispatch 互相影响
//  module-level cross-plugin 同步状态时的还原细节。
// ============================================================

describe('ensureFoldExpandedAt', () => {
  it('pos 在折叠 heading trigger 内 → 展开 fold,返回 true;再调一次返回 false', () => {
    // heading trigger 本身是 fold 触发点,该 heading 的 contentStart 进 set;
    // pos 在 heading 内(text 起点 / heading descendant)时,function 通过
    // heading ancestor 命中并展开
    const md = ['# H1', '', 'p'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'H1')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)

    // heading content 起点(h.contentStart)就在 heading 内 → 应能展开
    const expanded = ensureFoldExpandedAt(view, h.contentStart)
    expect(expanded).toBe(true)
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)

    // 再次调用 → false(已展开)
    expect(ensureFoldExpandedAt(view, h.contentStart)).toBe(false)
    view.destroy()
  })

  it('pos 在折叠 list_item 内 → 展开 fold', () => {
    const md = ['- one', '  - nested'].join('\n')
    const view = makeView(md)
    const li = findListItemByText(view, 'one')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: li.contentStart }))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)

    // li content 起点
    expect(ensureFoldExpandedAt(view, li.contentStart)).toBe(true)
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    view.destroy()
  })

  it('heading trigger 未折叠时 → no-op 返回 false', () => {
    const md = ['# H1', '', 'p'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'H1')!
    expect(ensureFoldExpandedAt(view, h.contentStart)).toBe(false)
    view.destroy()
  })
})

// ============================================================
//  placeholder 交互(v0.7.2)—— 真实 fold_placeholder 节点
//
//  占位符 `...` 是真实 inline atom 节点(非 Decoration.widget):
//   - 光标可自然停在两侧(不再受 widget side 限制)
//   - 可被 TextSelection 覆盖划选(原生选区能覆盖)
//   - 点击 → handleClickOn 展开(选区为空时)
//   - 划选覆盖 → Decoration.node 挂 is-selected 高亮
//   - Backspace/Delete → foldDeleteCommand(排在 keymap 链首)扩展删除
// ============================================================

describe('placeholder 交互 (v0.7.2)', () => {
  it('折叠后 fold_placeholder 节点出现在 heading 末尾', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    const ph = findFoldPlaceholder(view)
    expect(ph).not.toBeNull()
    // fold_placeholder 在 heading 内部
    const $pos = view.state.doc.resolve(ph!.pos)
    expect($pos.parent.type.name).toBe('heading')
    view.destroy()
  })

  it('展开后 fold_placeholder 节点消失', () => {
    const md = ['# A', '', 'p1'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(findFoldPlaceholder(view)).not.toBeNull()

    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(findFoldPlaceholder(view)).toBeNull()
    view.destroy()
  })

  it('点击 heading 占位符(选区为空)→ 展开折叠', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)

    // 确保选区为空(纯点击场景)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)))

    // 模拟 handleClickOn(真实节点由 PM handleClickOn prop 处理)
    const ph = findFoldPlaceholder(view)!
    view.someProp('handleClickOn', (handler) => {
      if (handler) return handler(view, ph.pos, ph.node, ph.pos, {} as MouseEvent, true)
      return false
    })

    // 点击 = 展开
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    expect(findFoldPlaceholder(view)).toBeNull()
    view.destroy()
  })

  it('点击 `...` 展开后 toggle 按钮的 data-fold-state 复原为 expanded', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    // 折叠态:toggle 按钮是 collapsed
    const toggleCollapsed = view.dom.querySelector('.velo-fold-toggle') as HTMLElement
    expect(toggleCollapsed.getAttribute('data-fold-state')).toBe('collapsed')

    // 确保选区为空(纯点击场景)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)))

    // 模拟 handleClickOn 点击 `...` 展开
    const ph = findFoldPlaceholder(view)!
    view.someProp('handleClickOn', (handler) => {
      if (handler) return handler(view, ph.pos, ph.node, ph.pos, {} as MouseEvent, true)
      return false
    })

    // 展开后:toggle 按钮应复原为 expanded(syncToggleState 在 view.update 中同步)
    const toggleExpanded = view.dom.querySelector('.velo-fold-toggle') as HTMLElement
    expect(toggleExpanded.getAttribute('data-fold-state')).toBe('expanded')
    view.destroy()
  })

  it('拖选后有选区时点击 `...` → 不展开(避免误触发)', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    // 模拟拖选后状态:非空选区
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 1, 2),
    ))

    const ph = findFoldPlaceholder(view)!
    view.someProp('handleClickOn', (handler) => {
      if (handler) return handler(view, ph.pos, ph.node, ph.pos, {} as MouseEvent, true)
      return false
    })

    // 有选区 → 不展开
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)
    view.destroy()
  })

  it('划选 head 文字到 `...` → is-selected 高亮;移开 → 取消', () => {
    const md = ['# A', '', 'p1'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    const ph = findFoldPlaceholder(view)!
    // 划选 [head 文本起点, fold_placeholder 末尾]
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, h.pos + 1, ph.pos + 1),
    ))

    // is-selected 高亮(Decoration.node 给 fold_placeholder DOM 挂 class)
    const phDom = view.dom.querySelector('.velo-fold-placeholder') as HTMLElement
    expect(phDom?.classList.contains('is-selected')).toBe(true)

    // 移开选区(空选区)→ 取消高亮
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 1)))
    const phDom2 = view.dom.querySelector('.velo-fold-placeholder') as HTMLElement
    expect(phDom2?.classList.contains('is-selected')).toBe(false)
    view.destroy()
  })

  it('划选 head 到 `...` → Backspace → head+折叠内容一起删 + 折叠点清除(不串到 # B)', () => {
    const md = ['# A', '', 'p1', '', 'p2', '', '# B', '', 'p3'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    // 划选 head 文字到 `...`:选区覆盖 fold_placeholder 节点
    const ph = findFoldPlaceholder(view)!
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, h.pos + 1, ph.pos + 1),
    ))

    // Backspace → foldDeleteCommand 扩展删除到 range[1]
    foldDeleteCommand(view.state, view.dispatch.bind(view))

    // 折叠点已清除 —— 关键:不串到 # B
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    expect(view.state.doc.textContent).not.toContain('A')
    expect(view.state.doc.textContent).not.toContain('p1')
    expect(view.state.doc.textContent).not.toContain('p2')
    expect(view.state.doc.textContent).toContain('B')
    expect(view.state.doc.textContent).toContain('p3')
    // 无残留折叠
    expect(view.dom.querySelectorAll('.velo-folded').length).toBe(0)
    view.destroy()
  })

  it('list_item:划选首段到 `...` → Delete → 子项连同删除 + 折叠点清除', () => {
    const md = ['- top', '  - nested1', '  - nested2'].join('\n')
    const view = makeView(md)
    const li = findListItemByText(view, 'top')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: li.contentStart }))

    const ph = findFoldPlaceholder(view)!
    expect(ph).not.toBeNull()

    // 划选 [首段文本起点, fold_placeholder 末尾]
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, li.contentStart + 1, ph.pos + 1),
    ))

    // Delete → foldDeleteCommand 扩展删除到 listItemEnd
    foldDeleteCommand(view.state, view.dispatch.bind(view))

    // 折叠点清除
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    expect(view.state.doc.textContent).not.toContain('top')
    expect(view.state.doc.textContent).not.toContain('nested1')
    expect(view.state.doc.textContent).not.toContain('nested2')
    view.destroy()
  })

  it('选区不覆盖 fold_placeholder → foldDeleteCommand 不触发(返回 false)', () => {
    const md = ['# Hello', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'Hello')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)

    const ph = findFoldPlaceholder(view)!
    // 划选 heading 内部一段(不覆盖 fold_placeholder)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 2, ph.pos),
    ))
    const phDom = view.dom.querySelector('.velo-fold-placeholder') as HTMLElement
    expect(phDom?.classList.contains('is-selected')).toBe(false)

    // foldDeleteCommand 不触发
    expect(foldDeleteCommand(view.state, view.dispatch.bind(view))).toBe(false)
    // 折叠态不变
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)
    view.destroy()
  })

  it('foldDeleteCommand 直接调用(不经过 keymap)也能正确扩展删除', () => {
    const md = ['# X', '', 'content1', '', 'content2', '', '# Y'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'X')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    const ph = findFoldPlaceholder(view)!
    // 选区覆盖 fold_placeholder
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, h.pos + 1, ph.pos + 1),
    ))

    // 直接调用 foldDeleteCommand(模拟 keymap 链首执行)
    const result = foldDeleteCommand(view.state, view.dispatch.bind(view))
    expect(result).toBe(true)

    // X + content 被删,Y 保留
    expect(view.state.doc.textContent).not.toContain('X')
    expect(view.state.doc.textContent).not.toContain('content1')
    expect(view.state.doc.textContent).not.toContain('content2')
    expect(view.state.doc.textContent).toContain('Y')
    view.destroy()
  })

  it('仅选中 `...`(不覆盖 header)→ Backspace → 只删折叠内容, header 保留', () => {
    const md = ['# A', '', 'p1', '', 'p2', '', '# B', '', 'p3'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    const ph = findFoldPlaceholder(view)!
    // 仅划选 fold_placeholder 节点本身(不覆盖 header 文本)
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, ph.pos, ph.pos + 1),
    ))

    const result = foldDeleteCommand(view.state, view.dispatch.bind(view))
    expect(result).toBe(true)

    // header A 保留,折叠内容 p1/p2 被删,`# B` / p3 不受影响
    expect(view.state.doc.textContent).toContain('A')
    expect(view.state.doc.textContent).not.toContain('p1')
    expect(view.state.doc.textContent).not.toContain('p2')
    expect(view.state.doc.textContent).toContain('B')
    expect(view.state.doc.textContent).toContain('p3')
    // 折叠点清除 + 无残留折叠 / 占位符
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    expect(view.dom.querySelectorAll('.velo-folded').length).toBe(0)
    expect(findFoldPlaceholder(view)).toBeNull()
    view.destroy()
  })

  it('list_item:仅选中 `...` → Delete → 只删子项, 首段保留', () => {
    const md = ['- top', '  - nested1', '  - nested2'].join('\n')
    const view = makeView(md)
    const li = findListItemByText(view, 'top')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: li.contentStart }))

    const ph = findFoldPlaceholder(view)!
    // 仅划选 fold_placeholder 节点本身
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, ph.pos, ph.pos + 1),
    ))

    const result = foldDeleteCommand(view.state, view.dispatch.bind(view))
    expect(result).toBe(true)

    // 首段 top 保留,嵌套子项被删
    expect(view.state.doc.textContent).toContain('top')
    expect(view.state.doc.textContent).not.toContain('nested1')
    expect(view.state.doc.textContent).not.toContain('nested2')
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    view.destroy()
  })
})

describe('fold toggle 可见性', () => {
  it('末尾 heading(下方无内容)不显示 fold toggle', () => {
    const view = makeView('# Only')
    expect(view.dom.querySelectorAll('.velo-fold-toggle').length).toBe(0)
    view.destroy()
  })

  it('heading 直接紧跟同级标题不显示 fold toggle', () => {
    const view = makeView(['# A', '# B'].join('\n'))
    expect(view.dom.querySelectorAll('.velo-fold-toggle').length).toBe(0)
    view.destroy()
  })

  it('heading 直接紧跟更高级标题(h2 后 h1)不显示 fold toggle', () => {
    const view = makeView(['## A', '# B'].join('\n'))
    expect(view.dom.querySelectorAll('.velo-fold-toggle').length).toBe(0)
    view.destroy()
  })

  it('heading 有后续内容(展开态)显示 fold toggle', () => {
    const view = makeView(['# A', '', 'p1'].join('\n'))
    expect(view.dom.querySelectorAll('.velo-fold-toggle').length).toBe(1)
    view.destroy()
  })

  it('heading 有后续内容(折叠态)也显示 fold toggle', () => {
    const view = makeView(['# A', '', 'p1'].join('\n'))
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    expect(view.dom.querySelectorAll('.velo-fold-toggle').length).toBe(1)
    view.destroy()
  })

  it('删掉 `...` 后原 header 不再显示 fold toggle(回归:删除不残留按钮)', () => {
    const md = ['# A', '', 'p1', '', 'p2', '', '# B', '', 'p3'].join('\n')
    const view = makeView(md)
    const hA = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: hA.contentStart }))
    // 折叠前 A 有 toggle
    expect(view.dom.querySelector(`.velo-fold-toggle[data-fold-cs="${hA.contentStart}"]`)).not.toBeNull()

    const ph = findFoldPlaceholder(view)!
    // 仅划选 `...` 节点
    view.dispatch(view.state.tr.setSelection(
      TextSelection.create(view.state.doc, ph.pos, ph.pos + 1),
    ))
    foldDeleteCommand(view.state, view.dispatch.bind(view))

    // 删除折叠内容后 A 下方无内容 → A 的 toggle 消失
    expect(view.dom.querySelector(`.velo-fold-toggle[data-fold-cs="${hA.contentStart}"]`)).toBeNull()
    // B 仍有内容(p3)→ B 的 toggle 仍在
    const hB = findHeadingByText(view, 'B')!
    expect(view.dom.querySelector(`.velo-fold-toggle[data-fold-cs="${hB.contentStart}"]`)).not.toBeNull()
    view.destroy()
  })
})

// ============================================================
//  auto-expand on type-after-placeholder (v0.7.3)
//
//  光标正紧贴折叠态 `...` 之后输入字符 / Enter → 展开折叠,并把光标 / 新内容
//  重定向到折叠区段末尾(语义:在 `...` 后输入 = 在折叠内容末尾追加)。
//  仅当 选区为空 + 前一节点是折叠态 fold_placeholder 时命中;否则不拦截。
// ============================================================

describe('auto-expand on type-after-placeholder (v0.7.3)', () => {
  it('heading:光标在 `...` 后输入字符 → 展开 + 字符追加到折叠内容末尾', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    const ph = findFoldPlaceholder(view)!
    // 光标移到 `...` 之后(紧贴)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, ph.pos + 1)))

    const handled = view.someProp('handleTextInput', (handler) => {
      if (handler) return handler(view, ph.pos + 1, ph.pos + 1, 'xyz', () => view.state.tr)
      return false
    })
    expect(handled).toBe(true)

    // 折叠展开:placeholder 消失、collapsedSet 清空
    expect(findFoldPlaceholder(view)).toBeNull()
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    // `xyz` 追加到折叠内容末尾(p2 之后),而非顶到 header 之后
    expect(view.state.doc.textContent).toContain('p2xyz')
    expect(view.state.doc.textContent.endsWith('xyz')).toBe(true)
    expect(view.state.selection.empty).toBe(true)
    // Bug 1 回归:展开后在 `...` 后输入,光标必须落到折叠内容末尾(p2 内),
    // 不能停在 `...` 原位置(标题之后)。insertText 仅在"插入点==当前选区"时
    // 才移动选区,这里当前选区在 placeholder,handleTextInput 必须显式
    // setSelection 到插入点之后,否则光标卡在标题后。
    const $cur = view.state.doc.resolve(view.state.selection.from)
    expect($cur.parent.type.name).toBe('paragraph')
    expect(view.state.doc.textContent.indexOf('xyz')).toBeGreaterThan(view.state.doc.textContent.indexOf('p2'))
    view.destroy()
  })

  it('heading:光标在 `...` 后按 Enter → 展开 + 在折叠内容末尾后插入空行(return true)', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))

    const ph = findFoldPlaceholder(view)!
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, ph.pos + 1)))

    const handled = foldEnterCommand(view.state, (tr) => view.dispatch(tr))
    expect(handled).toBe(true)

    expect(findFoldPlaceholder(view)).toBeNull()
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    // 光标落在折叠内容末尾后的新空段落内
    const $cur = view.state.doc.resolve(view.state.selection.from)
    expect($cur.parent.type.name).toBe('paragraph')
    expect($cur.parent.textContent).toBe('')
    expect(view.state.selection.empty).toBe(true)
    view.destroy()
  })

  it('list_item:光标在 `...` 后输入字符 → 展开 + 字符追加到折叠内容末尾', () => {
    const md = ['- top', '  - nested1', '  - nested2'].join('\n')
    const view = makeView(md)
    const li = findListItemByText(view, 'top')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: li.contentStart }))

    const ph = findFoldPlaceholder(view)!
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, ph.pos + 1)))

    const handled = view.someProp('handleTextInput', (handler) => {
      if (handler) return handler(view, ph.pos + 1, ph.pos + 1, 'tail', () => view.state.tr)
      return false
    })
    expect(handled).toBe(true)

    expect(findFoldPlaceholder(view)).toBeNull()
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(0)
    // `tail` 追加到最后一个嵌套子项(nested2)末尾
    expect(view.state.doc.textContent).toContain('nested2tail')
    view.destroy()
  })

  it('折叠态但光标不在 `...` 后 → 不拦截(handleTextInput 返回 false)', () => {
    const md = ['# A', '', 'p1', '', 'p2'].join('\n')
    const view = makeView(md)
    const h = findHeadingByText(view, 'A')!
    view.dispatch(view.state.tr.setMeta(foldKey, { toggle: h.contentStart }))
    // 光标放在 heading 文本起点(pos 1),不在 placeholder 后
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))

    const handled = view.someProp('handleTextInput', (handler) => {
      if (handler) return handler(view, 1, 1, 'x', () => view.state.tr)
      return false
    })
    expect(handled).toBeFalsy()
    // 折叠态保持不变(未被误展开 / 误删)
    expect(foldKey.getState(view.state)!.collapsedSet.size).toBe(1)
    view.destroy()
  })

  it('未折叠(无 placeholder)时正常输入不受影响(handleTextInput 返回 false)', () => {
    const md = ['# A', '', 'p1'].join('\n')
    const view = makeView(md)
    // 不折叠 → 无 placeholder,heading 末尾没有可拦截的节点
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)))
    const handled = view.someProp('handleTextInput', (handler) => {
      if (handler) return handler(view, 1, 1, 'x', () => view.state.tr)
      return false
    })
    expect(handled).toBeFalsy()
    view.destroy()
  })
})

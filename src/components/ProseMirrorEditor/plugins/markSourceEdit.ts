// mark 源码编辑 — Obsidian Live Preview 风格的光标驱动 session。
//
// 用户交互流程:
//   1. 光标(方向键 / 点击)进入 strong/emphasis/highlight/strike 范围 → appendTransaction
//      把整个 mark 范围换成 markdown 源码字面字符(`**bold**`),进入编辑 session。
//      Decoration 给源码文本加 [data-mark-source-edit] 标记。trigger 事务挂
//      SKIP_CONTENT_EMIT —— 这是瞬时视图切换不是内容编辑,不触发内容回写。
//   2. 编辑态下:
//      - 用户编辑源码 → 普通 transaction,plugin state 随位置平移
//      - 光标移出源码范围 → apply 检测到,view.update 触发 commit
//      - commit:fromMarkdown 重解析源码 → 还原成含 marks 的 inline nodes。
//        strong/emphasis 的 marker attr 用源码里实际出现的分隔符回写(`*`/`_`)
//      - Escape → keymap 还原成 originalSource 对应的 marks
//
// 设计要点(对照 linkClick.ts / imageEditPlugin.ts):
//  - session 状态机(apply mapping bias +1/-1 + pendingCommit + view.update 触发 commit
//    + Escape 还原)逐字照搬 linkClick 的骨架。
//  - 与 link/image 不同:mark 是 inclusive mark,session 触发改成 appendTransaction
//    (光标进入即触发,非点击);commit 不手动 addMark(fromMarkdown 已还原所有 mark);
//    commit 不调 setSelection —— 靠 tr.mapping 把光标重映射到还原 mark 之外(否则会立即
//    重进 session;见"commit 后不重进"注释)。
//  - buildMarkSource 自己遍历 slice 节点按 markerText(mark) 拼源码,不走 toMarkdown ——
//    toMarkdown 把 emphasis 恒输出 `_`、strong 恒 `**`,丢 attrs.marker;要保 `*`/`_`
//    原始分隔符必须自己拼。
//  - 触发守卫:仅 batch 含 `selectionChanged && !docChanged` 的 tr 才进 ——
//    键入 tr 是 docChanged(即便也移光标),不触发,保住 Ctrl+B 连续输入(inclusive:true
//    必须留,addStoredMark 首字符后靠边界继承)。

import { keymap } from 'prosemirror-keymap'
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Mark, Node as PMNode } from 'prosemirror-model'

import { fromMarkdown } from '../editor/markdownIO'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'
import { linkClickPluginKey } from './linkClick'
import { imageEditKey } from '../image/imageEditPlugin'

export const markSourceEditKey = new PluginKey<MarkSourceEditState>('markSourceEdit')

// 模块级 view 引用:appendTransaction 没有 view 参数,用它读 view.editable 判断阅读模式。
// 单 EditorView 实例场景安全(view spec 设置,destroy 清 null)。
let editorView: EditorView | null = null

// 目标 mark:strong / emphasis / highlight / strike / code(行内代码;link 自有 session)。
const TARGET_MARKS = new Set(['strong', 'emphasis', 'highlight', 'strike_through', 'code'])

// 标记嵌套顺序(开:外→内;闭:内→外)。照 markdownIO wrapWithMarks 的外→内序反转得开序,
// 闭序为开序的反转。highlight 单独处理(其无 marker attr,且 wrapWithMarks 不含它)。
// code 排最末(最内)—— 它 excludes:'_' 独占,实际不会与其他 mark 并存,位置无副作用。
const OPEN_ORDER = ['strong', 'emphasis', 'strike_through', 'highlight', 'code'] as const
const CLOSE_ORDER = [...OPEN_ORDER].reverse() as readonly string[]

interface MarkSourceEditSession {
  editFrom: number
  editTo: number
  originalSource: string
}

interface MarkSourceEditState {
  session: MarkSourceEditSession | null
  /** apply 检测到光标移出 edit 范围,标记等下一次 view.update 触发 commit。
   *  不能在 apply 里直接 dispatch,会陷入 dispatch → apply → dispatch 循环。 */
  pendingCommit: MarkSourceEditSession | null
}

function emptyState(): MarkSourceEditState {
  return { session: null, pendingCommit: null }
}

/** mark → 分隔符文本。strong/emphasis 的 marker attr 决定 `*` vs `_`。code 用单个 backtick
 *  (多 backtick 代码 `` `` .. `` `` 重建时降级为单 backtick,已知限制;源文件加载不受影响)。 */
function markerText(mark: Mark): string | null {
  switch (mark.type.name) {
    case 'strong': return (mark.attrs.marker === '_' ? '__' : '**')
    case 'emphasis': return (mark.attrs.marker === '_' ? '_' : '*')
    case 'highlight': return '=='
    case 'strike_through': return '~~'
    case 'code': return '`'
    default: return null
  }
}

/** 黑名单容器(code_block / math_block)—— 这些是字面量区域,光标在内不进 mark session。
 *  注意:行内 code mark **不**在此列 —— code mark 本身是 session 目标,光标进入要换源码。
 *  (markCommands.ts 的 code mark 黑名单是 Ctrl+B 不在 code 内切换,与本处目的不同。) */
function isBlacklisted(state: EditorState, pos: number): boolean {
  const $pos = state.doc.resolve(pos)
  if ($pos.parent.type.name === 'code_block') return true
  if ($pos.parent.type.name === 'math_block') return true
  return false
}

/** link / image edit session 退避 —— 别的 session 范围内不进 mark session。 */
function inOtherEditSession(state: EditorState, pos: number): boolean {
  const linkSession = linkClickPluginKey.getState(state)?.session
  if (linkSession && pos >= linkSession.editFrom && pos <= linkSession.editTo) return true
  const imageSession = imageEditKey.getState(state)?.session
  if (imageSession && pos >= imageSession.editFrom && pos <= imageSession.editTo) return true
  return false
}

/** 算单个 mark 在 doc 里的连续范围 [start, end](用 Mark.eq 比较,非 ===)。
 *  向前扫第一个"char 不带该 mark"的位置 = start;向后扫第一个"char 不带" = end。
 *  坑(inclusive 左边界):char [p,p+1] 带 mark 当且仅当 resolve(p+1).marks() 含 mark ——
 *  故向前扫判 resolve(start).marks()(char 末位置),不是 resolve(start-1)(char 首
 *  位置,左边界不含 mark 会漏第一字符)。 */
function findMarkRange(state: EditorState, mark: Mark, pos: number): [number, number] {
  const doc = state.doc
  const max = doc.content.size
  // 左扫到块首内联起点为止。resolve(块首).marks() 在 nodeBefore 为空时会回退取
  // nodeAfter 的 marks(含本 mark),若用 start>0 会误判"块首前一格仍被覆盖"→ start
  // 越过块开 token 落到块外(pos 0),随后 delete(0, markEnd) 跨块开 token 删,结构碎裂。
  // (行首 mark 专属 bug:行内 mark 因 nodeBefore 存在且不带 mark,会在边界处正常 break。)
  const blockStart = doc.resolve(pos).start(doc.resolve(pos).depth)
  let start = pos
  while (start > blockStart) {
    const m = doc.resolve(start).marks()
    if (!m.some(x => x.eq(mark))) break
    start--
  }
  let end = pos
  while (end < max) {
    const m = doc.resolve(end + 1).marks()
    if (!m.some(x => x.eq(mark))) break
    end++
  }
  return [start, end]
}

/** 在光标处取最外层目标 mark(范围最大的目标 mark)。覆盖整个嵌套跨度,
 *  否则只换内层 mark 会丢外层 mark。仅判 resolve(head).marks()(内部 + inclusive
 *  右边界);左边界(head===markStart,resolve 不含 mark)不进 session ——
 *  typing 在左边界本就不继承(inclusive 左边界),无需 session。 */
function pickOutermostTargetMark(state: EditorState, pos: number): { mark: Mark, start: number, end: number } | null {
  const $pos = state.doc.resolve(pos)
  const candidates: Mark[] = []
  for (const m of $pos.marks()) {
    if (TARGET_MARKS.has(m.type.name)) candidates.push(m)
  }
  if (candidates.length === 0) return null
  let best: { mark: Mark, start: number, end: number } | null = null
  for (const mark of candidates) {
    const [start, end] = findMarkRange(state, mark, pos)
    // 最外层 = span 最大(end - start 最大)。ties 取第一个。
    if (!best || (end - start) > (best.end - best.start)) {
      best = { mark, start, end }
    }
  }
  return best
}

/** 把 [from, to] 范围的 inline nodes 拼成 markdown 源码,保留每个 mark 的精确分隔符
 *  (读 attrs.marker)。不走 toMarkdown —— 它把 emphasis 恒输出 `_`、strong 恒 `**`。
 *  按 OPEN_ORDER(外→内)在 mark 转换处插开分隔符,CLOSE_ORDER(内→外)插闭分隔符。 */
function buildMarkSource(doc: PMNode, from: number, to: number): string {
  const nodes: PMNode[] = []
  doc.nodesBetween(from, to, (n) => {
    if (n.isInline) nodes.push(n)
  })
  let out = ''
  let prevMarks: Mark[] = []
  const byName = (name: string) => (m: Mark) => m.type.name === name
  for (const node of nodes) {
    const cur = node.marks.filter(m => TARGET_MARKS.has(m.type.name))
    // 闭:内→外,在 prev 有 cur 没有的 mark 处插闭分隔符
    for (const name of CLOSE_ORDER) {
      if (prevMarks.some(byName(name)) && !cur.some(byName(name))) {
        const m = prevMarks.find(byName(name))!
        out += markerText(m) ?? ''
      }
    }
    // 开:外→内,在 cur 有 prev 没有的 mark 处插开分隔符
    for (const name of OPEN_ORDER) {
      if (cur.some(byName(name)) && !prevMarks.some(byName(name))) {
        const m = cur.find(byName(name))!
        out += markerText(m) ?? ''
      }
    }
    out += node.isText ? (node.text ?? '') : ''
    prevMarks = cur
  }
  // 闭尾:所有还开着的 mark
  for (const name of CLOSE_ORDER) {
    if (prevMarks.some(byName(name))) {
      const m = prevMarks.find(byName(name))!
      out += markerText(m) ?? ''
    }
  }
  return out
}

/** 从源码检出某 mark 类型实际用的分隔符(`*`/`_`)。strong 匹配 `**`/`__`,
 *  emphasis 匹配单个 `*`/`_`(排除 `**` 的组成部分)。单 session 内混用
 *  `*`/`_` 的边角情况按首次出现取(已知限制)。 */
function detectMarker(source: string, kind: 'strong' | 'emphasis'): '*' | '_' {
  if (kind === 'strong') {
    return /__/.test(source) && !/\*\*/.test(source) ? '_' : '*'
  }
  // emphasis:优先找未被 `*` 包夹的单 `_`(后接非 _ * word 字符)
  if (/(?<![*_])_(?![*_])/.test(source)) return '_'
  return '*'
}

/** 对插入范围回写 strong/emphasis 的 marker attr,匹配源码实际分隔符。
 *  只在**已存在**该 mark 的 text span 上改 attr —— 不新增 mark(否则破源码 / 改成
 *  别的 mark 类型时会把 plain text 误加 strong)。highlight/strike 无 marker attr 跳过。 */
function applyMarkerWriteback(tr: Transaction, from: number, to: number, source: string, schema: EditorState['schema']): Transaction {
  const strongMarker = detectMarker(source, 'strong')
  const emphMarker = detectMarker(source, 'emphasis')
  const strongType = schema.marks.strong
  const emphType = schema.marks.emphasis
  // 先在 tr.doc 快照上收集带 strong / emphasis 的 text span(避免边改边迭代)
  const spans: Array<[number, number, 'strong' | 'emphasis']> = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    if (node.marks.some(m => m.type.name === 'strong')) spans.push([pos, pos + node.nodeSize, 'strong'])
    if (node.marks.some(m => m.type.name === 'emphasis')) spans.push([pos, pos + node.nodeSize, 'emphasis'])
  })
  for (const [s, e, kind] of spans) {
    const type = kind === 'strong' ? strongType : emphType
    const marker = kind === 'strong' ? strongMarker : emphMarker
    tr = tr.removeMark(s, e, type)
    tr = tr.addMark(s, e, type.create({ marker }))
  }
  return tr
}

/** 把源码解析回 inline nodes 并替换 [editFrom, editTo]。返回是否成功重建
 *  (fromMarkdown 总能产出 nodes,即使是纯文本)。 */
function commitMarkEdit(view: EditorView): void {
  const pluginState = markSourceEditKey.getState(view.state)
  if (!pluginState?.session) return
  const { editFrom, editTo } = pluginState.session
  const sourceText = view.state.doc.textBetween(editFrom, editTo, '\n', '\n')

  // 先用 commit meta 把 state 清掉 —— 避免 commit 自己 dispatch 的 tr 又触发 view.update
  let tr = view.state.tr.setMeta(markSourceEditKey, { type: 'commit' } as const)

  const innerDoc = fromMarkdown(sourceText, view.state.schema)
  const paragraph = innerDoc.firstChild
  const inlineNodes: PMNode[] = []
  paragraph?.forEach(child => inlineNodes.push(child))

  if (inlineNodes.length === 0) {
    // 空源码 → 删空 range(PM 不留空 text node),光标靠 mapping 落 editFrom(范围起点前)
    tr = tr.delete(editFrom, editTo)
  }
  else {
    tr = tr.delete(editFrom, editTo)
    let cursor = editFrom
    for (const node of inlineNodes) {
      tr = tr.insert(cursor, node)
      cursor += node.nodeSize
    }
    // 回写 marker attr:fromMarkdown 默认 marker:'*',按源码实际分隔符改回
    const restoredTo = editFrom + inlineNodes.reduce((s, n) => s + n.nodeSize, 0)
    tr = applyMarkerWriteback(tr, editFrom, restoredTo, sourceText, view.state.schema)
  }
  // 关键:不调 setSelection —— 靠 tr.mapping 把用户已移到范围外的光标重映射。
  // 右离开:终点 = P - S + L >= editFrom + L + 1,严格过还原 mark 末尾 → 不重进。
  // 左离开:终点 = P <= editFrom - 1,严格在 mark 起点前(inclusive 左边界不含 mark)→ 不重进。
  // 双保险:commit tr 自身 docChanged → enter 守卫 (selectionChanged && !docChanged) 为假。
  view.dispatch(tr)
}

export const markSourceEditPlugin = new Plugin<MarkSourceEditState>({
  key: markSourceEditKey,

  state: {
    init() {
      return emptyState()
    },

    apply(tr, value, _oldState, newState) {
      const meta = tr.getMeta(markSourceEditKey) as
        | { type: 'start', session: MarkSourceEditSession }
        | { type: 'commit' | 'cancel' }
        | undefined

      if (meta?.type === 'start') {
        return { session: meta.session, pendingCommit: null }
      }
      if (meta?.type === 'commit' || meta?.type === 'cancel') {
        return emptyState()
      }
      if (!value.session) return value

      // 普通事务:editFrom +1 bias / editTo -1 bias 过 mapping(边界键入字符留在范围外)
      const session = value.session
      const editFrom = tr.mapping.map(session.editFrom, 1)
      const editTo = tr.mapping.map(session.editTo, -1)
      const updated: MarkSourceEditSession = { ...session, editFrom, editTo }

      const sel = newState.selection
      const inside = sel.from >= editFrom && sel.to <= editTo
      return { session: updated, pendingCommit: inside ? null : updated }
    },
  },

  props: {
    decorations(state) {
      const pluginState = markSourceEditKey.getState(state)
      if (!pluginState?.session) return DecorationSet.empty
      const { editFrom, editTo } = pluginState.session
      return DecorationSet.create(state.doc, [
        Decoration.inline(editFrom, editTo, { 'data-mark-source-edit': '' }),
      ])
    },
  },

  // 光标进入 mark → 换源码进 session。走 appendTransaction(同步、PM 惯用通道),
  // 且让 syntaxAutoFormat 退避自动生效(getActiveEditRange 读 newState,pass 2 已有 session)。
  appendTransaction(transactions, _oldState, newState) {
    // 阅读模式下不展开源码:view.editable=false 时光标进入 mark 范围不换源码字符,保持渲染态。
    if (editorView && !editorView.editable) return null
    // 守卫 (a):已开会话不重复进
    if (markSourceEditKey.getState(newState)?.session) return null
    // 守卫 (b):仅纯选区变化(方向键 / 点击)触发;键入 / IME / 粘贴是 docChanged 不触发
    // —— 保住 Ctrl+B 连续输入(inclusive 边界继承)。commit tr 自身 docChanged 也不触发。
    const moved = transactions.some(t => t.selectionSet && !t.docChanged)
    if (!moved) return null
    const sel = newState.selection
    if (!sel.empty) return null
    const head = sel.head
    if (isBlacklisted(newState, head)) return null
    if (inOtherEditSession(newState, head)) return null
    // link 自有 session,buildMarkSource 不处理 link 语法 —— 光标在 link 内不进
    if (newState.doc.resolve(head).marks().some(m => m.type.name === 'link')) return null

    const target = pickOutermostTargetMark(newState, head)
    if (!target) return null
    const { mark, start: markStart, end: markEnd } = target

    const source = buildMarkSource(newState.doc, markStart, markEnd)
    if (!source) return null
    const openDelim = markerText(mark) ?? ''
    const delimLen = openDelim.length

    // 光标在源码内的落点:右边界(markEnd)→ 源码末尾过闭分隔符(typing 落 mark 外不继承);
    // 内部 → 过开分隔符的映射位(typing 落 mark 内保留 mark)。左边界(markStart)不触发 enter。
    const cursorPos = head === markEnd
      ? markStart + source.length
      : markStart + (head - markStart) + delimLen

    let tr = newState.tr.delete(markStart, markEnd).insertText(source, markStart)
    tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos))
    // 瞬时视图切换(mark→源码文本)不触发内容回写,否则纯文本 `**` 被转义误判 dirty
    tr = tr.setMeta(SKIP_CONTENT_EMIT, true)
    tr = tr.setMeta(markSourceEditKey, {
      type: 'start' as const,
      session: {
        editFrom: markStart,
        editTo: markStart + source.length,
        originalSource: source,
      },
    })
    return tr
  },

  view(initialView) {
    editorView = initialView
    return {
      update(view) {
        const pluginState = markSourceEditKey.getState(view.state)
        if (pluginState?.pendingCommit) {
          commitMarkEdit(view)
        }
      },
      destroy() {
        editorView = null
      },
    }
  },
})

/** Escape → 还原成 originalSource 对应的 marks(放弃编辑)。
 *  复用 commit-restore 路径作用在 originalSource 上(带 marker 回写),
 *  然后 setSelection(editFrom) —— mapping 不安全(光标在源码内,会落回还原 mark 内 → 重进),
 *  editFrom 是 inclusive 左边界,resolve(editFrom) 不含目标 mark → 不重进。 */
export const markSourceEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = markSourceEditKey.getState(state)
    if (!pluginState?.session) return false
    const { editFrom, editTo, originalSource } = pluginState.session
    if (!dispatch) return true

    const innerDoc = fromMarkdown(originalSource, state.schema)
    const paragraph = innerDoc.firstChild
    const inlineNodes: PMNode[] = []
    paragraph?.forEach(child => inlineNodes.push(child))

    let tr = state.tr.setMeta(markSourceEditKey, { type: 'cancel' } as const)
    tr = tr.delete(editFrom, editTo)
    if (inlineNodes.length > 0) {
      let cursor = editFrom
      for (const node of inlineNodes) {
        tr = tr.insert(cursor, node)
        cursor += node.nodeSize
      }
      const restoredTo = editFrom + inlineNodes.reduce((s, n) => s + n.nodeSize, 0)
      tr = applyMarkerWriteback(tr, editFrom, restoredTo, originalSource, state.schema)
    }
    // mapping 不安全:光标原本在源码内,会落回还原 mark 内 → 立即重进。
    // 显式落 editFrom(inclusive 左边界,不含目标 mark)。
    tr = tr.setSelection(TextSelection.create(tr.doc, editFrom))
    dispatch(tr)
    return true
  },
})

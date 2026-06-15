// Markdown 链接点击行为 — Obsidian 风格的 inline source edit。
//
// 用户交互流程:
//   1. 普通单击链接 → 把渲染好的链接替换成 markdown 源码文本 [text](url),
//      光标落进 `[` 之后,Decoration 在源码文本上加 .velo-link-source-edit
//      视觉指示这是"编辑源码"态。
//   2. Ctrl/Cmd + 单击 = 跳转(行为保持不变):
//      - href 以 # 开头 → 文档内 querySelector 找 heading[id] → scrollIntoView
//      - 其他 → 调 @tauri-apps/plugin-shell 的 open() 用系统浏览器打开
//   3. 在编辑态下:
//      - 用户编辑文本 → 普通 transaction,plugin state 自动跟随位置
//      - 光标移出 [text](url) 范围 → apply 检测到,view.update 触发 commit
//      - commit:解析源码,如果是合法 [text](url) 就用 text + link mark 替换;
//        如果解析失败(用户改坏了),保留为纯文本,不强行还原
//      - Escape → keymap 拦截,直接还原成点击前的源码文本(放弃编辑)
//
// 设计要点:
//  - 走 handleDOMEvents.click 而不是 NodeView,因为 link 是 inline mark,可以
//    嵌套在 emphasis/strong/code 里,NodeView 只能挂叶子节点。
//  - 修饰键约定:ctrlKey || metaKey(沿用 FootnoteNodeViews 的处理方式)。
//  - 编辑态状态用 Plugin.state 持有,生命周期跟 EditorState 一致 —— 切文件
//    inner 重建时,旧的 session 自然随旧 state 一起消失,不会泄漏到新视图。
//  - 嵌入式格式(链接里的 **bold** / `code`)保留:用 markdownIO.toMarkdown 反
//    序列化源码,用 fromMarkdown 重解析 commit 后的内层文本,得到含 marks 的
//    inline nodes,再贴 link mark。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { MarkType, Node as PMNode, ResolvedPos } from 'prosemirror-model'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { keymap } from 'prosemirror-keymap'
import { open } from '@tauri-apps/plugin-shell'
import { fromMarkdown, toMarkdown } from '../editor/markdownIO'

export const linkClickPluginKey = new PluginKey('linkClick')

/**
 * 一个正在被编辑的链接的元信息。
 *  - editFrom/editTo: 源码文本在当前 doc 里的范围(随用户编辑随动)
 *  - href: 跳转目标,commit 时回写到 link mark
 *  - originalSource: 用户点击瞬间的源码(供 Escape 还原用)
 */
interface LinkEditSession {
  editFrom: number
  editTo: number
  href: string
  originalSource: string
}

interface LinkEditState {
  session: LinkEditSession | null
  /**
   * apply 检测到光标已经移出 edit 范围,标记一下等下一次 view.update 触发 commit。
   * 不能在 apply 里直接 view.dispatch,会陷入 dispatch → apply → dispatch 循环。
   */
  pendingCommit: LinkEditSession | null
}

function emptyState(): LinkEditState {
  return { session: null, pendingCommit: null }
}

export const linkClickPlugin = new Plugin<LinkEditState>({
  key: linkClickPluginKey,

  state: {
    init() {
      return emptyState()
    },

    apply(tr, value, _oldState, newState) {
      const meta = tr.getMeta(linkClickPluginKey) as
        | { type: 'start', session: LinkEditSession }
        | { type: 'commit' | 'cancel' }
        | undefined

      if (meta?.type === 'start') {
        return { session: meta.session, pendingCommit: null }
      }

      if (meta?.type === 'commit' || meta?.type === 'cancel') {
        return emptyState()
      }

      if (!value.session) return value

      // 普通事务下,把 session 的位置随 tr.mapping 平移
      // bias 关键:在边界处插入的字符**不应**被纳入 edit 范围,否则
      // decoration 扩展到新字符上(用户感知为"在链接后输入也带编辑样式")。
      //  - editFrom 用 +1:在 editFrom 处插入 → editFrom 右移 → 新字符在范围之外
      //  - editTo 用 -1:在 editTo 处插入 → editTo 不动 → 新字符在范围之外
      const session = value.session
      const editFrom = tr.mapping.map(session.editFrom, 1)
      const editTo = tr.mapping.map(session.editTo, -1)
      const updated: LinkEditSession = { ...session, editFrom, editTo }

      // 光标在编辑范围之外 → 标记等 view.update 触发 commit
      const sel = newState.selection
      const inside = sel.from >= editFrom && sel.to <= editTo
      return { session: updated, pendingCommit: inside ? null : updated }
    },
  },

  props: {
    handleDOMEvents: {
      click(view, event) {
        return handleLinkClick(view, event as MouseEvent)
      },
    },

    decorations(state) {
      const pluginState = linkClickPluginKey.getState(state)
      if (!pluginState?.session) return DecorationSet.empty
      const { editFrom, editTo } = pluginState.session
      return DecorationSet.create(state.doc, [
        Decoration.inline(editFrom, editTo, { class: 'velo-link-source-edit' }),
      ])
    },
  },

  view(_view) {
    return {
      update(view) {
        const pluginState = linkClickPluginKey.getState(view.state)
        if (pluginState?.pendingCommit) {
          commitLinkEdit(view)
        }
      },
    }
  },
})

/** Escape → 还原点击瞬间的源码文本,放弃编辑 */
export const linkEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = linkClickPluginKey.getState(state)
    if (!pluginState?.session) return false

    const { editFrom, editTo, originalSource } = pluginState.session
    if (dispatch) {
      const tr = state.tr
        .delete(editFrom, editTo)
        .insertText(originalSource, editFrom)
        .setMeta(linkClickPluginKey, { type: 'cancel' } as const)
        .setSelection(TextSelection.create(state.tr.doc, editFrom + 1))
      dispatch(tr)
    }
    return true
  },
})

// ============================================================
//  Click handler
// ============================================================

function handleLinkClick(view: EditorView, event: MouseEvent): boolean {
  const anchor = findAnchor(view, event.target)
  if (!anchor) return false

  const href = anchor.getAttribute('href')
  if (!href) return false

  event.preventDefault()

  // Ctrl/Cmd + 点击 → 跳转(行为保持不变)
  if (event.ctrlKey || event.metaKey) {
    if (href.startsWith('#')) {
      scrollToAnchor(view, href.slice(1))
    }
    else {
      void openExternal(href)
    }
    return true
  }

  // 普通点击 → 进入 inline source edit
  startLinkEdit(view, event)
  return true
}

function startLinkEdit(view: EditorView, event: MouseEvent): void {
  const linkMark = view.state.schema.marks.link

  // 1. 主路径:click 坐标 → doc 位置。真实浏览器布局敏感,即使 link 嵌在 list_item /
  //    blockquote 等复杂结构里也能正确解析
  //    posAtCoords 内部用 document.elementFromPoint —— jsdom 不实现,会抛 TypeError,
  //    catch 后走 fallback 路径
  let pos: number | null = null
  try {
    const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
    if (coords) {
      const $p = view.state.doc.resolve(coords.pos)
      if (linkMark.isInSet($p.marks())) pos = coords.pos
    }
  }
  catch {
    /* jsdom or other layout-less env: fall through to text-node fallback */
  }

  // 2. fallback:从 anchor 的 text 子节点找位置 —— posAtDOM 在 text node 上
  //    比 posAtDOM 在 element 上更准确,jsdom 无布局时也走这条
  if (pos == null) {
    const anchorEl = findAnchor(view, event.target)
    if (anchorEl) {
      for (const child of Array.from(anchorEl.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE || !child.textContent) continue
        const textPos = view.posAtDOM(child, 0)
        if (textPos == null) continue
        const $p = view.state.doc.resolve(textPos)
        if (linkMark.isInSet($p.marks())) {
          pos = textPos
          break
        }
      }
    }
  }

  if (pos == null) return

  const $pos = view.state.doc.resolve(pos)
  const range = findLinkRange($pos, linkMark)
  if (!range) return
  const [from, to] = range

  const href = $pos.marks().find(m => m.type === linkMark)?.attrs.href as string ?? ''
  const source = buildLinkSource(view, from, to, href)

  // 替换为源码文本,光标落在 `[` 之后
  const cursorPos = from + 1
  let tr = view.state.tr.delete(from, to).insertText(source, from)
  tr = tr.setSelection(TextSelection.create(tr.doc, cursorPos))
  tr = tr.setMeta(linkClickPluginKey, {
    type: 'start' as const,
    session: {
      editFrom: from,
      editTo: from + source.length,
      href,
      originalSource: source,
    },
  })

  view.dispatch(tr)
}

/** 把 [editFrom, editTo] 范围解析回链接或纯文本。供 view.update 在 apply 检测到光标离开后调用。 */
function commitLinkEdit(view: EditorView): void {
  const pluginState = linkClickPluginKey.getState(view.state)
  if (!pluginState?.session) return

  const { editFrom, editTo } = pluginState.session
  const sourceText = view.state.doc.textBetween(editFrom, editTo, '\n', '\n')

  // 先用 commit meta 把 state 清掉 —— 避免 commit 自己 dispatch 出的 tr 又触发 view.update
  let tr: Transaction = view.state.tr.setMeta(linkClickPluginKey, { type: 'commit' as const })

  const parsed = parseLinkSource(sourceText)
  if (!parsed) {
    // 源码破坏,放弃 link 还原 —— 让用户保留为纯文本
    view.dispatch(tr)
    return
  }

  // 用 markdownIO 解析内层文本,得到含 marks 的 inline nodes
  const innerDoc = fromMarkdown(parsed.text, view.state.schema)
  const paragraph = innerDoc.firstChild
  const inlineNodes: PMNode[] = []
  paragraph?.forEach(child => inlineNodes.push(child))

  tr = tr.delete(editFrom, editTo)

  if (inlineNodes.length === 0) {
    // 空链接,只插 link mark 不带文本(罕见)
    tr = tr.setSelection(TextSelection.create(tr.doc, editFrom))
    view.dispatch(tr)
    return
  }

  // 计算 inline nodes 的总大小,以便正确贴 link mark
  // PM 中 inline node 的位置:节点自身的 pos..pos+nodeSize
  let cursor = editFrom
  const linkMark = view.state.schema.marks.link.create({ href: parsed.href })
  for (const node of inlineNodes) {
    tr = tr.insert(cursor, node)
    if (node.isText) {
      tr = tr.addMark(cursor, cursor + node.nodeSize, linkMark)
    }
    cursor += node.nodeSize
  }
  tr = tr.setSelection(TextSelection.create(tr.doc, editFrom + 1))
  view.dispatch(tr)
}

// ============================================================
//  Helpers
// ============================================================

/**
 * 沿 DOM 向上找最近的 <a href>,停在 view.dom 边界(view.dom 之外的点击不归我们管)。
 */
function findAnchor(view: EditorView, target: EventTarget | null): HTMLAnchorElement | null {
  let el = target as Element | null
  while (el && el !== view.dom) {
    if (el instanceof HTMLAnchorElement) return el
    el = el.parentElement
  }
  return null
}

/**
 * 找点击位置所在 link mark 的连续范围(同一父节点内的所有带 link mark 的子节点合并)。
 *  - 跨 block 的 link 在 PM 里不合法,这里不处理
 *  - 父节点通常是 paragraph,但 list_item / heading 也兼容
 */
function findLinkRange($pos: ResolvedPos, markType: MarkType): [number, number] | null {
  if (!markType.isInSet($pos.marks())) return null

  const parent = $pos.parent
  const offsetInParent = $pos.parentOffset
  const parentStart = $pos.start()

  let from = offsetInParent
  let to = offsetInParent

  parent.forEach((child: PMNode, offset: number) => {
    if (!markType.isInSet(child.marks)) return
    const childStart = offset
    const childEnd = offset + child.nodeSize
    // 简单做法:与当前范围重叠或相邻就合并
    if (childStart <= to && childEnd >= from) {
      from = Math.min(from, childStart)
      to = Math.max(to, childEnd)
    }
  })

  return [parentStart + from, parentStart + to]
}

/**
 * 把 [from, to] 范围(渲染态的 link 内容)序列化为 markdown 源码。
 * 例: `[**bold** text](url)` → "[**bold** text](url)"
 *
 * 关键:slice 里文本自带 link mark,直接 toMarkdown 会再包一层成 [[..]](url),
 * 所以序列化前先剥掉 link mark,保留其他 mark(bold / italic / code / ...)。
 */
function buildLinkSource(view: EditorView, from: number, to: number, href: string): string {
  const slice = view.state.doc.slice(from, to)
  const schema = view.state.schema
  const linkMarkType = schema.marks.link
  const paragraphChildren: PMNode[] = []
  slice.content.forEach((child) => {
    if (child.isText) {
      const filteredMarks = child.marks.filter(m => m.type !== linkMarkType)
      paragraphChildren.push(schema.text(child.text ?? '', filteredMarks))
    }
    else {
      paragraphChildren.push(child)
    }
  })
  const paragraph = schema.node('paragraph', null, paragraphChildren)
  const doc = schema.node('doc', null, [paragraph])
  const md = toMarkdown(doc)
  // toMarkdown 会带尾随换行,strip 掉
  const text = md.replace(/\n+/g, '').trim()
  return `[${text}](${href})`
}

/**
 * 解析 commit 时的源码文本。
 * 返回 { text, href } 或 null(用户改坏了)。
 * 仅匹配严格的 [text](url),title 字段暂不支持(后续可扩展)。
 */
function parseLinkSource(source: string): { text: string, href: string } | null {
  // 允许尾部空白,允许内层含 markdown 格式(用 non-greedy)
  const match = source.match(/^\[([\s\S]*?)\]\(([^()\s]*)\)\s*$/)
  if (!match) return null
  const text = match[1]
  const href = match[2]
  return { text, href }
}

/**
 * #anchor → view.dom 内查找 heading[id],命中则平滑滚动。
 */
function slugifyHeadingId(id: string): string {
  return id.toLowerCase().trim().replace(/\s+/g, '-')
}

function scrollToAnchor(view: EditorView, rawId: string): void {
  let id = rawId
  try {
    id = decodeURIComponent(rawId)
  }
  catch {
    /* 解不出来就用原值 */
  }

  const candidates = [id, slugifyHeadingId(id)]
  let target: Element | null = null
  for (const candidate of candidates) {
    target = view.dom.querySelector(`[id="${CSS.escape(candidate)}"]`)
    if (target) break
  }
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

/** 调系统浏览器打开外部 URL;失败仅 console.warn,不抛。 */
async function openExternal(url: string): Promise<void> {
  try {
    await open(url)
  }
  catch (e) {
    console.warn('[linkClick] failed to open', url, e)
  }
}

// ============================================================
//  历史:实时 [text](url) → link mark
//
//  v0.4.0 ~ v0.4.1 这里有一个 linkAutoFormatPlugin(全文 appendTransaction
//  扫描)+ 一个 @deprecated 的 linkInputRule。v0.4.1.x 起这两段都迁到
//  syntax registry(syntax/inline/link.ts),由 plugins/syntaxAutoFormat
//  统一调度。本文件只保留:
//   - linkClickPlugin / linkClickPluginKey:点击进入源码编辑态 + session 状态
//   - linkEditEscapeKeymap:Escape 退出编辑态
//
//  syntaxAutoFormatPlugin 通过 linkClickPluginKey.getState 读 session 范围,
//  与之相交的 textblock 不抢用户改源码 —— 这是 session 唯一的对外接口。
// ============================================================
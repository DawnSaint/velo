// 跨模式光标 + 浏览状态同步 —— 最佳努力文本锚点。
//
// WYSIWYG(ProseMirror)↔ 源代码模式(CodeMirror 6)切换时,App.vue 用 v-if 互换
// 两个编辑器,两边都卸载重挂,光标/滚动在 DOM 层必然丢失。本模块在切换前从
// **出**方向编辑器抓一个"文本锚点",切换后在**入**方向编辑器定位、恢复光标
// 并滚动到视口中央。**最佳努力**:定位失败静默放弃(留默认位置),不报错。
//
// ## 为什么用 token 序列 + LCS 对齐(而非整窗子串匹配)
//
// 两个编辑器渲染同一段 `documentStore.content`,但文本表示不同:
//   - CM6 = 原始 markdown 串(offset == pos,平凡)
//   - PM = 解析后的 prose(`doc.textBetween` 去 mark、块间 `\n`)
// 纯文字段落 / 标题 / 列表项两边词序列一致,但**带语法的结构**会插入对方没有的
// 文本,例如:
//   - 链接 `[text](url)`:CM6 侧多一个 URL token(`https://...`),PM 侧只有 link text
//   - 表格 `| a | b |`:CM6 侧残留 `|` token,PM 侧表格单元格没有
//   - 表格分隔行 `|---|---|`:CM6 侧的 `-`/`|`,PM 侧整行不存在
// 早期"归一化整串 + indexOf"方案里,这些多余 token 卡在光标窗口中间,对称 trim
// 砍不掉 → 整窗不命中 → 静默跳顶。
//
// 改用 token 序列 + LCS:两边各切成词 token(markdown 标记字符 `\`|`、`*`、`#`、
// `[]()` 等既是分隔符也剥除),取光标所在 token ±64 个 token 作锚点窗口,入方向
// 用最长公共子序列把锚点窗口与入方向全 token 对齐。多余 token(URL / `|` / 分隔
// 行)在 LCS 里自然落为"未对齐"被跳过,光标 token 映到对端对应 token。对任意
// 未来新语法都鲁棒,无需逐个 special-case。
//
// ## posMap:token → 编辑器真实 pos
//
// token 是归一化产物,LCS 命中的是 token 索引,要映回编辑器真实 pos。每个 token
// 记下它首字符在编辑器里的 pos;光标在 token 内的字符偏移(intraOffset)也一并
// 抓取,跨边界直接迁移(两边 token 文本相等,偏移可逐字复用)。
//
// ## 局限(最佳努力,失败静默放弃)
//
// - 光标 token 本身是"多余方"的 token(如 CM6 侧光标落在 URL 里)→ 该 token 对端
//   没有,LCS 不对齐;退到最近的对齐邻居 token 的边界。语义合理(URL 在对端不存在)。
// - 文档极大(token 数 > ~31k,LCS 矩阵超 4M 格)→ 跳过 LCS,退线性首现匹配。
// - 重复词较多的窗口,LCS 仍可能命中更早位置(v1 不做最近 tie-break)。

import { EditorView as CmEditorView } from '@codemirror/view'
import { EditorSelection as CmEditorSelection } from '@codemirror/state'
import { EditorView as PmEditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import type { Node as PmNode } from 'prosemirror-model'

// ============================================================
//  token 化:剥 markdown 标记字符、空白 / 标记作为分隔、保留词内字符
// ============================================================

/** markdown 标记字符集:标题 / 强调 / 删除线 / 行内代码 / 引用 / 列表 /
 *  链接语法括号 / 图片叹号 / **表格竖线 `|`**。两边一致剥除。
 *  `|` 入集是关键:否则 `|cell|cell`(无空格表格)会被粘成一个 token `cellcell`,
 *  与 PM 侧两个独立单元格 token 对不上。`|` 也作分隔符,把相邻单元格切开。
 *  `.` 不入集(有序列表 `1.` 的点要保留),两边一致即可。 */
const MARKER_CHARS = new Set('#*~_`-+[]()!>|')

function isMarker(ch: string): boolean {
  return MARKER_CHARS.has(ch)
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t'
}

interface Tok {
  /** token 文本(已剥标记、无空白)。 */
  text: string
  /** token 首字符在编辑器里的真实 pos。 */
  pos: number
}

interface TokAcc {
  buf: string
  start: number
  tokens: Tok[]
}

function newAcc(): TokAcc {
  return { buf: '', start: 0, tokens: [] }
}

/** 把一个字符喂进累加器。标记字符与空白都"冲刷并跳过"(作分隔符),
 *  不冲刷连续标记产生的空 run。`well-known` 两边都变 `well`+`known`(对称即可)。 */
function feedChar(ch: string, pos: number, acc: TokAcc): void {
  if (isMarker(ch) || isWs(ch)) {
    if (acc.buf) {
      acc.tokens.push({ text: acc.buf, pos: acc.start })
      acc.buf = ''
    }
    return
  }
  if (!acc.buf) acc.start = pos
  acc.buf += ch
}

function flush(acc: TokAcc): void {
  if (acc.buf) {
    acc.tokens.push({ text: acc.buf, pos: acc.start })
    acc.buf = ''
  }
}

// ============================================================
//  buildCmTokens / buildPmTokens
// ============================================================

function buildCmTokens(view: CmEditorView): Tok[] {
  const s = view.state.doc.toString()
  const acc = newAcc()
  for (let i = 0; i < s.length; i++) feedChar(s[i], i, acc)
  flush(acc)
  return acc.tokens
}

/** PM 侧:递归 walk,每个文本节点逐字符 feed;**所有兄弟节点之间**冲刷一次
 *  (块级兄弟自然分隔;行内兄弟也分隔 —— 行内 mark 边界对应 CM6 的标记字符位置,
 *  冲刷等价于 CM6 标记作分隔,两边一致)。
 *
 *  位置计算坑:**doc 是根,`doc.size == contentSize`(无开闭括号偏移),其子节点
 *  pos = offset**;非 doc 节点的子节点 pos = nodeStart + 1 + offset(+1 跳开括号)。
 *  故 doc 这层不走 walk 的 +1,直接 forEach 用 offset;嵌套层才走 walk 的 +1+offset。
 *  早期实现统一 `walk(doc,0)` + `+1+offset`,doc 子节点被多算 +1 → 整棵树 token.pos
 *  统一偏高 1 → S→W 落点 +1、W→S 落点 -1 的系统性位移。 */
function buildPmTokens(view: PmEditorView): Tok[] {
  const acc = newAcc()

  function walk(node: PmNode, pos: number): void {
    if (node.isText && node.text) {
      for (let k = 0; k < node.text.length; k++) feedChar(node.text[k], pos + k, acc)
      return
    }
    if (node.isLeaf) {
      const t = node.textContent
      for (let k = 0; k < t.length; k++) feedChar(t[k], pos + k, acc)
      return
    }
    let first = true
    node.forEach((child: PmNode, offset: number) => {
      if (!first) flush(acc)
      walk(child, pos + 1 + offset)
      first = false
    })
  }

  let first = true
  view.state.doc.forEach((child: PmNode, offset: number) => {
    if (!first) flush(acc)
    walk(child, offset)
    first = false
  })
  flush(acc)
  return acc.tokens
}

function buildTokens(view: PmEditorView | CmEditorView, kind: 'pm' | 'cm'): Tok[] {
  return kind === 'cm' ? buildCmTokens(view as CmEditorView) : buildPmTokens(view as PmEditorView)
}

// ============================================================
//  LCS 对齐:源 token 窗口 → 目标 token 数组
// ============================================================

/** 最长公共子序列对齐。返回 srcIdx → tgtIdx 的映射(未对齐的 src idx 不在 map 里)。
 *  返回 null 表示规模超阈值(目标过大),调用方退线性首现匹配。 */
function lcsAlign(src: string[], tgt: string[]): Map<number, number> | null {
  const n = src.length
  const m = tgt.length
  if (n === 0 || m === 0) return new Map()
  // 矩阵格数上限:超出则 bail(best-effort,避免大文档 OOM)
  if (n * m > 4_000_000) return null
  const dp: Int32Array[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    const ai = src[i - 1]
    const row = dp[i]
    const prev = dp[i - 1]
    for (let j = 1; j <= m; j++) {
      if (ai === tgt[j - 1]) row[j] = prev[j - 1] + 1
      else row[j] = prev[j] >= row[j - 1] ? prev[j] : row[j - 1]
    }
  }
  const map = new Map<number, number>()
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    if (src[i - 1] === tgt[j - 1]) {
      map.set(i - 1, j - 1)
      i--
      j--
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--
    else j--
  }
  return map
}

// ============================================================
//  captureAnchor / applyAnchor
// ============================================================

export interface CrossModeAnchor {
  /** 源侧光标窗口内的 token 文本序列(已归一化)。 */
  toks: string[]
  /** 光标 token 在 toks 里的索引。 */
  cursorIdx: number
  /** 光标在 cursor token 内的字符偏移(跨边界逐字迁移)。 */
  intraOffset: number
}

/** token 窗口半径(光标 token 两侧各取多少个 token)。±64 token 通常足以在文档里唯一。 */
const TOK_RADIUS = 64

/** 从出方向编辑器抓锚点。返回 null 表示无法抓取(空文档 / view 未就绪)。 */
export function captureAnchor(
  view: PmEditorView | CmEditorView | null | undefined,
  kind: 'pm' | 'cm',
): CrossModeAnchor | null {
  if (!view) return null
  const head =
    kind === 'cm'
      ? (view as CmEditorView).state.selection.main.head
      : (view as PmEditorView).state.selection.head
  const tokens = buildTokens(view, kind)
  if (tokens.length === 0) return null

  // 光标 token:最大的 i 使 tokens[i].pos <= head
  let i = 0
  while (i < tokens.length && tokens[i].pos <= head) i++
  const cursorIdx = Math.max(0, i - 1)
  const ct = tokens[cursorIdx]
  const intraOffset = Math.max(0, Math.min(head - ct.pos, ct.text.length))

  const start = Math.max(0, cursorIdx - TOK_RADIUS)
  const end = Math.min(tokens.length, cursorIdx + TOK_RADIUS + 1)
  const toks = tokens.slice(start, end).map((t) => t.text)
  return { toks, cursorIdx: cursorIdx - start, intraOffset }
}

/** 把锚点应用到入方向编辑器:设选区 + 滚动到视口中央。返回 false 表示未定位到
 *  (静默放弃)。token + LCS:多余 token(URL / `|` / 分隔行)被 LCS 跳过。 */
export function applyAnchor(
  view: PmEditorView | CmEditorView | null | undefined,
  kind: 'pm' | 'cm',
  anchor: CrossModeAnchor,
): boolean {
  if (!view) return false
  const target = buildTokens(view, kind)
  if (target.length === 0) return false
  if (anchor.toks.length === 0) return false

  const tgtTexts = target.map((t) => t.text)
  const map = lcsAlign(anchor.toks, tgtTexts)

  if (map) {
    const tgtIdx = map.get(anchor.cursorIdx)
    if (tgtIdx !== undefined) {
      // 光标 token 直接对齐 → 迁移 intraOffset
      const tt = target[tgtIdx]
      const intra = Math.max(0, Math.min(anchor.intraOffset, tt.text.length))
      placeCursor(view, kind, tt.pos + intra)
      return true
    }
    // 光标 token 未对齐(光标落在 URL / `|` 等"多余方"token 里)→
    // 向外找最近的对齐邻居,落在其边界(前邻居落尾、后邻居落首)。
    for (let d = 1; d <= anchor.toks.length; d++) {
      const lo = anchor.cursorIdx - d
      const hi = anchor.cursorIdx + d
      if (lo >= 0 && map.has(lo)) {
        const tt = target[map.get(lo)!]
        placeCursor(view, kind, tt.pos + tt.text.length)
        return true
      }
      if (hi < anchor.toks.length && map.has(hi)) {
        const tt = target[map.get(hi)!]
        placeCursor(view, kind, tt.pos)
        return true
      }
    }
    return false
  }

  // 矩阵超阈值(目标极大)→ 退线性首现匹配。best-effort,不保证唯一。
  const cursorText = anchor.toks[anchor.cursorIdx] ?? ''
  for (let k = 0; k < target.length; k++) {
    if (target[k].text === cursorText) {
      const intra = Math.max(0, Math.min(anchor.intraOffset, target[k].text.length))
      placeCursor(view, kind, target[k].pos + intra)
      return true
    }
  }
  return false
}

/** 设选区 + 滚动到视口中央。入方向编辑器主动 focus(手动居中滚动依赖 coordsAtPos,
 *  需 view 已布局;且 focus 让后续键入直落编辑器)。 */
function placeCursor(view: PmEditorView | CmEditorView, kind: 'pm' | 'cm', pos: number): void {
  if (kind === 'cm') {
    const v = view as CmEditorView
    v.focus()
    v.dispatch({
      selection: CmEditorSelection.cursor(pos),
      effects: CmEditorView.scrollIntoView(pos, { y: 'center' }),
    })
    return
  }
  const v = view as PmEditorView
  v.focus()
  // TextSelection.near:pos 落在块边界 / 非文本位置时退到最近可用文本光标
  const $pos = v.state.doc.resolve(pos)
  const sel = TextSelection.near($pos)
  // 不用 tr.scrollIntoView() —— ProseMirror 默认是"最小滚入视口",光标在视口
  // 下方时只刚好露到底边(表现成"光标行滚到最底下"),与 CM6 侧 {y:'center'} 不对称。
  // 改手动居中(同 FindReplace.scrollMatchIntoView 范式),两边都把光标拉到容器中线。
  v.dispatch(v.state.tr.setSelection(sel))
  centerScrollPm(v, sel.head)
}

/** PM 侧手动把光标滚到滚动容器中线(对齐 CM6 的 y:'center')。
 *  沿 DOM 向上找第一个 overflow-y:auto/scroll 的祖先,scrollBy 居中。 */
function centerScrollPm(view: PmEditorView, pos: number): void {
  const coords = view.coordsAtPos(pos)
  if (!coords) return
  let el: HTMLElement | null = view.dom as HTMLElement
  while (el && el !== document.body) {
    const style = getComputedStyle(el)
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      const containerRect = el.getBoundingClientRect()
      const cursorCenter = (coords.top + coords.bottom) / 2
      const containerCenter = containerRect.top + el.clientHeight / 2
      const delta = cursorCenter - containerCenter
      if (Math.abs(delta) > 4) el.scrollBy({ top: delta })
      return
    }
    el = el.parentElement
  }
}

// ============================================================
//  仅测试用:暴露归一化纯函数
// ============================================================

export function normalizeAnchor(s: string): string {
  const acc = newAcc()
  for (let i = 0; i < s.length; i++) feedChar(s[i], i, acc)
  flush(acc)
  return acc.tokens.map((t) => t.text).join(' ')
}

// 块级增量序列化：把「每次编辑全文档 toMarkdown」降为「脏块重序列化 + 净块缓存拼回」。
//
// 判净钥匙是 PM 结构共享：transaction 后未受影响的顶层块 newDoc.child(i) 与缓存
// 里的 node 引用相等，无需 hash / 指纹。块数变化（增删）或缓存缺失一律全量兜底 ——
// 增量永远是优化，不是正确性依赖。
//
// 正确性不变式（__tests__/blockSerializer.test.ts 守护，字节级）：
//   toMarkdownIncremental(doc).md === toMarkdown(doc)
// 文档级后处理（尾部空段补偿 / 空文档特例）复用 markdownIO.finalizeMarkdown，
// 不在块级另写一份公式。

import type { Node as PMNode, Schema } from 'prosemirror-model'
import {
  finalizeMarkdown,
  fromMarkdownAsyncWithBaseline,
  fromMarkdownWithBaseline,
  toMarkdown,
  type RawDocBaseline,
} from './markdownIO'

interface BlockEntry {
  node: PMNode
  /** 单块序列化串，已 trim 尾部换行 */
  md: string
}

export interface BlockCache {
  entries: BlockEntry[]
}

export interface IncrementalResult {
  md: string
  cache: BlockCache
  /** 是否走了增量路径（false = 全量重建） */
  hit: boolean
}

function serializeBlock(doc: PMNode, block: PMNode): string {
  // 单块 doc 走完整 toMarkdown（含 \u0001 还原与文档级收尾），再 trim 尾换行。
  // 这样块串与「该块在全文档 stringify 中的输出」字节一致，由不变式测试覆盖。
  const single = doc.type.schema.topNodeType.create(null, [block])
  return toMarkdown(single).replace(/\n+$/, '')
}

function rebuild(doc: PMNode): IncrementalResult {
  const entries: BlockEntry[] = []
  const parts: string[] = []
  doc.forEach(block => {
    const md = serializeBlock(doc, block)
    parts.push(md)
    entries.push({ node: block, md })
  })
  return { md: finalizeMarkdown(doc, parts.join('\n\n')), cache: { entries }, hit: false }
}

export function toMarkdownIncremental(doc: PMNode, cache?: BlockCache): IncrementalResult {
  if (!cache || cache.entries.length !== doc.childCount) return rebuild(doc)

  // 保守邻块失效：块边界语义（html 块 / 懒延续行 / setext）可能依赖相邻块，
  // 脏块前后各连带一块重算。单块序列化 0.02–0.06ms，代价可忽略。
  const invalidated = new Set<number>()
  for (let i = 0; i < doc.childCount; i++) {
    if (doc.child(i) === cache.entries[i].node) continue
    invalidated.add(i)
    if (i > 0) invalidated.add(i - 1)
    if (i + 1 < doc.childCount) invalidated.add(i + 1)
  }

  const entries: BlockEntry[] = []
  const parts: string[] = []
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i)
    const md = invalidated.has(i) ? serializeBlock(doc, block) : cache.entries[i].md
    parts.push(md)
    entries.push({ node: block, md })
  }
  return { md: finalizeMarkdown(doc, parts.join('\n\n')), cache: { entries }, hit: true }
}

// ---- per-doc 缓存槽 + 原文切片基线 ----
// 按 docId 隔离（多标签各自内容 / undo 互不影响）；Map 插入序做 LRU。
const caches = new Map<string, BlockCache>()
const MAX_CACHED_DOCS = 8

interface IndexedRawBaseline extends RawDocBaseline {
  nodeIndexMap: Map<PMNode, number[]>
}

const rawBaselines = new Map<string, IndexedRawBaseline>()
const MAX_BASELINE_DOCS = 64
const serializedNodeCache = new WeakMap<PMNode, string>()

export function getBlockCache(docId: string): BlockCache | undefined {
  return caches.get(docId)
}

export function setBlockCache(docId: string, cache: BlockCache): void {
  caches.delete(docId)
  caches.set(docId, cache)
  while (caches.size > MAX_CACHED_DOCS) {
    const oldest = caches.keys().next().value
    if (oldest === undefined) break
    caches.delete(oldest)
  }
}

/** 仅清空增量拼接缓存（如源码编辑占位符序列化期间），保留磁盘原文切片基线。 */
export function clearIncrementalBlockCache(docId: string): void {
  caches.delete(docId)
}

export function invalidateBlockCache(docId: string): void {
  caches.delete(docId)
  rawBaselines.delete(docId)
}

export function resetBlockCaches(): void {
  caches.clear()
  rawBaselines.clear()
}

function seedRawBaseline(docId: string, baseline: RawDocBaseline | null): void {
  rawBaselines.delete(docId)
  if (!baseline) return
  const nodeIndexMap = new Map<PMNode, number[]>()
  for (let i = 0; i < baseline.realBlocks.length; i++) {
    const node = baseline.realBlocks[i].node
    const list = nodeIndexMap.get(node)
    if (list) list.push(i)
    else nodeIndexMap.set(node, [i])
  }
  rawBaselines.set(docId, { ...baseline, nodeIndexMap })
  while (rawBaselines.size > MAX_BASELINE_DOCS) {
    const oldest = rawBaselines.keys().next().value
    if (oldest === undefined) break
    rawBaselines.delete(oldest)
  }
}

/** 解析 markdown 并为指定 docId 建立磁盘原文切片基线。 */
export function parseMarkdownForDoc(md: string, schema: Schema, docId: string): PMNode {
  caches.delete(docId)
  const { doc, baseline } = fromMarkdownWithBaseline(md, schema)
  seedRawBaseline(docId, baseline)
  return doc
}

/** Worker 异步解析 markdown 并为指定 docId 建立磁盘原文切片基线。 */
export async function parseMarkdownForDocAsync(
  md: string,
  schema: Schema,
  docId: string,
  opts?: { signal?: AbortSignal; timeout?: number },
): Promise<PMNode> {
  caches.delete(docId)
  const { doc, baseline } = await fromMarkdownAsyncWithBaseline(md, schema, opts)
  seedRawBaseline(docId, baseline)
  return doc
}

function serializeBlockWithEol(
  doc: PMNode,
  block: PMNode,
  eol: '\r\n' | '\n',
  useWeakCache: boolean,
): string {
  let lf = useWeakCache ? serializedNodeCache.get(block) : undefined
  if (lf === undefined) {
    lf = serializeBlock(doc, block)
    if (useWeakCache) serializedNodeCache.set(block, lf)
  }
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf
}

function serializeWithRawBaseline(
  doc: PMNode,
  baseline: IndexedRawBaseline,
  useWeakCache: boolean,
): string {
  const { eol, realBlocks: origReal, gaps, nodeIndexMap } = baseline
  const R = origReal.length

  // 1. 按「非空实体块 + 空段计数」切分当前 doc
  const curReal: PMNode[] = []
  const curEmptyCount: number[] = []
  let emptyRun = 0
  doc.forEach((child) => {
    if (child.type.name === 'paragraph' && child.childCount === 0) {
      emptyRun++
    }
    else {
      curEmptyCount.push(emptyRun)
      curReal.push(child)
      emptyRun = 0
    }
  })
  curEmptyCount.push(emptyRun)

  const M = curReal.length
  if (M === 0) {
    if (R === 0 && doc.childCount === baseline.allEmptyCount) return baseline.raw
    const md = toMarkdown(doc)
    return eol === '\r\n' ? md.replace(/\n/g, '\r\n') : md
  }

  // 2. 单调匹配当前实体块 → 初始实体块
  // Pass 1：PM 结构共享引用相等（O(M)）
  const matchedOrig = new Int32Array(M).fill(-1)
  if (R > 0) {
    let minOrig = 0
    for (let j = 0; j < M; j++) {
      const candidates = nodeIndexMap.get(curReal[j])
      if (!candidates) continue
      for (const idx of candidates) {
        if (idx >= minOrig) {
          matchedOrig[j] = idx
          minOrig = idx + 1
          break
        }
      }
    }

    // Pass 2：锚点间隙内用 PMNode.eq 兜底（覆盖 Undo / 输入再删回原状使 dirty 归零）
    let prevJ = -1
    let prevOrig = -1
    for (let j = 0; j <= M; j++) {
      const isEnd = j === M
      const anchorOrig = isEnd ? R : matchedOrig[j]
      if (!isEnd && anchorOrig < 0) continue
      if (j - prevJ > 1 && anchorOrig - prevOrig > 1) {
        let curMinOrig = prevOrig + 1
        for (let cj = prevJ + 1; cj < j && curMinOrig < anchorOrig; cj++) {
          const curNode = curReal[cj]
          for (let oi = curMinOrig; oi < anchorOrig; oi++) {
            const origNode = origReal[oi].node
            if (
              curNode.type === origNode.type
              && curNode.content.size === origNode.content.size
              && curNode.eq(origNode)
            ) {
              matchedOrig[cj] = oi
              curMinOrig = oi + 1
              break
            }
          }
        }
      }
      prevJ = j
      prevOrig = anchorOrig
    }
  }

  // Pass 3：槽位对齐（slotOrig）—— 原地编辑某块内容但块数未增减时，相邻空行间隙仍复用原文
  const slotOrig = new Int32Array(matchedOrig)
  if (R > 0) {
    let prevJ = -1
    let prevOrig = -1
    for (let j = 0; j <= M; j++) {
      const isEnd = j === M
      const anchorOrig = isEnd ? R : slotOrig[j]
      if (!isEnd && anchorOrig < 0) continue
      const spanLen = j - prevJ - 1
      if (spanLen > 0 && spanLen === anchorOrig - prevOrig - 1) {
        for (let k = 1; k <= spanLen; k++) {
          slotOrig[prevJ + k] = prevOrig + k
        }
      }
      prevJ = j
      prevOrig = anchorOrig
    }
  }

  // 3. 判定各原始空白间隙是否原样保留
  const leadPreserved = R > 0 && slotOrig[0] === 0 && curEmptyCount[0] === gaps[0].emptyCount

  const interGapOrig = new Int32Array(Math.max(0, M - 1)).fill(-1)
  if (R > 0) {
    for (let j = 0; j < M - 1; j++) {
      const leftOrig = slotOrig[j]
      const rightOrig = slotOrig[j + 1]
      if (
        leftOrig >= 0
        && rightOrig === leftOrig + 1
        && curEmptyCount[j + 1] === gaps[rightOrig].emptyCount
      ) {
        const gapRaw = gaps[rightOrig].raw
        const hasBlankSep = /\n[^\S\n]*\n/.test(gapRaw)
        const sameTypes = (matchedOrig[j] === leftOrig || curReal[j].type === origReal[leftOrig].node.type)
          && (matchedOrig[j + 1] === rightOrig || curReal[j + 1].type === origReal[rightOrig].node.type)
        if (hasBlankSep || sameTypes) {
          interGapOrig[j] = rightOrig
        }
      }
    }
  }

  const tailPreserved = R > 0
    && slotOrig[M - 1] === R - 1
    && curEmptyCount[M] === gaps[R].emptyCount

  // 4. 拼接全文：净块与净间隙逐字节复用原文切片，脏块单独走 toMarkdown
  let out = leadPreserved ? gaps[0].raw : eol.repeat(curEmptyCount[0])
  for (let j = 0; j < M; j++) {
    const oi = matchedOrig[j]
    if (oi >= 0) {
      out += origReal[oi].raw
    }
    else {
      out += serializeBlockWithEol(doc, curReal[j], eol, useWeakCache)
    }
    if (j < M - 1) {
      const gapOi = interGapOrig[j]
      out += gapOi >= 0 ? gaps[gapOi].raw : eol.repeat(2 * curEmptyCount[j + 1] + 2)
    }
  }
  const tailEmpty = curEmptyCount[M]
  out += tailPreserved
    ? gaps[R].raw
    : (tailEmpty > 0 ? eol.repeat(2 * tailEmpty + 1) : eol)
  return out
}

/**
 * 源码编辑占位符路径专用：复用原文切片基线（若存在），但不把含临时占位符的脏块写入缓存。
 */
export function serializeDocTransient(doc: PMNode, docId: string): string {
  const baseline = rawBaselines.get(docId)
  if (baseline) return serializeWithRawBaseline(doc, baseline, false)
  return toMarkdown(doc)
}

/** 调用点入口：优先走原文切片保真路径；无原文基线时走纯块级增量缓存。 */
export function serializeDocIncremental(doc: PMNode, docId: string): string {
  const baseline = rawBaselines.get(docId)
  if (baseline) {
    // 同步维护 LRU 顺序
    rawBaselines.delete(docId)
    rawBaselines.set(docId, baseline)
    return serializeWithRawBaseline(doc, baseline, true)
  }
  const result = toMarkdownIncremental(doc, getBlockCache(docId))
  setBlockCache(docId, result.cache)
  return result.md
}

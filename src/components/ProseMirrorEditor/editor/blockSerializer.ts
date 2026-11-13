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

import type { Node as PMNode } from 'prosemirror-model'
import { finalizeMarkdown, toMarkdown } from './markdownIO'

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

// ---- per-doc 缓存槽 ----
// 按 docId 隔离（多标签各自内容 / undo 互不影响）；Map 插入序做 LRU，
// 标签关闭后即便不显式清理也不会无限增长。
const caches = new Map<string, BlockCache>()
const MAX_CACHED_DOCS = 8

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

export function invalidateBlockCache(docId: string): void {
  caches.delete(docId)
}

export function resetBlockCaches(): void {
  caches.clear()
}

/** 调用点入口：按 docId 取缓存 → 增量序列化 → 回填缓存。 */
export function serializeDocIncremental(doc: PMNode, docId: string): string {
  const result = toMarkdownIncremental(doc, getBlockCache(docId))
  setBlockCache(docId, result.cache)
  return result.md
}

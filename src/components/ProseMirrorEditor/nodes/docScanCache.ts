// 大文档性能优化:单次 doc.descendants() 遍历,结果供所有 decoration 插件共享。
//
// PM doc 是不可变的——docChanged transaction 产生新 doc 对象,未变的 transaction
// (selection-only / setMeta) 保持同一 doc 引用。利用这个特性做身份缓存:
// doc === cachedDoc 时直接返回上次的扫描结果,避免重复遍历。
//
// 当前 7 个 decoration 插件各自在 decorations(state) 里跑 doc.descendants(),
// 大文档下等于 7 次全量遍历。本模块把它们合并为 1 次:第一个调用的插件触发
// 扫描,后续插件命中缓存。
//
// 设计要点:
// - 缓存键是 doc 对象身份(===),不是内容 hash——零开销
// - 存储的是 { pos, node } 对,node 引用是安全的(PM node 不可变)
// - 不做 dirty-range 增量更新(Tier 2 才做),只在 doc 变化时全量重扫

import type { Node as PMNode } from 'prosemirror-model'

export interface NodeEntry {
  pos: number
  node: PMNode
}

export interface ScanResult {
  codeBlocks: NodeEntry[]
  frontmatters: NodeEntry[]
  headings: NodeEntry[]
  listItems: NodeEntry[]
  tocs: NodeEntry[]
  foldPlaceholders: NodeEntry[]
}

const EMPTY: ScanResult = {
  codeBlocks: [],
  frontmatters: [],
  headings: [],
  listItems: [],
  tocs: [],
  foldPlaceholders: [],
}

let cachedDoc: PMNode | null = null
let cachedResult: ScanResult | null = null

/**
 * 单次遍历 doc,收集所有 decoration 插件需要的节点。
 * doc 不变时(=== 身份相等)直接返回缓存。
 */
export function scanDoc(doc: PMNode): ScanResult {
  if (doc === cachedDoc && cachedResult) return cachedResult

  const result: ScanResult = {
    codeBlocks: [],
    frontmatters: [],
    headings: [],
    listItems: [],
    tocs: [],
    foldPlaceholders: [],
  }

  doc.descendants((node: PMNode, pos: number) => {
    switch (node.type.name) {
      case 'code_block':
        result.codeBlocks.push({ pos, node })
        break
      case 'frontmatter':
        result.frontmatters.push({ pos, node })
        break
      case 'heading':
        result.headings.push({ pos, node })
        break
      case 'list_item':
        result.listItems.push({ pos, node })
        break
      case 'toc':
        result.tocs.push({ pos, node })
        break
      case 'fold_placeholder':
        result.foldPlaceholders.push({ pos, node })
        break
    }
  })

  cachedDoc = doc
  cachedResult = result
  return result
}

/** 清除缓存(组件卸载时调,防止 doc 引用泄漏)。 */
export function invalidateScanCache(): void {
  cachedDoc = null
  cachedResult = null
}

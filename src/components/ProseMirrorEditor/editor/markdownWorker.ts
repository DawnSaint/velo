// Web Worker: markdown parse 后台化。
//
// 只负责 processor.parse(md) + processor.runSync(tree) —— 这是大文档打开时的
// 主线程瓶颈（remark-parse 的 micromark tokenizer 是纯 CPU 同步任务）。
//
// 通信协议：
// 主线程 → Worker: { id: number, md: string }
// Worker → 主线程: { id: number, tree: Root | null, error?: string }
//
// tree 是 mdast Root 节点（纯 JSON 可结构化克隆），主线程收到后执行
// annotateMathDelimiterCount + mdastBlockToPM（需要 schema，不能在 Worker 做）。

/// <reference lib="webworker" />

import type { Root } from 'mdast'
import { createParseProcessor } from './parseProcessor'

const processor = createParseProcessor()

self.onmessage = (e: MessageEvent<{ id: number; md: string }>) => {
  const { id, md } = e.data
  try {
    const parsed = processor.parse(md) as Root
    const tree = processor.runSync(parsed) as Root
    ;(self as unknown as Worker).postMessage({ id, tree })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({
      id,
      tree: null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

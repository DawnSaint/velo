// 目录层遍历的并发限流器。单层可能有上万个目录,直接 Promise.all 会一次发出
// 上万个 Tauri fs IPC,反而打爆;固定数量的 worker 把并发压到 limit。
// 结果按输入下标保序,保证按层 BFS 的输出顺序与串行版一致。

export const WALK_CONCURRENCY = 8

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      if (shouldStop?.()) return
      const index = next++
      results[index] = await fn(items[index])
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

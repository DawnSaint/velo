// CodeMirror 6 文档变化订阅 —— 镜像 ProseMirror 侧 findHighlight.ts 的
// subscribeFindDocChange,供查找替换面板打开期间重算 matches。
//
// 为什么需要:cmFindHighlightField 靠 deco.map(tr.changes) 让高亮「跟住」文档变化,
// 但那只修视觉,FindReplace 缓存的 matches 坐标仍是旧值。面板打开时用户继续输入
// → 必须重算 findMatches 并重推高亮,否则导航 / 替换会落在错位的坐标上。
//
// 为什么 120ms trailing debounce:resyncMatches 里的 findMatches 是全文正则扫描,
// 逐键同步重算会给刚优化完的源码模式重新引入输入卡顿。只在 docChanged 时按 view
// 维度做 trailing 合并:连续打字只在停顿后通知一次。
//
// 通知回调里 setHighlight 只 dispatch effect(docChanged=false),不会再触发本
// updateListener → 无自激循环。订阅表与计时器都按 view 存 WeakMap,view 销毁后
// 不留强引用;取消订阅(或最后一个订阅者离开)会清掉待触发的计时器,不再通知。

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

type DocChangeListener = () => void

const DEBOUNCE_MS = 120

const docChangeListeners = new WeakMap<EditorView, Set<DocChangeListener>>()
const pendingTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>()

/** 装进 CM6 extensions 的扩展:doc 变化时按 view 维度 trailing-debounce 通知订阅者。 */
export const cmDocChangeExtension: Extension = EditorView.updateListener.of((u) => {
  if (!u.docChanged) return
  const view = u.view
  const prev = pendingTimers.get(view)
  if (prev !== undefined) clearTimeout(prev)
  const timer = setTimeout(() => {
    pendingTimers.delete(view)
    const listeners = docChangeListeners.get(view)
    if (!listeners?.size) return
    for (const cb of [...listeners]) cb()
  }, DEBOUNCE_MS)
  pendingTimers.set(view, timer)
})

/** 订阅 CM6 文档变化,返回取消订阅函数。取消后(含最后一个订阅者离开)不再通知。 */
export function subscribeCmDocChange(view: EditorView, cb: DocChangeListener): () => void {
  let set = docChangeListeners.get(view)
  if (!set) {
    set = new Set()
    docChangeListeners.set(view, set)
  }
  const listeners = set
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
    if (!listeners.size) {
      const timer = pendingTimers.get(view)
      if (timer !== undefined) {
        clearTimeout(timer)
        pendingTimers.delete(view)
      }
    }
  }
}

// 首屏性能打点。
//
// 设计:
// - production 默认 no-op(mark/measure/report 全部空实现,不污染用户控制台)
// - dev 模式自动启用
// - production 临时调试用:在 DevTools Console 跑 `localStorage.setItem('velo.perf','1')`
//   后刷新页面即可启用;测完跑 `localStorage.removeItem('velo.perf')` 关掉
// - 用 Performance API mark/measure,load 事件触发后自动汇总输出
// - 同时存 localStorage,便于前后优化对比(刷新多次取最近一次)
// - 顺带抓 FCP/LCP(Paint Timing)给"渲染感"一个客观指标
//
// 埋点位置: 见 main.ts / App.vue 中 mark(...) 调用。
// 汇总输出: window load 事件后 200ms 触发 report(),console.table + localStorage。

const PREFIX = 'velo'
const STORAGE_KEY = 'velo.perf.last'
const PERF_FLAG = 'velo.perf'

function readFlag(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PERF_FLAG) === '1'
  }
  catch { return false }
}

// 注意:flag 在模块加载时读一次,设了 flag 后必须刷新页面才生效
// (PerformanceObserver 必须在页面早期注册才能抓 FCP/LCP)。
const ENABLED = readFlag()

interface PerfRecord {
  name: string
  duration: number | null
}

interface PerfSnapshot {
  ts: string
  navigationStart: number
  marks: Record<string, number>
  measures: PerfRecord[]
  paint: { fcp: number | null; lcp: number | null }
}

const pendingMarks = new Set<string>()

export function mark(name: string): void {
  if (!ENABLED) return
  const full = `${PREFIX}:${name}`
  try {
    performance.mark(full)
    pendingMarks.add(full)
  }
  catch { /* mark 重名 / 已被清除,忽略 */ }
}

export function measure(name: string, start: string, end: string): void {
  if (!ENABLED) return
  const s = `${PREFIX}:${start}`
  const e = `${PREFIX}:${end}`
  const m = `${PREFIX}:measure:${name}`
  try {
    performance.measure(m, s, e)
  }
  catch { /* start/end 还没 mark,忽略 */ }
}

// FCP/LCP 抓取 —— 立即注册 observer,在 report 时读出。
let fcpTime: number | null = null
let lcpTime: number | null = null

if (ENABLED && typeof window !== 'undefined') {
  try {
    const paintObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') fcpTime = entry.startTime
      }
    })
    paintObs.observe({ type: 'paint', buffered: true })

    const lcpObs = new PerformanceObserver((list) => {
      const entries = list.getEntries()
      if (entries.length > 0) lcpTime = entries[entries.length - 1].startTime
    })
    lcpObs.observe({ type: 'largest-contentful-paint', buffered: true })
  }
  catch { /* observer 不可用,降级 */ }
}

function buildSnapshot(): PerfSnapshot {
  const marks: Record<string, number> = {}
  for (const full of pendingMarks) {
    const entries = performance.getEntriesByName(full)
    if (entries.length > 0) marks[full.replace(`${PREFIX}:`, '')] = entries[entries.length - 1].startTime
  }
  const measures: PerfRecord[] = []
  for (const entry of performance.getEntriesByType('measure')) {
    if (!entry.name.startsWith(`${PREFIX}:measure:`)) continue
    measures.push({
      name: entry.name.replace(`${PREFIX}:measure:`, ''),
      duration: Math.round(entry.duration * 100) / 100,
    })
  }
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  return {
    ts: new Date().toISOString(),
    navigationStart: nav ? nav.startTime : 0,
    marks,
    measures,
    paint: { fcp: fcpTime != null ? Math.round(fcpTime * 100) / 100 : null, lcp: lcpTime != null ? Math.round(lcpTime * 100) / 100 : null },
  }
}

export function report(label = 'current'): PerfSnapshot | null {
  if (!ENABLED) return null
  const snap = buildSnapshot()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...snap, label }))
  }
  catch { /* localStorage 不可用,忽略 */ }

  // console.table 输出 measures + paint
  console.group(`%c[Velo perf] ${label}`, 'color:#1F71D9;font-weight:bold')
  console.table(snap.measures)
  console.info('paint  :', snap.paint)
  console.info('marks  :', snap.marks)
  console.groupEnd()
  return snap
}

// 自动在 load 后 200ms 触发一次 report。
if (ENABLED && typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    setTimeout(() => report('auto'), 200)
  })
}

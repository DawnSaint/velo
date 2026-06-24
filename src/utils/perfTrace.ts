// ============================================================
//  perfTrace —— per-keystroke 性能埋点
// ============================================================
//
// 用法（仅 dev，需要手动启）:
//   1. 在浏览器 devtools 控制台跑:  localStorage.setItem('velo-perf', '1')
//      （或附带 buckets/n=次数 后缀:  '1:buckets'）
//   2. 刷新页面，连打 ≥30 个字
//   3. 控制台跑:  __veloPerfReport()  看汇总（min/avg/p95/max + 调用次数）
//   4. 关闭:     localStorage.removeItem('velo-perf')
//
// 设计取舍:
// - 单文件、零依赖、零侵入 —— prod build 因 `import.meta.env.DEV` 短路成空函数，
//   被打包后基本为 no-op（Vite 会做死代码消除）
// - 用 `wrap` 包裹同步函数；输入路径全是同步，不需要异步版本
// - 默认走 `log` 模式打每条 >0.5ms 的调用；切到 `buckets` 模式只累计，不刷屏

interface Bucket {
  count: number
  total: number
  min: number
  max: number
  samples: number[] // 仅保留最近 200 条用于 p95
}

const SAMPLE_CAP = 200

const buckets = new Map<string, Bucket>()

function getMode(): 'off' | 'log' | 'buckets' {
  if (!import.meta.env.DEV) return 'off'
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('velo-perf') : null
  if (!raw) return 'off'
  if (raw.includes('buckets')) return 'buckets'
  return 'log'
}

function record(label: string, dt: number, mode: 'log' | 'buckets') {
  let b = buckets.get(label)
  if (!b) {
    b = { count: 0, total: 0, min: Infinity, max: 0, samples: [] }
    buckets.set(label, b)
  }
  b.count++
  b.total += dt
  if (dt < b.min) b.min = dt
  if (dt > b.max) b.max = dt
  b.samples.push(dt)
  if (b.samples.length > SAMPLE_CAP) b.samples.shift()
  if (mode === 'log' && dt > 0.5) {
    // 短标签 + 固定宽度，便于在控制台扫
    // eslint-disable-next-line no-console
    console.log(`[perf] ${label.padEnd(28)} ${dt.toFixed(2)}ms`)
  }
}

/**
 * 包裹同步函数；启用埋点时记录耗时，未启用时直接透传（零开销）。
 */
export function trace<T>(label: string, fn: () => T): T {
  const mode = getMode()
  if (mode === 'off') return fn()
  const t0 = performance.now()
  const r = fn()
  record(label, performance.now() - t0, mode)
  return r
}

/**
 * 控制台调用 __veloPerfReport() 看汇总。
 */
function report() {
  if (buckets.size === 0) {
    // eslint-disable-next-line no-console
    console.log('[perf] no samples collected. did you set localStorage[velo-perf]=1 ?')
    return
  }
  const rows: Array<{ label: string, count: number, avg: number, p95: number, min: number, max: number, total: number }> = []
  for (const [label, b] of buckets) {
    const sorted = [...b.samples].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? b.max
    rows.push({
      label,
      count: b.count,
      avg: b.total / b.count,
      p95,
      min: b.min,
      max: b.max,
      total: b.total,
    })
  }
  rows.sort((a, b) => b.total - a.total)
  // eslint-disable-next-line no-console
  console.table(rows.map(r => ({
    label: r.label,
    count: r.count,
    'avg(ms)': r.avg.toFixed(2),
    'p95(ms)': r.p95.toFixed(2),
    'min(ms)': r.min.toFixed(2),
    'max(ms)': r.max.toFixed(2),
    'total(ms)': r.total.toFixed(1),
  })))
}

function reset() {
  buckets.clear()
  // eslint-disable-next-line no-console
  console.log('[perf] buckets cleared')
}

// 挂到 window 方便控制台直接调
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__veloPerfReport = report
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__veloPerfReset = reset
}

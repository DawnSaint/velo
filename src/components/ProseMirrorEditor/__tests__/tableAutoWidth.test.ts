// 表格列宽自适应纯函数单元测试。
//
// 覆盖:
//   - normalizeRatios:内容宽度归一化 / 全 0 均分兜底 / 非法值
//   - computeColumnWidths:一律输出 px(拖拽跟手的前提)、无手动列时铺满容器、
//     px 手动优先、有手动列时自动列保持基准宽度(mouseup 不压扁其它列)、
//     极端宽度不塌列、不可见容器返回 null
//   - 零跳变性质:锁定写回的 px 与 auto 实测宽度偏差 ≤ 1px
//   - columnWidthBudget:扣掉折叠边框 1px,避免每个表格常驻横向滚动条
//   - readManualWidths:0 / null 视为未设置、colspan 展开
//
// DOM 测量、rAF 锁定与拖拽预览属于 AutoWidthTableView / CSS,jsdom 无真实布局,
// 不在这里测(另用 Node + jsdom 链路脚本验证)。

import { describe, expect, it } from 'vitest'
import { schema } from '../editor/schema'
import {
  columnWidthBudget,
  computeColumnWidths,
  normalizeRatios,
  readManualWidths,
} from '../editor/tableAutoWidth'

const mkCell = (text: string, attrs: Record<string, unknown> = {}) =>
  schema.nodes.table_header.create(attrs, schema.nodes.paragraph.create(null, schema.text(text)))

const mkTable = (cells: ReturnType<typeof mkCell>[]) =>
  schema.nodes.table.create(null, [schema.nodes.table_header_row.create(null, cells)])

// 截图样例1:auto 布局读到的三列宽度(# / crate / 改动)。
const NATURAL = [100, 210, 578]
// 截图样例2:四列表格(# / 坎 / 事实 / 现有产物是否踩中),auto 实测 ≈ 930。
const NATURAL4 = [55, 105, 590, 180]

const planOf = (manual: (number | null)[], available = 888) => {
  const plan = computeColumnWidths({ ratios: normalizeRatios(NATURAL), manual, available })
  expect(plan).not.toBeNull()
  if (!plan) throw new Error('computeColumnWidths returned null')
  return plan
}

describe('normalizeRatios', () => {
  it('按内容宽度归一化且总和为 1', () => {
    const r = normalizeRatios(NATURAL)
    expect(r).toHaveLength(3)
    expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
    expect(r[0]).toBeLessThan(r[1])
    expect(r[1]).toBeLessThan(r[2])
  })

  it('全 0 / 负值 / NaN 时退回均分', () => {
    expect(normalizeRatios([0, 0, 0])).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(normalizeRatios([-1, Number.NaN, 0])).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  it('空表格返回空数组', () => {
    expect(normalizeRatios([])).toEqual([])
  })

  it('混合非法值时只用有效宽度', () => {
    expect(normalizeRatios([100, Number.NaN, 100])).toEqual([0.5, 0, 0.5])
  })
})

describe('computeColumnWidths', () => {
  it('无手动列 → 全部 px 且总和精确等于可用宽度,短列不再均分', () => {
    const plan = planOf([null, null, null], 888)
    expect(plan.widths.every((w) => w.endsWith('px'))).toBe(true)
    const px = plan.widths.map((w) => Number.parseFloat(w))
    expect(px.reduce((a, b) => a + b, 0)).toBe(888)
    expect(plan.totalPx).toBe(888)
    expect(px[0]).toBeLessThan(888 * 0.15)
    expect(px[2]).toBeGreaterThan(888 * 0.55)
  })

  it('绝不与拖拽预览的 px 混用百分比(否则第一次拖拽不跟手)', () => {
    for (const manual of [
      [null, null, null],
      [null, 200, null],
      [200, 300, 300],
    ] as (number | null)[][]) {
      const plan = planOf(manual, 888)
      expect(plan.widths.some((w) => w.includes('%'))).toBe(false)
      expect(plan.widths.every((w) => w.endsWith('px'))).toBe(true)
    }
  })

  it('拿不到容器宽度 / 空表格时返回 null,调用方保持 auto 态', () => {
    expect(
      computeColumnWidths({ ratios: normalizeRatios(NATURAL), manual: [], available: 0 }),
    ).toBeNull()
    expect(computeColumnWidths({ ratios: [], manual: [], available: 800 })).toBeNull()
  })

  it('锁定写回的 px 与 auto 实测宽度偏差不超过 1px(零跳变)', () => {
    const available = NATURAL.reduce((a, b) => a + b, 0)
    const plan = planOf([null, null, null], available)
    const lockedPx = plan.widths.map((w) => Number.parseFloat(w))
    NATURAL.forEach((w, i) => {
      expect(Math.abs(lockedPx[i] - w)).toBeLessThanOrEqual(1)
    })
    expect(plan.totalPx).toBe(available)
  })

  it('有手动列 → 手动值原样保留,自动列保持基准宽度(不按剩余空间重分配)', () => {
    const plan = planOf([null, 200, null], 800)
    expect(plan.widths[1]).toBe('200px')
    // 基准 = 无手动列时对同一 available 的锁定宽度,不能因为手动列出现就被挤压。
    const baseline = planOf([null, null, null], 800)
    expect(plan.widths[0]).toBe(baseline.widths[0])
    expect(plan.widths[2]).toBe(baseline.widths[2])
    expect(plan.totalPx).toBe(plan.widths.reduce((s, w) => s + Number.parseFloat(w), 0))
  })

  it('mouseup 回归:只写被拖列的 colwidth 时,其它列不被压成 48px 竖排', () => {
    const available = NATURAL4.reduce((a, b) => a + b, 0)
    const ratios = normalizeRatios(NATURAL4)
    // updateColumnWidth 只给被拖列写 colwidth,其余列是 0 → readManualWidths 得 null
    const manual: (number | null)[] = [null, 730, null, null]
    const before = computeColumnWidths({ ratios, manual: [], available })
    const after = computeColumnWidths({ ratios, manual, available })
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    if (!before || !after) throw new Error('computeColumnWidths returned null')
    expect(after.widths[1]).toBe('730px')
    // 自动列仍是拖拽前的宽度,预览 → mouseup 零跳变。
    for (const i of [0, 2, 3]) {
      expect(after.widths[i]).toBe(before.widths[i])
      expect(Number.parseFloat(after.widths[i])).toBeGreaterThan(48)
    }
    // 总宽超出容器,交给 .tableWrapper 横向滚动,而不是压缩其它列。
    expect(after.totalPx).toBeGreaterThan(available)
    expect(after.totalPx).toBe(after.widths.reduce((s, w) => s + Number.parseFloat(w), 0))
  })

  it('连续多次拖拽同一表不会累积缩放(自动列基准恒定)', () => {
    const ratios = normalizeRatios(NATURAL4)
    const available = 930
    const first = computeColumnWidths({ ratios, manual: [null, 730, null, null], available })
    const second = computeColumnWidths({ ratios, manual: [null, 730, 300, null], available })
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    if (!first || !second) throw new Error('computeColumnWidths returned null')
    expect(second.widths[0]).toBe(first.widths[0])
    expect(second.widths[3]).toBe(first.widths[3])
    expect(second.widths[1]).toBe('730px')
    expect(second.widths[2]).toBe('300px')
  })

  it('手动宽度总和超过可用宽度时,自动列不塌成 0 且总宽可横向滚动', () => {
    const plan = planOf([null, 900, null], 800)
    const px = plan.widths.map((w) => Number.parseFloat(w))
    expect(px[0]).toBeGreaterThanOrEqual(48)
    expect(px[2]).toBeGreaterThanOrEqual(48)
    // 自动列仍保持基准宽度,不是被压到 MIN_COL_PX。
    expect(px[2]).toBeGreaterThan(48)
    expect(plan.totalPx).toBe(px.reduce((a, b) => a + b, 0))
    expect(plan.totalPx).toBeGreaterThan(800)
  })

  it('所有列都被手动设置时不产生 NaN,也不篡改用户设定', () => {
    const plan = planOf([200, 300, 300], 800)
    expect(plan.widths).toEqual(['200px', '300px', '300px'])
    expect(plan.totalPx).toBe(800)
  })

  it('manual 数组比列数短时缺失列按未设置处理', () => {
    const plan = planOf([120], 888)
    expect(plan.widths).toHaveLength(3)
    expect(plan.widths[0]).toBe('120px')
    expect(plan.widths.every((w) => Number.isFinite(Number.parseFloat(w)))).toBe(true)
  })

  it('同一输入结果稳定(打字时列宽不抖)', () => {
    expect(planOf([null, null, null], 888)).toEqual(planOf([null, null, null], 888))
  })
})

describe('columnWidthBudget', () => {
  it('容器 930 → 列宽之和 929:折叠边框占 1px,表格正好铺满不留滚动条', () => {
    const containerWidth = 930
    const budget = columnWidthBudget(containerWidth)
    expect(budget).toBe(929)
    const plan = computeColumnWidths({
      ratios: normalizeRatios(NATURAL4),
      manual: [],
      available: budget,
    })
    expect(plan?.totalPx).toBe(budget)
    // 表格边框盒 = 列宽之和 + 1px 外框 = 容器宽度。
    expect(plan!.totalPx + 1).toBe(containerWidth)
  })

  it('容器宽度 <= 边框宽度时预算非正,调用方保持 auto 态', () => {
    expect(
      computeColumnWidths({
        ratios: normalizeRatios(NATURAL4),
        manual: [],
        available: columnWidthBudget(1),
      }),
    ).toBeNull()
  })
})

describe('readManualWidths', () => {
  it('0 / null 视为未设置', () => {
    const t = mkTable([
      mkCell('a', { colwidth: [120, 0] }),
      mkCell('b'),
      mkCell('c', { colwidth: [0] }),
    ])
    expect(readManualWidths(t)).toEqual([120, null, null])
  })

  it('按 colspan 展开成多列', () => {
    const t = mkTable([mkCell('a', { colspan: 2, colwidth: [100, 80] }), mkCell('b')])
    expect(readManualWidths(t)).toEqual([100, 80, null])
  })
})

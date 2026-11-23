// 纸张尺寸回归：换纸只改「页面盒」，字号 / 页边距语义不变。
// layoutGeometry 是纯函数（不依赖字体子集），所以这里不需要 mock 字体。

import { describe, expect, it } from 'vitest'
import { DEFAULT_PDF_LAYOUT_OPTIONS, PDF_PAPER_SIZES, type PdfLayoutOptions, type PdfPaperSize } from '../types'
import { layoutGeometry } from '../tokens'

const contentW = (opts: PdfLayoutOptions) => {
  const g = layoutGeometry(opts)
  return g.pageWidth - g.marginLeft - g.marginRight
}

describe('PDF 纸张尺寸', () => {
  it('默认 A4（595.28 × 841.89 pt）', () => {
    expect(DEFAULT_PDF_LAYOUT_OPTIONS.paperSize).toBe('a4')
    const g = layoutGeometry(DEFAULT_PDF_LAYOUT_OPTIONS)
    expect(g.pageWidth).toBeCloseTo(595.28, 2)
    expect(g.pageHeight).toBeCloseTo(841.89, 2)
  })

  it('至少可选 A4 与 Letter，Letter 更宽更矮', () => {
    expect(PDF_PAPER_SIZES.a4).toBeTruthy()
    expect(PDF_PAPER_SIZES.letter).toBeTruthy()
    const letter = layoutGeometry({ ...DEFAULT_PDF_LAYOUT_OPTIONS, paperSize: 'letter' })
    expect(letter.pageWidth).toBeCloseTo(612, 2)
    expect(letter.pageHeight).toBeCloseTo(792, 2)
    // 页边距不变 → 内容盒随纸宽同步变宽
    expect(contentW({ ...DEFAULT_PDF_LAYOUT_OPTIONS, paperSize: 'letter' }))
      .toBeCloseTo(contentW(DEFAULT_PDF_LAYOUT_OPTIONS) + (612 - 595.28), 2)
  })

  it('纸张表每项都有正尺寸与展示名', () => {
    for (const spec of Object.values(PDF_PAPER_SIZES)) {
      expect(spec.width).toBeGreaterThan(0)
      expect(spec.height).toBeGreaterThan(0)
      expect(spec.label.length).toBeGreaterThan(0)
    }
  })

  it('未传 / 非法纸张回退 A4', () => {
    const a4 = layoutGeometry(DEFAULT_PDF_LAYOUT_OPTIONS)
    expect(layoutGeometry({ ...DEFAULT_PDF_LAYOUT_OPTIONS, paperSize: undefined }).pageWidth)
      .toBeCloseTo(a4.pageWidth, 2)
    const bogus = layoutGeometry({
      ...DEFAULT_PDF_LAYOUT_OPTIONS,
      paperSize: 'tabloid' as unknown as PdfPaperSize,
    })
    expect(bogus.pageWidth).toBeCloseTo(a4.pageWidth, 2)
    expect(bogus.pageHeight).toBeCloseTo(a4.pageHeight, 2)
  })
})

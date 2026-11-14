// svgRaster 单元测试:内联 SVG → PNG data URI。
//
// jsdom 不加载图片也没有 canvas 包,这里把 Image / canvas 都换成 stub,
// 验证:成功光栅化、图片加载失败降级、canvas 不可用降级、无尺寸降级。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rasterizeSvgToPngDataUri } from '../svgRaster'

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="var(--pele-bg, #fff)" /></svg>'

let imageBehavior: 'load' | 'error' = 'load'

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_value: string) {
    if (imageBehavior === 'load') this.onload?.()
    else this.onerror?.()
  }
}

describe('rasterizeSvgToPngDataUri', () => {
  beforeEach(() => {
    imageBehavior = 'load'
    vi.stubGlobal('Image', FakeImage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rasterizes a sized SVG into a PNG data URI', async () => {
    const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    )
    const toDataURL = vi.fn(() => 'data:image/png;base64,AAAA')
    HTMLCanvasElement.prototype.toDataURL = toDataURL

    const out = await rasterizeSvgToPngDataUri(SVG)
    expect(out).toBe('data:image/png;base64,AAAA')
    expect(ctx.fillRect).toHaveBeenCalled()
    expect(ctx.drawImage).toHaveBeenCalled()
    expect(toDataURL).toHaveBeenCalledWith('image/png')
  })

  it('returns null when the image fails to load', async () => {
    imageBehavior = 'error'
    expect(await rasterizeSvgToPngDataUri(SVG)).toBeNull()
  })

  it('returns null when canvas 2d context is unavailable', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(await rasterizeSvgToPngDataUri(SVG)).toBeNull()
  })

  it('returns null when the SVG has no usable dimensions', async () => {
    const noSize = '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>'
    expect(await rasterizeSvgToPngDataUri(noSize)).toBeNull()
  })
})

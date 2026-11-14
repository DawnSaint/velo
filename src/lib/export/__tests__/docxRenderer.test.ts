// buildExportDocx 端到端测试:markdown → docx 字节。
//
// 验证:
// 1) 输出是合法 docx(PK 魔数 + 非空)
// 2) warnings 收集(htmlRenderer 的渲染警告 + htmlToContent 的丢弃警告)
// 3) Velo 自定义语法(alert / 高亮 / 脚注 / 公式 / mermaid)不中断导出

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildExportDocx } from '../docxRenderer'
import { resolveExportThemes } from '../htmlRenderer'
import { rasterizeSvgToPngDataUri } from '../svgRaster'

// jsdom 不加载图片(`new Image()` 的 onload/onerror 都不触发,svgRaster 的
// loadImage 会永久悬挂),也没有 canvas 包。光栅化逻辑由 svgRaster.test.ts
// 单独覆盖;这里整体 mock 掉,只验证调用方在光栅化失败时的降级路径。
vi.mock('../svgRaster', () => ({
  rasterizeSvgToPngDataUri: vi.fn(async () => null),
}))

const baseOpts = (content: string) =>
  resolveExportThemes({
    content,
    fileName: 'test.md',
    darkMode: false,
    primaryColor: '#0F4C81',
    applyThemeColorToContent: true,
    fontFamily: 'sans-serif',
    fontMono: 'ui-monospace, monospace',
    fontSize: '14px',
    currentFilePath: null,
  })

describe('buildExportDocx', () => {
  beforeEach(() => {
    vi.mocked(rasterizeSvgToPngDataUri).mockResolvedValue(null)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('produces a valid docx (PK magic) with non-trivial size', async () => {
    const { bytes } = await buildExportDocx(baseOpts('# 标题\n\n正文段落。'))
    expect(bytes.length).toBeGreaterThan(1000)
    // zip 魔数 'PK'
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
  })

  it('returns an empty warnings array when everything renders', async () => {
    const { warnings } = await buildExportDocx(baseOpts('# 标题\n\n正文。'))
    expect(warnings).toEqual([])
  })

  it('does not throw on Velo custom syntax (alert / highlight / footnote / math)', async () => {
    const md = [
      '> [!NOTE]',
      '> 注意内容',
      '',
      '普通 ==高亮== 文本。',
      '',
      '脚注引用[^1]。',
      '',
      '[^1]: 脚注内容。',
      '',
      '$E=mc^2$',
    ].join('\n')
    const { bytes, warnings } = await buildExportDocx(baseOpts(md))
    expect(bytes.length).toBeGreaterThan(1000)
    expect(Array.isArray(warnings)).toBe(true)
  })

  it('degrades mermaid SVG with a warning when rasterization fails', async () => {
    const { bytes, warnings } = await buildExportDocx(
      baseOpts('```mermaid\ngraph TD; A-->B;\n```'),
    )
    expect(bytes.length).toBeGreaterThan(1000)
    expect(warnings.some(w => w.includes('光栅化'))).toBe(true)
  }, 20000)

  it('collects htmlToContent warnings (e.g. unsupported elements)', async () => {
    // <video> 是 htmlToContent 明确不支持的元素 → 应进 warnings 而非抛错
    const { bytes, warnings } = await buildExportDocx(
      baseOpts('正文\n\n<video src="x.mp4"></video>\n\n结尾'),
    )
    expect(bytes.length).toBeGreaterThan(1000)
    expect(warnings.some(w => w.includes('unsupported-element'))).toBe(true)
  })
})

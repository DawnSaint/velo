// 图片预览 lightbox:store 状态机 + 组件渲染 / 导航 / 缩放 / 键盘。
// 组件 Teleport to body,断言走 document 查询(wrapper.find 查不到 teleport 内容)。
// jsdom 不加载真实图片,naturalWidth/Height 用 defineProperty 注入后手动触发 load。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { stat } from '@tauri-apps/plugin-fs'
import ImagePreviewLightbox from '../ImagePreviewLightbox.vue'
import { useImagePreviewStore, type PreviewImage } from '@/stores/imagePreview'

const IMG_A: PreviewImage = { url: 'asset://a.png', name: 'a.png', absPath: 'C:/ws/a.png' }
const IMG_B: PreviewImage = { url: 'asset://b.png', name: 'b.png', absPath: 'C:/ws/b.png' }
const IMG_EXT: PreviewImage = { url: 'https://example.com/x.png', name: 'example.com/x.png', absPath: null }

let wrapper: VueWrapper | null = null

function mountLightbox() {
  wrapper = mount(ImagePreviewLightbox, { attachTo: document.body })
}

function el(sel: string): HTMLElement {
  const n = document.querySelector(sel)
  if (!n) throw new Error(`element not found: ${sel}`)
  return n as HTMLElement
}

function exists(sel: string): boolean {
  return document.querySelector(sel) !== null
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

async function click(sel: string) {
  el(sel).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}

/** 模拟真实单击图片:pointerdown → pointerup → click(组件靠 pointerdown 记录按下位置) */
async function clickImg() {
  const img = el('img.lp-img')
  img.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
  img.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
  img.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await nextTick()
}

/** 模拟真实双击图片:两轮 down/up/click(组件手动按时间/距离判定双击,不依赖原生 dblclick) */
async function dblclickImg() {
  const img = el('img.lp-img')
  for (let i = 0; i < 2; i++) {
    img.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    img.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }))
  }
  await nextTick()
}

function stageClass(): string {
  return el('.absolute.inset-0.flex').className
}

function imgClass(): string {
  return el('img.lp-img').className
}

function key(k: string) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

/** 让 jsdom 里的 img 报告自然尺寸并触发 load */
async function loadImage(w = 800, h = 600) {
  const img = el('img.lp-img')
  Object.defineProperty(img, 'naturalWidth', { value: w, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: h, configurable: true })
  img.dispatchEvent(new Event('load'))
  await nextTick()
}

function percent(): string {
  return el('[data-testid="lp-percent"]').textContent ?? ''
}

describe('imagePreview store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('open / step 循环 wrap / close', () => {
    const s = useImagePreviewStore()
    s.open([IMG_A, IMG_B], 1)
    expect(s.isOpen).toBe(true)
    expect(s.index).toBe(1)
    s.step(1)
    expect(s.index).toBe(0)
    s.step(-1)
    expect(s.index).toBe(1)
    s.close()
    expect(s.isOpen).toBe(false)
  })

  it('open 空列表不打开,startIndex 越界 clamp', () => {
    const s = useImagePreviewStore()
    s.open([])
    expect(s.isOpen).toBe(false)
    s.open([IMG_A, IMG_B], 99)
    expect(s.index).toBe(1)
  })
})

describe('ImagePreviewLightbox', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.resetAllMocks()
    vi.mocked(stat).mockResolvedValue({ size: 2048 } as any)
    // jsdom 未实现 pointer capture,放大后拖拽平移会调用
    Element.prototype.setPointerCapture = vi.fn()
    Element.prototype.releasePointerCapture = vi.fn()
    Element.prototype.hasPointerCapture = vi.fn(() => false)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('打开后渲染图片 / 名称 / 元信息,顶栏只有关闭', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_A, IMG_B])
    await nextTick()

    expect(el('img.lp-img').getAttribute('src')).toBe('asset://a.png')
    expect(bodyText()).toContain('a.png')
    expect(exists('[data-testid="lp-copy-image"]')).toBe(false)
    expect(exists('[data-testid="lp-reveal"]')).toBe(false)
    expect(exists('[data-testid="lp-close"]')).toBe(true)
    expect(exists('[data-testid="lp-next"]')).toBe(true)
    await new Promise(r => setTimeout(r, 0))
    expect(bodyText()).toContain('2.0 KB')
    expect(bodyText()).toContain('1 / 2')
  })

  it('单图不显示导航箭头', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_EXT])
    await nextTick()

    expect(exists('[data-testid="lp-next"]')).toBe(false)
    expect(exists('[data-testid="lp-prev"]')).toBe(false)
  })

  it('下一张 / 上一张按钮与 ←→ 键切换,循环 wrap', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_A, IMG_B])
    await nextTick()

    await click('[data-testid="lp-next"]')
    expect(el('img.lp-img').getAttribute('src')).toBe('asset://b.png')

    key('ArrowRight')
    await nextTick()
    expect(el('img.lp-img').getAttribute('src')).toBe('asset://a.png')

    key('ArrowLeft')
    await nextTick()
    expect(el('img.lp-img').getAttribute('src')).toBe('asset://b.png')
  })

  it('Esc 关闭,点背景关闭', async () => {
    mountLightbox()
    const s = useImagePreviewStore()
    s.open([IMG_A])
    await nextTick()

    key('Escape')
    await nextTick()
    expect(s.isOpen).toBe(false)
    // Transition leave 在 jsdom 里走 rAF 结算,等一帧再断言 DOM 移除
    await new Promise(r => setTimeout(r, 50))
    expect(exists('img.lp-img')).toBe(false)

    s.open([IMG_A])
    await nextTick()
    // 点舞台背景:target 是舞台自身且未按在图片上 → 关闭
    el('.absolute.inset-0.flex').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(s.isOpen).toBe(false)
  })

  it('加载后适应窗口;+ / - 缩放,0 恢复适应,1 实际大小', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_A])
    await nextTick()
    await loadImage()

    // jsdom 视口 1024×768,800×600 图 fit = 100%
    expect(percent()).toBe('100%')

    await click('[data-testid="lp-zoom-in"]')
    expect(percent()).toBe('125%')

    key('-')
    await nextTick()
    expect(percent()).toBe('100%')

    key('+')
    await nextTick()
    expect(percent()).toBe('125%')

    key('0')
    await nextTick()
    expect(percent()).toBe('100%')
  })

  it('大图适应窗口按比例缩小', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_A])
    await nextTick()
    // 2000×1500 → min((1024-144)/2000, (768-160)/1500, 1) = 0.4053…
    await loadImage(2000, 1500)
    expect(percent()).toBe('41%')
  })

  it('加载失败显示错误态', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_A])
    await nextTick()
    el('img.lp-img').dispatchEvent(new Event('error'))
    await nextTick()
    expect(bodyText()).toContain('无法加载图片')
    expect(bodyText()).toContain('C:/ws/a.png')
  })

  it('双击小图在 100% / 200% 间切换;单击不缩放不关闭,图片光标 grab', async () => {
    mountLightbox()
    const s = useImagePreviewStore()
    s.open([IMG_A])
    await nextTick()
    await loadImage()

    // 图片 = 拖拽把手恒 grab;背景(点击关闭)保持 default
    expect(imgClass()).toContain('cursor-grab')
    expect(stageClass()).toContain('cursor-default')
    // fit == 100% 时只亮「适应」,1:1 不同时高亮
    expect(el('[data-testid="lp-fit"]').className).toContain('lp-btn--active')
    expect(el('[data-testid="lp-actual"]').className).not.toContain('lp-btn--active')

    // fit == 100%(800×600 小图)→ 双击到 200%,再双击回适应
    await dblclickImg()
    expect(percent()).toBe('200%')
    expect(s.isOpen).toBe(true)
    await dblclickImg()
    expect(percent()).toBe('100%')
    expect(s.isOpen).toBe(true)

    // 单击图片:不缩放、不关闭
    await clickImg()
    expect(percent()).toBe('100%')
    expect(s.isOpen).toBe(true)
  })

  it('双击大图在 适应 / 100% 间切换,100% 时只亮 1:1', async () => {
    mountLightbox()
    useImagePreviewStore().open([IMG_A])
    await nextTick()
    await loadImage(2000, 1500)
    expect(percent()).toBe('41%')

    await dblclickImg()
    expect(percent()).toBe('100%')
    expect(el('[data-testid="lp-actual"]').className).toContain('lp-btn--active')
    expect(el('[data-testid="lp-fit"]').className).not.toContain('lp-btn--active')
    await dblclickImg()
    expect(percent()).toBe('41%')
  })

  it('放大后单击图片不关闭(pointer capture 重定向回归),双击回适应', async () => {
    mountLightbox()
    const s = useImagePreviewStore()
    s.open([IMG_A])
    await nextTick()
    await loadImage()

    await click('[data-testid="lp-zoom-in"]')
    expect(percent()).toBe('125%')

    // 按在图片上 → 舞台捕获指针;浏览器把 click 的 target 重定向到舞台
    const img = el('img.lp-img')
    img.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    img.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    el('.absolute.inset-0.flex').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }))
    await nextTick()
    expect(s.isOpen).toBe(true)
    expect(percent()).toBe('125%')

    // 第二击同样被重定向到舞台 → 手动双击判定仍生效
    img.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    img.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    el('.absolute.inset-0.flex').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 100 }))
    await nextTick()
    expect(s.isOpen).toBe(true)
    expect(percent()).toBe('100%')
  })

  it('未放大也能拖拽平移,松手不触发关闭', async () => {
    mountLightbox()
    const s = useImagePreviewStore()
    s.open([IMG_A])
    await nextTick()
    await loadImage()

    const img = el('img.lp-img')
    img.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
    img.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 140 }))
    img.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    el('.absolute.inset-0.flex').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(s.isOpen).toBe(true)
    expect(percent()).toBe('100%')
    expect(img.style.transform).toContain('translate(60px, 40px)')
  })

  it('拖拽平移松手不触发缩放或关闭', async () => {
    mountLightbox()
    const s = useImagePreviewStore()
    s.open([IMG_A])
    await nextTick()
    await loadImage()
    await click('[data-testid="lp-zoom-in"]')

    const img = el('img.lp-img')
    img.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 }))
    img.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 160, clientY: 140 }))
    img.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    el('.absolute.inset-0.flex').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(s.isOpen).toBe(true)
    expect(percent()).toBe('125%')
  })
})
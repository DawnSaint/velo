import { describe, expect, it } from 'vitest'
import {
  createImageErrorPlaceholder,
  createImageErrorContainer,
  attachImageErrorFallback,
} from '../editor/imageErrorPlaceholder'

// 占位符形态与文案是跨视图共用的,这里锁死「只有一句文案」和「失败即替换」
// 两条约束,避免以后某条渲染路径又长出自己的提示。

describe('createImageErrorPlaceholder', () => {
  it('统一形态:image-off 图标 + 唯一文案,不渲染第二行', () => {
    const el = createImageErrorPlaceholder()
    expect(el.className).toBe('velo-image-error')
    expect(el.textContent).toBe('图片加载异常')
    expect(el.querySelector('.velo-image-error-text')?.textContent).toBe('图片加载异常')

    const icon = el.querySelector('.velo-image-error-icon')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
    expect(icon?.querySelector('svg')).not.toBeNull()
    // lucide image-off 的标志:左上到右下的对角斜杠
    expect(icon?.innerHTML).toContain('x1="2" y1="2" x2="22" y2="22"')
  })

  it('原始 src 只进 title,不成为第二行文案', () => {
    const el = createImageErrorPlaceholder('assets/deleted.png')
    expect(el.title).toBe('assets/deleted.png')
    expect(el.textContent).toBe('图片加载异常')
  })
})

describe('attachImageErrorFallback', () => {
  it('error 后原位替换成占位符,title 用 markdown 原始 src', () => {
    const parent = document.createElement('div')
    const img = document.createElement('img')
    img.src = 'asset://localhost/deleted.png'
    parent.appendChild(img)

    attachImageErrorFallback(img, 'assets/deleted.png')
    img.dispatchEvent(new Event('error'))

    expect(parent.querySelector('img')).toBeNull()
    const placeholder = parent.querySelector('.velo-image-error')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.getAttribute('title')).toBe('assets/deleted.png')
    expect(placeholder?.textContent).toBe('图片加载异常')
  })

  it('未传 source 时回退到 alt / src,远程链接同样只出一句文案', () => {
    const parent = document.createElement('div')
    const img = document.createElement('img')
    img.src = 'https://cdn.example.com/missing.png'
    parent.appendChild(img)

    attachImageErrorFallback(img)
    img.dispatchEvent(new Event('error'))

    const placeholder = parent.querySelector('.velo-image-error')
    expect(placeholder?.getAttribute('title')).toBe('https://cdn.example.com/missing.png')
    expect(placeholder?.textContent).toBe('图片加载异常')
  })

  it('once:重复 error 不会再替换一次', () => {
    const parent = document.createElement('div')
    const img = document.createElement('img')
    parent.appendChild(img)
    attachImageErrorFallback(img, 'a.png')

    img.dispatchEvent(new Event('error'))
    const placeholder = parent.querySelector('.velo-image-error')
    img.dispatchEvent(new Event('error'))

    expect(parent.querySelector('.velo-image-error')).toBe(placeholder)
    expect(parent.children.length).toBe(1)
  })
})

// PM Decoration.widget 的根节点由 WidgetViewDesc 持有,error 时不能 replaceWith
// 根节点 —— 这条路径用稳定容器 + class 切换,占位符 DOM 仍由同一个工厂生成。
describe('createImageErrorContainer', () => {
  it('容器内预放 img + 占位符,初始没有失败态', () => {
    const { root, img } = createImageErrorContainer('assets/x.png', 'velo-image-source-preview-widget')
    expect(root.className).toContain('velo-image-source-preview-widget')
    expect(root.classList.contains('velo-image-error-container')).toBe(true)
    expect(root.children.length).toBe(2)
    expect(root.firstElementChild).toBe(img)
    expect(root.classList.contains('is-broken')).toBe(false)

    const placeholder = root.querySelector('.velo-image-error')
    expect(placeholder?.textContent).toBe('图片加载异常')
    expect(placeholder?.getAttribute('title')).toBe('assets/x.png')
  })

  it('error 只切 class:根节点与 img 都留在 DOM 里,占位符显示', () => {
    const { root, img } = createImageErrorContainer('assets/x.png')
    const parent = document.createElement('div')
    parent.appendChild(root)
    root.classList.add('is-pending')
    img.src = 'asset://localhost/x.png'

    img.dispatchEvent(new Event('error'))

    expect(parent.firstElementChild).toBe(root)
    expect(root.firstElementChild).toBe(img)
    expect(root.classList.contains('is-broken')).toBe(true)
    expect(root.classList.contains('is-pending')).toBe(false)
    expect(root.children.length).toBe(2)
  })

  it('once:重复 error 不重复切换,也不新增节点', () => {
    const { root, img } = createImageErrorContainer('a.png')
    img.dispatchEvent(new Event('error'))
    img.dispatchEvent(new Event('error'))
    expect(root.classList.contains('is-broken')).toBe(true)
    expect(root.children.length).toBe(2)
  })
})

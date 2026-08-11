import { describe, expect, it } from 'vitest'
import { findScrollAncestor } from '../scrollUtils'

function makeChain(html: string): HTMLElement {
  document.body.innerHTML = html
  // 选取最内层 div 作为 start(通常代表 view.dom)
  const inner = document.body.querySelector('[data-test="start"]') as HTMLElement
  expect(inner).not.toBeNull()
  return inner
}

describe('findScrollAncestor', () => {
  it('找到自身就是滚动容器的祖先(场景 0:view.dom 自带 overflow:auto)', () => {
    const start = makeChain(`
      <div id="root">
        <div data-test="start" style="overflow: auto; height: 100px">view.dom</div>
      </div>
    `)
    expect(findScrollAncestor(start)?.id).toBe('')
    expect(findScrollAncestor(start)).toBe(start)
  })

  it('向上 walk 找到最近的 overflow:auto 祖先(场景 1:wrapper 是真实滚动容器)', () => {
    const start = makeChain(`
      <div style="overflow: auto; height: 200px" id="scroll-wrap">
        <div class="velo-editor">
          <div class="velo-editor-mount" id="container">
            <div data-test="start" class="ProseMirror">view.dom</div>
          </div>
        </div>
      </div>
    `)
    expect(findScrollAncestor(start)?.id).toBe('scroll-wrap')
  })

  it('overflowY:auto / overflowY:scroll 同样识别', () => {
    const y = makeChain(`
      <div id="ay" style="overflow-y: auto">x</div>
      <div data-test="start" id="start">view.dom</div>
    `)
    // 把 start 挪到 ay 下面
    ;(y.parentElement as HTMLElement).id = 'tmp'
    document.getElementById('ay')!.appendChild(y)

    const s = makeChain(`
      <div id="sy" style="overflow-y: scroll; height: 100px">x</div>
      <div data-test="start" id="viewdom">view.dom</div>
    `)
    document.getElementById('sy')!.appendChild(s)

    expect(findScrollAncestor(y)?.id).toBe('ay')
    expect(findScrollAncestor(s)?.id).toBe('sy')
  })

  it('祖先链上没有 overflow:auto/scroll 时返回 null', () => {
    const start = makeChain(`
      <div>
        <div>
          <div data-test="start">view.dom</div>
        </div>
      </div>
    `)
    expect(findScrollAncestor(start)).toBeNull()
  })

  it('不会因为中间某层有 overflow:hidden 而错过上层 overflow:auto', () => {
    const start = makeChain(`
      <div id="scroll" style="overflow: auto; height: 200px">
        <div id="hidden" style="overflow: hidden">
          <div data-test="start">view.dom</div>
        </div>
      </div>
    `)
    expect(findScrollAncestor(start)?.id).toBe('scroll')
  })
})

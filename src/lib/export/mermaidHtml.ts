// Mermaid → SVG 字符串。
//
// 复用 mermaid.render(自带异步 API)。与 editor/MermaidDecoration.ts 的
// renderMermaid 函数同一范式(mermaid.parse 先解析 + mermaid.render 拿 svg),
// 但直接调 mermaid 库不经过 NodeView 路径 —— 导出场景不需要 bindFunctions。
//
// id 唯一性:用 module-local counter 自增,保证一次导出多 mermaid 块不冲突。
// mermaid 内部按 id 注册 SVG 容器,重复 id 会让第二块覆盖第一块的 DOM 节点。

import type Mermaid from 'mermaid'

// mermaid 懒加载 —— 与 editor 侧 MermaidDecoration.ts 的 getMermaid 共享 Vite
// 拆出的 mermaid chunk。导出场景下不渲染到 DOM(只要 SVG 字符串),所以不需要
// 额外副作用,直接 import 拿模块即可。

let mermaidMod: typeof Mermaid | null = null
let mermaidPromise: Promise<typeof Mermaid> | null = null

function getMermaid(): Promise<typeof Mermaid> {
  if (mermaidMod) return Promise.resolve(mermaidMod)
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      mermaidMod = m.default
      return m.default
    })
  }
  return mermaidPromise
}

export interface MermaidRenderResult {
  svg: string
  error: string | null
}

let nextExportId = 1
function uid(): string {
  return `velo-mermaid-export-${nextExportId++}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export async function renderMermaidSvg(
  code: string,
  theme: 'default' | 'dark' = 'default',
): Promise<MermaidRenderResult> {
  const trimmed = code.trim()
  if (!trimmed) {
    return { svg: '', error: null }
  }
  const mermaid = await getMermaid()
  // mermaid 是 singleton(整个 app 共享一个),每次 render 前 re-init 切 theme。
  // 跟 MermaidDecoration.ts 同范式;并发调用理论上有 race(两次
  // initialize 互相覆盖 theme),但导出场景同步 await 各块,不会并发。
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
  })
  const id = uid()
  try {
    await mermaid.parse(trimmed)
  }
  catch (e: unknown) {
    const msg = (e instanceof Error ? e.message : String(e)) || 'mermaid 语法错误'
    return { svg: '', error: msg }
  }
  try {
    const result = await mermaid.render(id, trimmed)
    return { svg: result.svg, error: null }
  }
  catch (e: unknown) {
    const msg = (e instanceof Error ? e.message : String(e)) || 'mermaid 渲染失败'
    return { svg: '', error: msg }
  }
}

/** 失败的 mermaid 块降级为 <pre class="mermaid-error"> 包含原文。 */
export function mermaidErrorHtml(code: string, error: string): string {
  return `<pre class="mermaid-error" title="${escapeHtml(error)}">${escapeHtml(code)}</pre>`
}

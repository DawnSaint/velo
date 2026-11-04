// Mermaid → SVG 字符串。
//
// 渲染库用 pele(Obsidian 出品,mermaid 语法兼容):render() 同步、零依赖、
// 默认安全(转义文本/过滤链接,对标原 mermaid securityLevel:'strict')。
// 与 editor/MermaidDecoration.ts 的 renderMermaid 同范式(懒加载 chunk 共享,
// pele.PeleError 降级为 error 字符串),但直接调库不经过 Decoration 路径。
//
// 主题:pele 的 SVG 颜色全部引用 --pele-* CSS 变量。_mermaid.scss 给
// .velo-mermaid-block 定义了 light/dark 两套变量(暗色同时覆盖 .dark 类与
// prefers-color-scheme,匹配 exportStyles.scss 的暗色策略),导出 HTML 内联
// 这份 CSS 后自动跟随系统主题 —— 不需要在渲染时传 theme。
//
// idPrefix 唯一性:用 module-local counter 自增,保证一次导出多 mermaid 块
// 不共享 SVG 内部 id(pele 用 idPrefix 前缀无障碍 title/description 等 id)。

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
): Promise<MermaidRenderResult> {
  const trimmed = code.trim()
  if (!trimmed) {
    return { svg: '', error: null }
  }
  // pele 懒加载 —— 与 editor 侧 MermaidDecoration.ts 的 getPele 共享 Vite
  // 拆出的 pele chunk。导出场景不渲染到 DOM(只要 SVG 字符串),render 同步
  // 完成后直接返回。
  const pele = await import('pele')
  try {
    const { svg } = pele.render(trimmed, { idPrefix: uid() })
    return { svg, error: null }
  }
  catch (e: unknown) {
    // PeleError(unsupported-diagram / syntax / semantic / limit)→ 用户可读
    // message;其他异常也降级为 error,不向上抛(导出流程不能被单块中断)。
    if (e instanceof pele.PeleError) {
      const msg = e.message || 'mermaid 渲染失败'
      return { svg: '', error: msg }
    }
    const msg = (e instanceof Error ? e.message : String(e)) || 'mermaid 渲染失败'
    return { svg: '', error: msg }
  }
}

/** 失败的 mermaid 块降级为 <pre class="mermaid-error"> 包含原文。 */
export function mermaidErrorHtml(code: string, error: string): string {
  return `<pre class="mermaid-error" title="${escapeHtml(error)}">${escapeHtml(code)}</pre>`
}

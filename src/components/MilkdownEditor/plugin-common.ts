// math / mermaid 等 NodeView 用的共享工具。

/**
 * 给 NodeView 里的 input / textarea 挂上 `beforeinput` + `paste` 的
 * `stopPropagation`,把外层 ProseMirror 隔开。
 *
 * 背景:math / mermaid 的 input/textarea 是 ProseMirror 子树里真实可编辑的
 * DOM 元素。外层 ProseMirror 会在 mousedown / beforeinput / paste 阶段试图
 * 接管 —— 走自己的 input rules / transaction,把用户敲的 LaTeX 源码或
 * mermaid 源码当 markdown 解析,会乱套。NodeView 的输入框是用来编辑
 * 节点**内部值**的(LaTeX / mermaid 源码),不是 markdown 源,必须隔开。
 *
 * 注意:
 * - 只 `stopPropagation`,**不** `preventDefault`。
 *   前者只阻止事件沿 DOM 冒泡到 ProseMirror,后者会取消浏览器默认行为
 *   (输入字符 / 粘贴内容进 textarea)。我们要的是前者:粘贴板的纯文本
 *   仍能进 textarea(input/textarea 自己拿 clipboardData),只是不让
 *   ProseMirror 看到。
 * - `paste` 走自己的事件(不走 `beforeinput`),所以必须单独挂。
 */
export function isolateInputFromProseMirror(el: HTMLElement): void {
  el.addEventListener('beforeinput', (e) => { e.stopPropagation() })
  el.addEventListener('paste', (e) => { e.stopPropagation() })
}

// 源码编辑 session 检测 —— 供 onChange 判断"当前是否处于
// image/link/mark 源码编辑中间态",以决定是否对源码文本做转义补偿。
//
// 三个 session 插件(imageEdit / linkClick / markSourceEdit)共享同一范式:
//   - 进入编辑态:把渲染节点替换为纯文本源码(`![alt](src)` / `[text](url)` / `**bold**`),
//     trigger 事务挂 SKIP_CONTENT_EMIT 跳过回写
//   - 用户键入:普通事务,不挂 SKIP_CONTENT_EMIT → onChange 触发 toMarkdown →
//     纯文本里的 `![`/`[`/`(` 被 remark-stringify 转义成 `\![`/`\[`/`\(` →
//     与渲染态序列化结果不同,污染 documentStore.content
//   - commit/Escape:重建渲染节点,session 清空 → 不挂 SKIP_CONTENT_EMIT,需回写
//
// 本 helper 导出 isInSourceEditMode 和 getSourceEditRanges,供 EditorInner.vue
// 的 onChange 在 session 活跃时用占位符绕过 toMarkdown 的转义。

import type { EditorState } from 'prosemirror-state'
import { linkClickPluginKey } from '../plugins/linkClick'
import { markSourceEditKey } from '../plugins/markSourceEdit'
import { imageEditKey } from '../image/imageEditPlugin'

/** 当前是否有任何源码编辑 session 处于活跃状态(image/link/mark)。 */
export function isInSourceEditMode(state: EditorState): boolean {
  return !!(
    imageEditKey.getState(state)?.session
    || linkClickPluginKey.getState(state)?.session
    || markSourceEditKey.getState(state)?.session
  )
}

/** 获取所有活跃 session 的文本范围(绝对位置),用于 toMarkdown 占位符替换。 */
export function getSourceEditRanges(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  const imageSession = imageEditKey.getState(state)?.session
  if (imageSession) ranges.push({ from: imageSession.editFrom, to: imageSession.editTo })
  const linkSession = linkClickPluginKey.getState(state)?.session
  if (linkSession) ranges.push({ from: linkSession.editFrom, to: linkSession.editTo })
  const markSession = markSourceEditKey.getState(state)?.session
  if (markSession) ranges.push({ from: markSession.editFrom, to: markSession.editTo })
  return ranges
}

// 图片源码编辑 — Obsidian 风格的 inline source edit(走 linkClick 同款 session 范式)。
//
// 用户交互流程:
//   1. 点击图片 → NodeSelection 选中 → 右上角 code-xml 按钮浮现
//   2. 点按钮 → 把 image atom 节点替换成 markdown 源码文本 `![alt](src "title")`,
//      同时默认选中 `()` 内的 src(改链接是最高频操作);Decoration 在源码文本下方
//      渲染图片预览 widget,源码合法时图片实时跟随 src 变化,残缺时预览消失。
//      进入编辑态的 trigger 事务挂 SKIP_CONTENT_EMIT —— 这是瞬时视图切换不是
//      内容编辑,不触发内容回写(否则纯文本 `![...](` 被转义,误判 dirty)
//   3. 编辑态下:
//      - 用户编辑文本 → 普通 transaction,plugin state 自动随位置平移,预览实时重渲
//      - 光标移出源码范围 → apply 检测到,view.update 触发 commit
//      - commit:parseImageSource 合法 → 重建 image 节点(NodeSelection 选中);
//        残缺(删了 ! / ( )→ 保留为纯文本(Obsidian 降级);空文本 → 删除
//      - Escape → keymap 拦截,还原成 originalSource 对应的 image 节点(放弃编辑)
//
// 设计要点(对照 linkClick.ts):
//  - image 是 atom node 不是 mark,所以走"替换成纯文本"而非 linkClick 的"剥 mark";
//    但 session 状态机(apply mapping + pendingCommit + view.update 触发 commit +
//    Escape 还原)完全复用 linkClick 的骨架。
//  - session 状态用 Plugin.state 持有,生命周期跟 EditorState 一致 —— 切文件
//    inner 重建时旧 session 随旧 state 一起消失,不泄漏。
//  - 按钮 click 程序化触发(triggerImageEdit),不绑 click 坐标命中判定 ——
//    NodeSelection 已经给了精确 pos,getPos 直读。
//  - commit 后用 NodeSelection 选中重建的图片:视觉回到"选中态",按钮仍在,
//    用户可继续点按钮重进编辑或按方向键离开。
//  - 选中态(NodeSelection on image)键入不生效:handleKeyDown 吞可打印字符 +
//    handleTextInput 兜底,既不替换图片也不泄到相邻文本(image 是 contenteditable=
//    false inline atom,Chrome/WebView2 会把 focus 光标渲染到图片下方段落,键入
//    会误 insert 到那里 —— 详见 props 注释)
//  - 图片预览走 Decoration.widget(side:-1,渲染在源码文本之前),不持有 NodeView ——
//    替换成纯文本后 image NodeView 已销毁,编辑期间视觉层全靠这个 widget。
//    widget key 含当前源码文本,文本变 → key 变 → PM 重建 widget → toDOM 读最新
//    parseImageSource 结果 → 实时预览。源码残缺(不匹配正则)→ 不挂 widget(图片
//    隐藏,符合"语法糖残缺不渲染图片")。

import { keymap } from 'prosemirror-keymap'
import { NodeSelection, Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Decoration, DecorationSet } from 'prosemirror-view'

import { parseImageSource, serializeImageSource, parseHtmlImageSource, serializeHtmlImageSource } from './imageSource'
import { SKIP_CONTENT_EMIT } from '../editor/transactionMeta'

export const imageEditKey = new PluginKey('imageEdit')

export interface ImageEditPluginOptions {
  /** 把 markdown 里的 src 转成浏览器能展示的 url(同 imageNodeView 的 proxyDomURL)。 */
  proxyDomURL: (url: string) => string
}

interface ImageEditSession {
  /** 源码文本在当前 doc 里的范围(随用户编辑随动) */
  editFrom: number
  editTo: number
  /** 点击瞬间的源码(Escape 还原用) */
  originalSource: string
  /** 源码格式:markdown `![alt](src)` 或 html `<img src="...">`。
   *  由 triggerImageEdit 根据节点 htmlSource attr 决定,commit/escape/preview
   *  据此选对应 parse/serialize 函数。commit 重建节点时 htmlSource = format==='html'。 */
  format: 'markdown' | 'html'
}

interface ImageEditState {
  session: ImageEditSession | null
  /** apply 检测到光标移出 edit 范围,标记等下一次 view.update 触发 commit。
   *  不能在 apply 里直接 dispatch,会陷入 dispatch → apply → dispatch 循环。 */
  pendingCommit: ImageEditSession | null
}

function emptyState(): ImageEditState {
  return { session: null, pendingCommit: null }
}

export function createImageEditPlugin(opts: ImageEditPluginOptions): Plugin<ImageEditState> {
  return new Plugin<ImageEditState>({
    key: imageEditKey,

    state: {
      init() {
        return emptyState()
      },

      apply(tr, value, _oldState, newState) {
        const meta = tr.getMeta(imageEditKey) as
          | { type: 'start', session: ImageEditSession }
          | { type: 'commit' | 'cancel' }
          | undefined

        if (meta?.type === 'start') {
          return { session: meta.session, pendingCommit: null }
        }

        if (meta?.type === 'commit' || meta?.type === 'cancel') {
          return emptyState()
        }

        if (!value.session) return value

        // 普通事务下,把 session 位置随 tr.mapping 平移
        // bias 同 linkClick:边界处插入的字符不应纳入 edit 范围,否则 decoration
        // 扩到新字符上(用户感知"在图片源码后输入也带编辑样式")
        const session = value.session
        const editFrom = tr.mapping.map(session.editFrom, 1)
        const editTo = tr.mapping.map(session.editTo, -1)
        const updated: ImageEditSession = { ...session, editFrom, editTo }

        // 光标在编辑范围之外 → 标记等 view.update 触发 commit
        const sel = newState.selection
        const inside = sel.from >= editFrom && sel.to <= editTo
        return { session: updated, pendingCommit: inside ? null : updated }
      },
    },

    props: {
      decorations(state) {
        const pluginState = imageEditKey.getState(state)
        if (!pluginState?.session) return DecorationSet.empty
        const { editFrom, editTo } = pluginState.session

        const decos: Decoration[] = [
          Decoration.inline(editFrom, editTo, { class: 'velo-image-source-edit' }),
        ]

        // 图片预览 widget:源码合法时渲染在文本之后(side:1,落在源码下方),
        // 实时跟随 src。key 含当前源码 → 文本变 → 重建 widget → 实时预览。
        // 残缺 → 不挂(图片隐藏)。
        const currentText = state.doc.textBetween(editFrom, editTo, '\n', '\n')
        const parsed = pluginState.session.format === 'html'
          ? parseHtmlImageSource(currentText)
          : parseImageSource(currentText)
        if (parsed && parsed.src) {
          const extraAttrs = 'extraAttrs' in parsed ? parsed.extraAttrs : null
          decos.push(
            Decoration.widget(editTo, () => {
              const img = document.createElement('img')
              img.className = 'velo-image-source-preview'
              img.src = opts.proxyDomURL(parsed!.src)
              img.alt = parsed!.alt
              if (parsed!.title) img.title = parsed!.title
              if (extraAttrs) {
                for (const [k, v] of Object.entries(extraAttrs)) {
                  img.setAttribute(k, v)
                }
              }
              img.draggable = false
              img.contentEditable = 'false'
              return img
            }, {
              side: 1,
              key: `image-source-preview:${currentText}`,
              ignoreSelection: true,
            }),
          )
        }

        return DecorationSet.create(state.doc, decos)
      },

      // 选中图片(NodeSelection)时让键入"不生效" —— 选中态是对象选择不是编辑态,
      // 键入字符既不该替换图片也该不该泄到相邻文本。image 是 contenteditable=false
      // 的 inline atom,NodeSelection 的 focus 在 Chrome/WebView2 上会被渲染到下一个
      // 可编辑文本(图片下方段落),用户键入会 insert 到那里 —— 两道闸挡住:
      //   - handleKeyDown:可打印字符(无修饰键)吞掉 → PM preventDefault → 浏览器
      //     不发 beforeinput → 不 insert 到 DOM → 无 readDOMChange(主路径,无闪烁)。
      //     Backspace/Delete/方向键/Enter/Escape 等(key.length>1)不吞,PM 默认删图/移动。
      //     ctrl/meta/alt 组合不吞(复制/剪切/保存照常)。
      //   - handleTextInput:兜底 —— 即使 keydown 没拦下(keypress 路径 / IME / 浏览器已
      //     insert 到 DOM 触发 readDOMChange),此处读 state.selection(仍是 NodeSelection,
      //     readDOMChange 走 start-of-operation selection,见 domchange.ts:9)返回 true →
      //     吞掉 dispatch,flush 随后 updateState 把 DOM 多余文本回滚。
      handleKeyDown(view, event) {
        const sel = view.state.selection
        if (sel instanceof NodeSelection && sel.node.type.name === 'image'
          && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          return true
        }
        return false
      },
      handleTextInput(view) {
        const sel = view.state.selection
        if (sel instanceof NodeSelection && sel.node.type.name === 'image') return true
        return false
      },
    },

    view(_view) {
      return {
        update(view) {
          const pluginState = imageEditKey.getState(view.state)
          if (pluginState?.pendingCommit) {
            commitImageEdit(view)
          }
        },
      }
    },
  })
}

/** Escape → 放弃编辑,还原成点击前的 image 节点(原始 attrs)。
 *
 *  与 linkClick 不同:link 的 Escape 还原成 `[text](url)` 纯文本后,syntaxAutoFormat
 *  会把文本重新转成渲染态 link mark;image 没有实时键入转换(syntax registry 无
 *  image),纯文本 `![alt](src)` 不会自动变回 image 节点,故 Escape 直接重建 image。 */
export const imageEditEscapeKeymap = keymap({
  Escape: (state, dispatch) => {
    const pluginState = imageEditKey.getState(state)
    if (!pluginState?.session) return false

    const { editFrom, editTo, originalSource, format } = pluginState.session
    if (dispatch) {
      const tr = state.tr.delete(editFrom, editTo)
      const parsed = format === 'html'
        ? parseHtmlImageSource(originalSource) // 来自 serializeHtmlImageSource,必合法
        : parseImageSource(originalSource) // 来自 serializeImageSource,必合法
      if (parsed) {
        const extraAttrs: Record<string, string> = 'extraAttrs' in parsed ? (parsed as { extraAttrs: Record<string, string> }).extraAttrs : {}
        tr.replaceWith(editFrom, editFrom, state.schema.nodes.image.create({
          src: parsed.src,
          alt: parsed.alt,
          title: parsed.title,
          htmlSource: format === 'html',
          htmlAttrs: format === 'html' && Object.keys(extraAttrs).length ? extraAttrs : null,
        }))
        tr.setSelection(NodeSelection.create(tr.doc, editFrom))
      }
      else {
        // 防御:originalSource 不合法(不该发生)退回插文本
        tr.insertText(originalSource, editFrom)
        tr.setSelection(TextSelection.create(tr.doc, editFrom + 1))
      }
      tr.setMeta(imageEditKey, { type: 'cancel' } as const)
      dispatch(tr)
    }
    return true
  },
})

// ============================================================
//  Trigger:按钮 click 调用,把 image 节点替换成源码纯文本
// ============================================================

/** 选中图片后点按钮触发:replace image atom → 源码文本,默认选中 `()` 内的 src。
 *  src 是改链接最高频的操作;无 title 时 src 正是 `()` 内的全部内容。 */
export function triggerImageEdit(view: EditorView, pos: number): void {
  // 阅读模式下不展开源码(保持 image 渲染态)
  if (!view.editable) return
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'image') return

  const src = node.attrs.src as string
  const alt = node.attrs.alt as string
  const title = node.attrs.title as string
  const isHtml = node.attrs.htmlSource === true
  const format: 'markdown' | 'html' = isHtml ? 'html' : 'markdown'
  const htmlAttrs = (node.attrs.htmlAttrs as Record<string, string>) || null
  const source = isHtml
    ? serializeHtmlImageSource({ src, alt, title, extraAttrs: htmlAttrs || {} })
    : serializeImageSource({ src, alt, title })

  // image atom → text(source 不会是空串,schema.text 安全)
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(source))
  // 默认选中 src 值(改链接是最高频操作):
  //  - markdown `![alt](src "title")` → `()` 内的 src
  //  - html `<img src="src" alt="...">` → src 属性值
  let srcStart: number
  let srcEnd: number
  if (isHtml) {
    // `src="` 后到下一个 `"` 之间
    const srcAttr = `src="${src}"`
    const idx = source.indexOf(srcAttr)
    srcStart = pos + idx + 5 // `src="` = 5 chars
    srcEnd = srcStart + src.length
  } else {
    // `![` + alt + `](` = 4 + alt.length → src 起点
    srcStart = pos + 4 + alt.length
    srcEnd = srcStart + src.length
  }
  tr.setSelection(TextSelection.create(tr.doc, srcStart, srcEnd))
  // 进入编辑态是瞬时视图切换(image→源码文本),不是内容编辑 —— 跳过内容回写,
  // 否则 toMarkdown 把纯文本里的 `![...](` 转义成 `\![...](`,与渲染态 image
  // 序列化结果不同,误判 dirty(展开源码期间标题栏常驻 "•")。
  // commit / Escape 不挂此 meta:它们需要回写把 content 重新同步到重建后的 image。
  tr.setMeta(SKIP_CONTENT_EMIT, true)
  tr.setMeta(imageEditKey, {
    type: 'start' as const,
    session: {
      editFrom: pos,
      editTo: pos + source.length,
      originalSource: source,
      format,
    },
  })
  view.dispatch(tr)
}

/** 把 [editFrom, editTo] 范围解析回 image 节点或保留纯文本。供 view.update 在 apply
 *  检测到光标离开后调用。 */
function commitImageEdit(view: EditorView): void {
  const pluginState = imageEditKey.getState(view.state)
  if (!pluginState?.session) return

  const { editFrom, editTo, format } = pluginState.session
  const sourceText = view.state.doc.textBetween(editFrom, editTo, '\n', '\n')

  // 先用 commit meta 把 state 清掉 —— 避免 commit 自己 dispatch 的 tr 又触发 view.update
  let tr = view.state.tr.setMeta(imageEditKey, { type: 'commit' } as const)

  const parsed = format === 'html'
    ? parseHtmlImageSource(sourceText)
    : parseImageSource(sourceText)
  if (parsed) {
    // 合法 → 重建 image 节点,NodeSelection 选中(视觉回到选中态,按钮仍在)
    const imageType = view.state.schema.nodes.image
    const extraAttrs: Record<string, string> = 'extraAttrs' in parsed ? (parsed as { extraAttrs: Record<string, string> }).extraAttrs : {}
    tr = tr.replaceWith(editFrom, editTo, imageType.create({
      src: parsed.src,
      alt: parsed.alt,
      title: parsed.title,
      htmlSource: format === 'html',
      htmlAttrs: format === 'html' && Object.keys(extraAttrs).length ? extraAttrs : null,
    }))
    tr = tr.setSelection(NodeSelection.create(tr.doc, editFrom))
    view.dispatch(tr)
    return
  }

  // 残缺 → 保留为纯文本(Obsidian 降级)。空文本 → 删掉空 range(PM 不留空 text node)
  if (sourceText.trim() === '') {
    tr = tr.delete(editFrom, editTo)
    tr = tr.setSelection(TextSelection.create(tr.doc, editFrom))
  }
  view.dispatch(tr)
}

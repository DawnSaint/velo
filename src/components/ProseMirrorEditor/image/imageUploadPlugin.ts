// 图片粘贴 / 拖拽拦截 → 落盘 → 插入 image 节点。
//
// 设计要点:
//  1. 文件树拖入(自定义 MIME application/x-velo-tree-path)优先接管:
//     .md → 打开文件;图片 → 落盘 + 插 image 节点。共享逻辑见 treeDrop.ts。
//  2. OS 文件拖入 / 粘贴:只处理 image/* 文件;非图片走 ProseMirror 默认
//     (文字 / HTML / 别的格式)
//  3. 落盘走 `imageStorage.saveImageAsset` —— 有 currentFilePath 落 fileDir/assets,
//     无则落 appDataDir/assets + 绝对路径 src
//  4. 异步:save 完成后 dispatch 插图,view 销毁期 dispatch 异常被 try/catch 吞
//  5. drop 插入位置:用 view.posAtCoords(event.clientX/Y) 算 drop 点,不是 selection
//     —— handleDOMEvents 是浏览器原生事件,ProseMirror 不会自动 set selection 到
//     drop 点,得自己算。paste 用光标处(replaceSelectionWith)
//  6. 必须挂在 clipboard 插件之前注册,否则会被 ProseMirror 的
//     clipboard handler 先抢走(但 clipboard 不处理 File,只处理 HTML/text,
//     所以顺序实际不影响,挂在前面只为了逻辑清晰)

import { Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { Fragment, Slice, type Node as PMNode } from 'prosemirror-model'
import { schema as veloSchema } from '../editor/schema'
import { saveImageAsset } from '@/utils/imageStorage'
import { useDocumentStore } from '@/stores/document'
import { handleTreePathDrop, pickImageFile, parseAssetImageMime } from './treeDrop'

/** 异步保存 + 插入。 */
async function saveAndInsert(view: EditorView, file: File, dropPos: number | null): Promise<void> {
  try {
    const result = await saveImageAsset({
      currentFilePath: useDocumentStore().currentFilePath,
      file,
    })
    insertImageNode(view, result.srcForMarkdown, file.name, dropPos)
  }
  catch (e) {
    console.error('图片保存失败', e)
  }
}

/**
 * 把一张已落盘的图片插进富文本编辑器(造 image 节点 dispatch)。
 *  - dropPos != null:插到 drop 点(posAtCoords 算出)
 *  - dropPos == null:replaceSelectionWith(光标处兜底)
 *
 * dropPos 是异步落盘前抓的快照;在 saveImageAsset 跑(可达数秒)期间用户可能继续编辑,
 * 导致 dropPos 越界。clamp 到当前 doc.content.size 让 insert 永远落在合法位置 ——
 * 比"silently swallow RangeError 让图丢失"好,即便插点漂到尾部也是可见的反馈。
 *
 * view 可能已被销毁(快速切文件时);dispatch 会抛,被 try/catch 吞。
 * 抽出来供"OS 拖图(saveAndInsert)"与"文件树拖图(handleTreePathDrop)"共用。
 */
function insertImageNode(view: EditorView, src: string, alt: string, dropPos: number | null): void {
  try {
    const imageType = view.state.schema.nodes.image
    if (!imageType) return
    const node = imageType.create({ src, alt })
    const tr = view.state.tr
    if (dropPos != null) {
      const safePos = Math.min(Math.max(dropPos, 0), view.state.doc.content.size)
      tr.insert(safePos, node)
    }
    else {
      tr.replaceSelectionWith(node)
    }
    view.dispatch(tr)
  }
  catch {
    // view 已销毁,忽略
  }
}

/**
 * 从 HTML 字符串解析第一个 <table>,构造 PM table 节点。
 *
 * 背景:Excel / Sheets / 浏览器复制表格时,剪贴板同时有 text/html(<table>)、
 * text/plain(TSV)和一张 PNG 图片文件(选区渲染图)。
 * imageUploadPlugin 优先拦截图片文件 → 表格被插图。检测到 HTML 含表格时
 * 应改为插 table 节点。
 *
 * 不能走 ProseMirror 默认 HTML 路径:浏览器解析 <table> 时会自动插入 <tbody>,
 * 而 prosemirror-tables 的 table parseDOM 期望 <tr> 是 <table> 的直接子节点
 * (content: 'table_header_row table_row*'),<tbody> 导致 parseSlice 断裂成
 * 两个 table 节点(第一个空)。这里手动从 DOM 解析出规整的 table 节点。
 *
 * 行内含 th → table_header_row(table_header),否则 table_row(table_cell)。
 * 单元格只取 textContent(忽略行内格式),与 buildTsvSlice 的 TSV 路径对齐。
 * 解析失败 / 无表格 → 返回 null,让调用方 fallback。
 */
function parseTableFromHTML(html: string): PMNode | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  }
  catch {
    return null
  }
  const tableEl = doc.querySelector('table')
  if (!tableEl) return null

  const rowEls = Array.from(tableEl.querySelectorAll('tr'))
  if (rowEls.length === 0) return null

  const rows: PMNode[] = []
  for (const tr of rowEls) {
    const cellEls = Array.from(tr.querySelectorAll(':scope > th, :scope > td'))
    if (cellEls.length === 0) continue
    // 行内含 th → 整行作为 table_header_row,否则 table_row。
    const isHeader = cellEls.some(el => el.tagName === 'TH')
    const cellType = isHeader ? veloSchema.nodes.table_header : veloSchema.nodes.table_cell
    const rowType = isHeader ? veloSchema.nodes.table_header_row : veloSchema.nodes.table_row
    const cells = cellEls.map((el) => {
      const t = (el.textContent ?? '').trim()
      const p = veloSchema.nodes.paragraph.create(null, t ? veloSchema.text(t) : undefined)
      return cellType.create(null, p)
    })
    rows.push(rowType.create(null, cells))
  }
  if (rows.length === 0) return null
  return veloSchema.nodes.table.create(null, rows)
}

export const imageUploadPlugin = new Plugin({
  props: {
    // 用 handleDOMEvents 而不是 Plugin 的 handleDrop prop —— ProseMirror 的
    // handleDrop 只在 drop 命中 contentDOM 时触发,命中 editor 的 padding
    // 就会 early return,导致"无反应"。handleDOMEvents 命中整个 view.dom,
    // 任何落在 editor 区域的 drop 都捕获得到。
    //
    // 前提:tauri.conf.json 的 window.dragDropEnabled 必须是 false,否则
    // Tauri 在 webview 层拦截所有 drag 事件,ProseMirror 收不到。
    handleDOMEvents: {
      drop: (view, event) => {
        const dt = (event as DragEvent).dataTransfer
        const dragEvent = event as DragEvent

        // 资产面板拖入:图片已在磁盘上 / 是外链 URL,直接插 image 节点,不落盘。
        // 优先于树拖 / OS 拖检查 —— 三种来源互斥(各自独立 MIME),顺序不影响正确性。
        const assetData = parseAssetImageMime(dt)
        if (assetData) {
          event.preventDefault()
          const dropPos = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY })?.pos ?? null
          insertImageNode(view, assetData.src, assetData.alt, dropPos)
          return true
        }

        // 文件树拖入(.md 打开 / 图片落盘插图)。它走自定义 MIME,与 OS 拖
        // 文件的 Files 通道互斥(树拖不携带 File 对象,只写文本型 MIME)。
        // 先于 Files 检查,避免树拖的 text/plain 被当成普通文本 drop 处理。
        if (dt?.types && Array.from(dt.types).includes('application/x-velo-tree-path')) {
          const dropPos = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY })?.pos ?? null
          // 不 await:ProseMirror 的 handleDOMEvents 是同步返回;落盘/打开异步进行,
          // 其间用户能继续操作。preventDefault 已在 handleTreePathDrop 内部完成。
          void handleTreePathDrop(dragEvent, (result, alt, capturedCurrentFilePath) => {
            // race 守卫:落盘期间用户切了文档 → result.srcForMarkdown 是相对旧 doc 的 assets/,
            // 插到新 doc 里相对路径就错。跳过比插错路径好。
            if (useDocumentStore().currentFilePath !== capturedCurrentFilePath) return
            insertImageNode(view, result.srcForMarkdown, alt, dropPos)
          })
          return true
        }

        // 文件型 drop(任意类型)必须 preventDefault,否则浏览器把文件
        // 当成"打开"导航。文字 drop(无 Files type)放行给 ProseMirror 处理。
        const isFileDrop = dt?.types && Array.from(dt.types).includes('Files')
        if (!isFileDrop) return false
        event.preventDefault()
        const file = pickImageFile(dt?.files ?? null)
        if (!file) return true  // 阻止默认(浏览器会打开文件)
        // drop 位置:用 view.posAtCoords 把屏幕坐标转成文档位置
        const pos = view.posAtCoords({ left: dragEvent.clientX, top: dragEvent.clientY })?.pos ?? null
        void saveAndInsert(view, file, pos)
        return true
      },
    },
    handlePaste: (view, event) => {
      const cb = event.clipboardData

      // Excel / Sheets / 浏览器复制表格时,剪贴板同时有 text/html(<table>)、
      // text/plain(TSV)和一张 PNG 图片文件(选区渲染图)。
      // imageUploadPlugin 会优先拦截图片文件 → 表格被插图。检测到 HTML 含表格时
      // 改为手动解析 <table> 成规整的 table 节点插入,而不是插图。
      //
      // 不能走 ProseMirror 默认 HTML 路径:浏览器解析 <table> 时会自动插入 <tbody>,
      // 而 prosemirror-tables 的 table parseDOM 期望 <tr> 是 <table> 的直接子节点,
      // <tbody> 导致 parseSlice 断裂成两个 table 节点(第一个空)。详见 parseTableFromHTML。
      //
      // 纯图片粘贴(截图 / 浏览器复制图)无 text/html → 不受影响,走下方图片分支。
      const html = cb?.getData('text/html')
      if (html && /<table[\s>]/i.test(html)) {
        const table = parseTableFromHTML(html)
        if (table) {
          event.preventDefault()
          // paste 走光标处:构造封闭 slice(0/0)让 ProseMirror 走标准
          // "join 前后 paragraph" 路径把 table 作为 block 插入文档顶层。
          const slice = new Slice(Fragment.from(table), 0, 0)
          view.dispatch(view.state.tr.replaceSelection(slice))
          return true
        }
        // 解析失败 → fall through 走默认路径(不接管)。
        return false
      }

      const file = pickImageFile(cb?.files ?? null)
      if (!file) return false
      event.preventDefault()
      // paste 走光标处(replaceSelectionWith 兜底,pos 传 null)
      void saveAndInsert(view, file, null)
      return true
    },
  },
})

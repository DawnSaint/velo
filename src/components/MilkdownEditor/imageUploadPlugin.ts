// 图片粘贴 / 拖拽拦截 → 落盘 → 插入 image 节点。
//
// 设计要点:
//  1. 只处理 image/* 文件;非图片走 ProseMirror 默认(文字 / HTML / 别的格式)
//  2. 落盘走 `imageStorage.saveImageAsset` —— 有 currentFilePath 落 fileDir/assets,
//     无则落 appDataDir/assets + 绝对路径 src
//  3. 异步:save 完成后 dispatch 插图,view 销毁期 dispatch 异常被 try/catch 吞
//  4. drop 插入位置:用 view.posAtCoords(event.clientX/Y) 算 drop 点,不是 selection
//     —— handleDOMEvents 是浏览器原生事件,ProseMirror 不会自动 set selection 到
//     drop 点,得自己算。paste 用光标处(replaceSelectionWith)
//  5. 必须挂在 clipboard 插件之前注册,否则会被 ProseMirror 的
//     clipboard handler 先抢走(但 clipboard 不处理 File,只处理 HTML/text,
//     所以顺序实际不影响,挂在前面只为了逻辑清晰)

import { $prose } from '@milkdown/utils'
import { Plugin } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import { saveImageAsset } from '@/services/imageStorage'
import { useDocumentStore } from '@/stores/document'

/** 从 FileList 里挑第一个 image/* 文件;没有返回 null。 */
function pickImageFile(fileList: FileList | null | undefined): File | null {
  if (!fileList) return null
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i]
    if (f && f.type && f.type.startsWith('image/')) return f
  }
  return null
}

/**
 * 异步保存 + 插入。
 *  dropPos: 由 posAtCoords 算出的文档位置;null/undefined 走 selection 兜底
 */
async function saveAndInsert(view: EditorView, file: File, dropPos: number | null): Promise<void> {
  try {
    const result = await saveImageAsset({
      currentFilePath: useDocumentStore().currentFilePath,
      file,
    })
    // view 可能已被销毁(快速切文件时);dispatch 会抛,被内层 try 吞
    try {
      const imageType = view.state.schema.nodes.image
      if (!imageType) return
      const node = imageType.create({
        src: result.srcForMarkdown,
        alt: file.name,
      })
      const tr = view.state.tr
      if (dropPos != null) {
        tr.insert(dropPos, node)
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
  catch (e) {
    console.error('图片保存失败', e)
  }
}

export const imageUploadPlugin = $prose(() => new Plugin({
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
        // 文件型 drop(任意类型)必须 preventDefault,否则浏览器把文件
        // 当成"打开"导航。文字 drop(无 Files type)放行给 ProseMirror 处理。
        const isFileDrop = dt?.types && Array.from(dt.types).includes('Files')
        if (!isFileDrop) return false
        event.preventDefault()
        const file = pickImageFile(dt?.files ?? null)
        if (!file) return true  // 阻止默认(浏览器会打开文件)
        // drop 位置:用 view.posAtCoords 把屏幕坐标转成文档位置
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null
        void saveAndInsert(view, file, pos)
        return true
      },
    },
    handlePaste: (view, event) => {
      const cb = event.clipboardData
      const file = pickImageFile(cb?.files ?? null)
      if (!file) return false
      event.preventDefault()
      // paste 走光标处(replaceSelectionWith 兜底,pos 传 null)
      void saveAndInsert(view, file, null)
      return true
    },
  },
}))

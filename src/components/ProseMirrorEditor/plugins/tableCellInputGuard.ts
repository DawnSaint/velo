// CellSelection 输入守卫 —— 多 cell 被选中(无光标)时吞掉文字输入和 Enter,
// 防止内容落入 DOM 选区所在的最后一个 cell。
//
// 背景:CellSelection.visible=false,PM 给 .ProseMirror 加 .ProseMirror-hideselection
// 隐藏原生选区视觉,但 DOM 选区仍留在最后一个 cell。用户敲字符时浏览器在该 cell
// 插入文字,看起来像"内容输入到了一个被选中的 cell 里"。
//
// 关键陷阱:光标从表格内拖选 cell 时,浏览器原生拖拽把 DOM 选区留在最后一个 cell
// 内部,与 PM 的 CellSelection 位置不一致。PM 内置 keydown 处理器在检查 handleKeyDown
// 之前先调 forceFlush(),forceFlush 检测到 DOM 选区差异后把 CellSelection 覆盖成
// TextSelection —— 之后 beforeinput / handleTextInput 的 instanceof CellSelection 检查
// 全部失效。因此必须在 handleDOMEvents.keydown 阶段(handleDOMEvents 先于内置处理器)
// preventDefault,跳过内置 keydown 处理器(含 forceFlush),保住 CellSelection。
//
// 不拦截:Backspace/Delete(tableEditing 的 deleteCellSelection 处理)、
// 方向键(tableEditing 的 arrow 处理)、Tab(tableEditing 的 goToNextCell 处理)、
// 粘贴(tableEditing 的 handlePaste 处理 cell 粘贴)、Ctrl/Meta/Alt 组合键。

import { Plugin, PluginKey } from "prosemirror-state"
import { CellSelection } from "prosemirror-tables"
import type { EditorView } from "prosemirror-view"

export const tableCellInputGuardKey = new PluginKey("tableCellInputGuard")

// beforeinput inputType 中表示"插入文本内容"的类型(不含 delete*/paste/drop)。
// 用于 IME 组合输入(keydown keyCode=229 时 forceFlush 不跑,CellSelection 安全,
// 但 beforeinput 仍会派发 insertCompositionText)。
const INSERT_TEXT_TYPES = new Set([
  "insertText",
  "insertCompositionText",
  "insertParagraph",
  "insertLineBreak",
  "insertReplacementText",
])

// 判断 keydown 事件是否为"会产生文字内容插入"的按键(应被拦截)。
// 单字符键(a-z/0-9/标点/空格)+ Enter;排除 Ctrl/Meta/Alt 组合(快捷键)和
// 正在组合中(isComposing,交由 beforeinput 拦截)。
function isTextInsertingKey(event: KeyboardEvent): boolean {
  if (event.isComposing) return false
  const key = event.key
  if (key === "Enter") return true
  // 单字符键 = 可打印字符(不含功能键 F1~/Arrow~/Escape 等,length>1)
  return key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
}

export function createTableCellInputGuardPlugin(): Plugin {
  return new Plugin({
    key: tableCellInputGuardKey,
    props: {
      handleDOMEvents: {
        // 主防线:handleDOMEvents 先于 PM 内置处理器运行。
        // 在 keydown 阶段 preventDefault → 跳过内置 keydown(含 forceFlush),
        // CellSelection 不会被覆盖,浏览器也不会派发 beforeinput/input。
        keydown(view: EditorView, event: Event) {
          if (!(view.state.selection instanceof CellSelection)) return false
          if (isTextInsertingKey(event as KeyboardEvent)) {
            event.preventDefault()
            return true
          }
          return false
        },
        // IME 防线:中文/日文 IME 的 keydown keyCode=229,forceFlush 不跑,
        // CellSelection 安全,但 beforeinput(insertCompositionText)仍会派发。
        // 此时 keydown 的 event.key 通常是 "Process"(length>1),不被 isTextInsertingKey
        // 拦截,需在 beforeinput 阶段补拦。
        beforeinput(view: EditorView, event: Event) {
          if (!(view.state.selection instanceof CellSelection)) return false
          const inputType = (event as InputEvent).inputType
          if (inputType && INSERT_TEXT_TYPES.has(inputType)) {
            event.preventDefault()
            return true
          }
          return false
        },
      },
      // 最终 fallback:不支持 beforeinput 的旧浏览器走 keypress → handleTextInput。
      // PM keypress handler 调 handleTextInput 后统一 preventDefault,无 desync。
      handleTextInput(view: EditorView) {
        return view.state.selection instanceof CellSelection
      },
    },
  })
}

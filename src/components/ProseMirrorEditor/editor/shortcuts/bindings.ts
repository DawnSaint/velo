// 快捷键注册集中入口 —— EditorInner.vue 一行 `import './editor/shortcuts'` 触发。
//
// 新加快捷键 = 在这里加 1 行 registerShortcut(...)
// 不需要碰 EditorInner.vue,也不需要碰 registry.ts(除非改 API)。
//
// 键位约定:
//  - 跨平台用 'Mod-'(Mac=Cmd,Win=Ctrl)。避免 'Ctrl-1' 之类纯 Ctrl 键
//    在 macOS Chrome 上被浏览器 tab 切换抢走。
//  - 块级快捷键占位用了 Mod-Shift-? 组合(VSCode / Obsidian 风格)——
//    用户后续可能调整,直接改这一文件即可。
//  - 高亮用 Mod-h;水平线快捷键(Mod-Shift-h)在 v0.4.4 验收时未生效,延期后续版本。
//    insertHr 函数保留在 blockCommands.ts,重新启用只需在这里加 1 行 registerShortcut。

import { registerShortcut } from './registry'
import { toggleMarkWithWrap } from './commands/markCommands'
import { setHeading, setParagraph } from './commands/blockCommands'
import { wrapInBulletList, wrapInOrderedList, wrapInBlockquote, wrapInCodeBlock } from './commands/listCommands'
import {
  insertTable2x2,
  cmdAddRowAfter,
  cmdAddRowBefore,
  cmdDeleteRow,
  cmdDeleteColumn,
  cmdMoveRow,
  cmdMoveColumn,
} from './commands/tableCommands'
import { triggerLinkEdit } from './commands/linkCommands'
import { schema } from '../schema'

// ============================================================
//  文本 mark(选区 toggle / 空选区插包裹符 + setStoredMark)
// ============================================================

registerShortcut({
  key: 'Mod-b',
  command: toggleMarkWithWrap(schema.marks.strong, '**'),
  label: '加粗',
  group: 'text',
})

registerShortcut({
  key: 'Mod-i',
  command: toggleMarkWithWrap(schema.marks.emphasis, '*'),
  label: '斜体',
  group: 'text',
})

registerShortcut({
  key: 'Mod-Shift-s',
  command: toggleMarkWithWrap(schema.marks.strike_through, '~~'),
  label: '删除线',
  group: 'text',
})

registerShortcut({
  key: 'Mod-h',
  command: toggleMarkWithWrap(schema.marks.highlight, '=='),
  label: '高亮',
  group: 'text',
})

registerShortcut({
  key: 'Mod-u',
  command: toggleMarkWithWrap(schema.marks.underline, '<u>', '</u>', { skipSyntaxAutoFormat: true }),
  label: '下划线',
  group: 'text',
})

registerShortcut({
  key: 'Mod-.',
  command: toggleMarkWithWrap(schema.marks.superscript, '^'),
  label: '上标',
  group: 'text',
})

registerShortcut({
  key: 'Mod-k',
  command: triggerLinkEdit,
  label: '链接',
  group: 'text',
})

// ============================================================
//  块级(标题 / 段落)
// ============================================================

registerShortcut({
  key: 'Mod-0',
  command: setParagraph(schema),
  label: '段落',
  group: 'block',
})

for (const level of [1, 2, 3, 4, 5, 6] as const) {
  registerShortcut({
    key: `Mod-${level}`,
    command: setHeading(schema, level),
    label: `标题 ${level}`,
    group: 'block',
  })
}

// ============================================================
//  列表 / 引用 / 代码块(占位键位,用户后续可调整)
// ============================================================

registerShortcut({
  key: 'Mod-Shift-7',
  command: wrapInOrderedList(schema),
  label: '有序列表',
  group: 'block',
})

registerShortcut({
  key: 'Mod-Shift-8',
  command: wrapInBulletList(schema),
  label: '无序列表',
  group: 'block',
})

registerShortcut({
  key: 'Mod-Shift->',
  command: wrapInBlockquote(schema),
  label: '引用',
  group: 'block',
})

registerShortcut({
  key: 'Mod-Shift-c',
  command: wrapInCodeBlock(schema),
  label: '代码块',
  group: 'block',
})

// ============================================================
//  表格
// ============================================================

registerShortcut({
  key: 'Mod-t',
  command: insertTable2x2(schema),
  label: '插入 2x2 表格',
  group: 'table',
})

// —— 表格操作快捷键(仅在表格内生效) ——
// tableAction 与 TableContextMenu.vue 的 TableAction 枚举对齐,同条目会
// 在右键菜单中展示快捷键;未加 tableAction 的表快捷键(如 Mod-t 插入表格)不在菜单显示。
registerShortcut({
  key: 'Mod-Enter',
  command: cmdAddRowAfter(schema),
  label: '表格:下方插入行',
  group: 'table',
  tableAction: 'add-row-after',
})
registerShortcut({
  key: 'Mod-Shift-Enter',
  command: cmdAddRowBefore(schema),
  label: '表格:上方插入行',
  group: 'table',
  tableAction: 'add-row-before',
})
registerShortcut({
  key: 'Mod-Backspace',
  command: cmdDeleteRow(schema),
  label: '表格:删除当前行',
  group: 'table',
  tableAction: 'delete-row',
})
registerShortcut({
  key: 'Mod-Shift-Backspace',
  command: cmdDeleteColumn(schema),
  label: '表格:删除当前列',
  group: 'table',
  tableAction: 'delete-column',
})

// —— 表格行/列移动快捷键(CellSelection 矩形整块单步 swap,触边 noop) ——
registerShortcut({
  key: 'Mod-Shift-ArrowUp',
  command: cmdMoveRow(-1),
  label: '表格:上移行',
  group: 'table',
  tableAction: 'move-row-up',
})
registerShortcut({
  key: 'Mod-Shift-ArrowDown',
  command: cmdMoveRow(1),
  label: '表格:下移行',
  group: 'table',
  tableAction: 'move-row-down',
})
registerShortcut({
  key: 'Mod-Shift-ArrowLeft',
  command: cmdMoveColumn(-1),
  label: '表格:左移列',
  group: 'table',
  tableAction: 'move-column-left',
})
registerShortcut({
  key: 'Mod-Shift-ArrowRight',
  command: cmdMoveColumn(1),
  label: '表格:右移列',
  group: 'table',
  tableAction: 'move-column-right',
})

// —— Alt+方向键:移动当前行/列(光标在 cell 内即可,无需 CellSelection) ——
// 与 Mod-Shift-Arrow 共用 cmdMoveRow/cmdMoveColumn,后者已支持 TextSelection-in-cell。
registerShortcut({
  key: 'Alt-ArrowUp',
  command: cmdMoveRow(-1),
  label: '表格:上移行',
  group: 'table',
})
registerShortcut({
  key: 'Alt-ArrowDown',
  command: cmdMoveRow(1),
  label: '表格:下移行',
  group: 'table',
})
registerShortcut({
  key: 'Alt-ArrowLeft',
  command: cmdMoveColumn(-1),
  label: '表格:左移列',
  group: 'table',
})
registerShortcut({
  key: 'Alt-ArrowRight',
  command: cmdMoveColumn(1),
  label: '表格:右移列',
  group: 'table',
})
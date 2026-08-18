// 块级命令 —— 标题级别切换、段落、水平线。
//
// 工厂模式(接受 schema 参数):测试 / 多实例可替换 schema,不绑死。
// 命令返回 Command:不传 dispatch 时只检查能否执行,传 dispatch 才落 tr。

import { setBlockType } from 'prosemirror-commands'
import type { Schema } from 'prosemirror-model'
import type { ShortcutCommand } from '../registry'

/**
 * 切到指定级别 heading(1-6)。
 * 当前已是同级 heading → 退化为段落(用户连按 Mod-1 两次的常见意图)。
 * 在 list_item / code_block 等非 paragraph 容器里也尝试转 —— setBlockType 会自动
 * 适配 paragraph child。
 */
export function setHeading(schema: Schema, level: 1 | 2 | 3 | 4 | 5 | 6): ShortcutCommand {
  return (state, dispatch) => {
    const headingType = schema.nodes.heading
    if (!headingType) return false
    const { from, to } = state.selection
    let alreadyAtLevel = false
    state.doc.nodesBetween(from, to, (node) => {
      if (!alreadyAtLevel
        && node.type.name === 'heading'
        && node.attrs.level === level) {
        alreadyAtLevel = true
      }
    })
    if (alreadyAtLevel) {
      // 退化为段落
      return setBlockType(schema.nodes.paragraph)(state, dispatch)
    }
    return setBlockType(headingType, { level })(state, dispatch)
  }
}

/** 切到段落(任何 heading 退回 paragraph;paragraph 上是 noop) */
export function setParagraph(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const paragraphType = schema.nodes.paragraph
    if (!paragraphType) return false
    return setBlockType(paragraphType)(state, dispatch)
  }
}

/** 插入水平线 —— 在选区位置插入一个 hr 节点 */
export function insertHr(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const hrType = schema.nodes.hr
    if (!hrType) return false
    if (!dispatch) return true
    const { from, to } = state.selection
    const tr = state.tr.replaceRangeWith(from, to, hrType.create())
    dispatch(tr)
    return true
  }
}

/**
 * 提升标题级别(Ctrl+=)：paragraph→h6, h6→h5, …, h2→h1, h1→noop。
 * = 加号方向：从正文直接跳到最高级别 h6,逐级回到 h1。
 */
export function promoteHeading(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const headingType = schema.nodes.heading
    if (!headingType) return false
    const { from, to } = state.selection
    let currentLevel = 0
    state.doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'heading') {
        if (currentLevel === 0 || node.attrs.level < currentLevel) {
          currentLevel = node.attrs.level
        }
      }
    })
    // paragraph(level 0)→ heading 6;h1 → noop
    if (currentLevel === 0) {
      return setBlockType(headingType, { level: 6 })(state, dispatch)
    }
    if (currentLevel <= 1) return false
    return setBlockType(headingType, { level: currentLevel - 1 })(state, dispatch)
  }
}

/**
 * 降低标题级别(Ctrl+-)：h1→h2, …, h5→h6, h6→paragraph。
 * 正文(paragraph)→ noop;降级到 h6 后再按回到正文。
 */
export function demoteHeading(schema: Schema): ShortcutCommand {
  return (state, dispatch) => {
    const headingType = schema.nodes.heading
    const paragraphType = schema.nodes.paragraph
    if (!headingType || !paragraphType) return false
    const { from, to } = state.selection
    let currentLevel = 0
    state.doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'heading') {
        if (currentLevel === 0 || node.attrs.level > currentLevel) {
          currentLevel = node.attrs.level
        }
      }
    })
    // paragraph(level 0)→ noop;h6 → paragraph
    if (currentLevel === 0) return false
    if (currentLevel >= 6) {
      return setBlockType(paragraphType)(state, dispatch)
    }
    return setBlockType(headingType, { level: currentLevel + 1 })(state, dispatch)
  }
}
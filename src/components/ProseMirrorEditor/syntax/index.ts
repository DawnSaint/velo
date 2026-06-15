// 语法注册入口 —— EditorInner.vue 一次性 import 这个文件,触发 register 副作用。
//
// 顺序约定:
//  1. block syntaxes 优先级高于 inline(block 命中时整段换 type,inline 不再尝试)
//  2. block 内部按"特异性"排序:更具体的写在前面
//     - heading / codeBlock / hr 互不冲突,顺序无关
//     - bulletList(`- ` / `- [ ] `)/ orderedList(`\d+. `)同上
//     - blockquote(`> `)同上
//  3. inline 按"互不冲突"排序;命中后 break 当前 syntax 循环,其他 syntax
//     仍会在下一轮扫到(框架内 for of inlineSyntaxes 仍会继续)

import { registerBlockSyntax, registerInlineSyntax } from '../editor/syntaxRegistry'

import { headingSyntax } from './block/heading'
import { codeBlockSyntax } from './block/codeBlock'
import { blockquoteSyntax } from './block/blockquote'
import { bulletListSyntax } from './block/bulletList'
import { orderedListSyntax } from './block/orderedList'
import { hrSyntax } from './block/hr'
import { alertSyntax } from './block/alert'

import { emphasisUnderscoreSyntax } from './inline/emphasis'
import { strikeSyntax } from './inline/strike'
import { inlineMathSyntax } from './inline/inlineMath'
import { footnoteRefSyntax } from './inline/footnoteRef'
import { linkSyntax } from './inline/link'

registerBlockSyntax(headingSyntax)
registerBlockSyntax(codeBlockSyntax)
registerBlockSyntax(blockquoteSyntax)
registerBlockSyntax(bulletListSyntax)
registerBlockSyntax(orderedListSyntax)
registerBlockSyntax(hrSyntax)
// alert 必须在 blockquote 之后:它依赖 blockquote 已成形,不抢同级触发
registerBlockSyntax(alertSyntax)

registerInlineSyntax(linkSyntax)         // 优先 link,避免 [^id] 误抓 link 模式中的 ]
registerInlineSyntax(footnoteRefSyntax)
registerInlineSyntax(inlineMathSyntax)
registerInlineSyntax(strikeSyntax)
registerInlineSyntax(emphasisUnderscoreSyntax)

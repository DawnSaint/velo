// 查找替换的"用户意图"状态 —— 由 App.vue provide,两份 FindReplace(PM / CM6)inject 共享。
//
// 为什么上提到 App.vue 而非 FindReplace 本地 ref:切模式时 PM 那份 FindReplace 整个
// 卸载、CM6 那份新挂载,本地 ref 随卸载丢弃 → query 被清。把意图字段放 App.vue,
// 切模式只换后端,query / 选项 / 替换文 / showReplace 天然存活。
//
// 注意区分:意图(query / 选项 / 替换文 / showReplace)跨模式保留;**matches /
// currentIndex 不上提** —— 它们是模式相关的(PM prose 文本 vs CM6 raw md,命中位置和
// 数量都不同),新挂载时由 FindReplace 用当前后端 recomputeMatches 重算。

import type { InjectionKey, Ref } from 'vue'

export interface FindIntent {
  query: Ref<string>
  replacement: Ref<string>
  caseSensitive: Ref<boolean>
  wholeWord: Ref<boolean>
  regex: Ref<boolean>
  showReplace: Ref<boolean>
}

export const findIntentKey: InjectionKey<FindIntent> = Symbol('veloFindIntent')

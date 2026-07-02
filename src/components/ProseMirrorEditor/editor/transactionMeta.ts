// 跨模块共享的事务 meta key —— 把"事务语义"信号从 dispatch 侧传给
// useProseMirror 的 dispatchTransaction(唯一状态变更入口),不耦合具体插件。
//
// 与 setMeta(pluginKey, ...) 的区别:后者是"某插件的私有 state meta",只有
// 该插件的 apply 读;本文件导出的是"dispatchTransaction 行为 meta",由
// useProseMirror 统一消费,任何插件都可挂。

/**
 * 设为 true 时,useProseMirror 的 dispatchTransaction 跳过 onChange 内容回写
 * (即不 emit update:modelValue、不更新 documentStore.content)。
 *
 * 用于"进入编辑态"这类**瞬时** doc 结构变更 —— 例如 image atom 节点被替换成
 * `![alt](src)` 纯文本以进入源码编辑。此时 doc 结构确实变了(节点类型从 image
 * 变 text),但用户语义上没有改内容;若照常回写,toMarkdown 会把纯文本里的
 * `![...](` 转义成 `\![...](`,与渲染态 image 序列化结果不同,触发
 * `content !== lastSavedContent` → 误判 dirty,展开源码期间标题栏常驻 "•"。
 *
 * 仅跳过 onChange;选区变更回调(onSelectionChange)仍照常走,光标 / 状态栏
 * 不受影响。commit / Escape 不挂此 meta —— 它们需要回写以把 content 重新同步
 * 到重建后的 image 形态(否则 content 会停在编辑期间的转义文本上,与实际 doc
 * 脱节,Ctrl+S 写盘会写出错误的转义串)。
 */
export const SKIP_CONTENT_EMIT = 'velo:skipContentEmit'

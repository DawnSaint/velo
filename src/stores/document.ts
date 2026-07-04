import { ref, computed, markRaw } from 'vue'
import { defineStore } from 'pinia'
import { open as openDialog, save as saveDialog, confirm, message } from '@/tauri/dialog'
import { readTextFile, writeTextFile, watch, type UnwatchFn } from '@/tauri/fs'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { MARKDOWN_DIALOG_FILTERS } from '@/utils/markdownPath'
import { useRecentFilesStore } from './recentFiles'
import {
  saveDraft as saveDraftToFs,
  loadDrafts as loadDraftsFromFs,
  deleteDraft as deleteDraftFromFs,
  type Draft,
} from './persistence'
import { fromMarkdown, toMarkdown } from '@/components/ProseMirrorEditor/editor/markdownIO'
import { schema as pmSchema } from '@/components/ProseMirrorEditor/editor/schema'

// Tauri 的错误形态不一致:writeTextFile 拒绝时是 Error,readTextFile 拒绝时
// 可能是 string。统一抽成字符串塞进 message 弹窗。
function formatError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  }
  catch {
    return String(e)
  }
}

/**
 * 单个文档(标签)的可变状态。documentStore 持有 `documents: Map<id, DocState>`
 * + `activeId` 实现多标签;对外仍暴露 `content` / `currentFilePath` / `dirty` 等
 * computed 代理到 active doc,使历史消费方无需改动。
 *
 * `sourceMode` / `autoSave*` / `draftScope` / `focusRequestToken` / 草稿恢复列表
 * 是窗口级全局状态,留在 store 根,不下沉到 DocState。
 *
 * `pmState` / `cmState` / `scrollTop` 是 Step 3「切标签保留 undo/滚动/光标」用的
 * 缓存槽;赋值时必须用 `markRaw` 包裹(EditorState / CM6 state 不可深响应化)。
 */
interface DocState {
  id: string
  content: string
  /** 磁盘基线;dirty = content !== lastSavedContent。只在 load/save/saveAs/recoverDraft 推进 */
  lastSavedContent: string
  currentFilePath: string | null
  /** sample 等无磁盘实体文件时的虚拟标题;有则 fileName 优先用它 */
  virtualFileName: string | null
  /** 装载时锁定(sample 锁 true,真实文件 false);锁住时用户翻不动 readOnly */
  readOnlyLocked: boolean
  /** 用户主动翻的 readOnly(StatusBar / Ctrl+Shift+R);effective = userReadOnly || readOnlyLocked */
  userReadOnly: boolean
  /** 该文档自己的 fs:watch 句柄;每个标签各自监听自己的文件 */
  unwatch: UnwatchFn | null
  externalCheckInFlight: boolean
  // Step 3 缓存(Step 1 未使用,占位)
  pmState?: unknown
  cmState?: unknown
  scrollTop?: number
}

let docIdSeq = 0
function nextDocId(): string {
  return `doc-${++docIdSeq}`
}

/** 空文档的 canonical 形式(toMarkdown(fromMarkdown('')))。init('') 走 raw '',
 * createTab 走 canonical —— 两者都算「空白」,判断 pristine blank 时都接受。 */
const BLANK_CANONICAL = toMarkdown(fromMarkdown('', pmSchema))

function newBlankDoc(id: string): DocState {
  return {
    id,
    content: '',
    lastSavedContent: '',
    currentFilePath: null,
    virtualFileName: null,
    readOnlyLocked: false,
    userReadOnly: false,
    unwatch: null,
    externalCheckInFlight: false,
  }
}

export const useDocumentStore = defineStore('document', () => {
  // 多标签核心:documents 是标签集合(插入序保序),activeId 是当前标签
  const documents = ref<Map<string, DocState>>(new Map())
  const activeId = ref<string>('')

  // ===== 窗口级全局状态(不下沉到 DocState)=====
  const sourceMode = ref(false)
  const autoSaveEnabled = ref(false)
  const autoSaveOnBlur = ref(false)
  // 草稿 id 的 window scope(Tauri 窗口 label);同一窗口所有标签共享
  const draftScope = ref<string | null>(null)
  // newDoc 的「显式切换意图」信号;全局(EditorInner watch)
  const focusRequestToken = ref(0)
  // 切标签信号;Step 3 用来触发 EditorInner 恢复缓存 state
  const tabSwitchToken = ref(0)
  const pendingRecoveryDrafts = ref<Draft[]>([])

  function activeDoc(): DocState | undefined {
    return documents.value.get(activeId.value)
  }

  /** 确保有一个活动 doc;没有就创建一个空白标签(主要用于测试 / 未 init 路径,
   *  生产里 App.vue setup 顶层已 init('') 创建首个标签,此分支不会触发)。 */
  function ensureActiveDoc(): DocState {
    let d = activeDoc()
    if (!d) {
      d = newBlankDoc(nextDocId())
      const canonical = toMarkdown(fromMarkdown('', pmSchema))
      d.content = canonical
      d.lastSavedContent = canonical
      documents.value.set(d.id, d)
      activeId.value = d.id
    }
    return d
  }

  function docFileName(d: DocState): string {
    if (d.virtualFileName) return d.virtualFileName
    return d.currentFilePath
      ? d.currentFilePath.split(/[\\/]/).pop() ?? '未命名'
      : '未命名'
  }

  // ===== 向后兼容的 computed 代理(指向 active doc)=====
  // content / currentFilePath 设成可写:历史调用方(含测试)有直接赋值习惯,
  // set 时写回 active doc 的字段(等价于直接动 ref,但不走 syncTitle/loadContent)。
  const content = computed({
    get: () => activeDoc()?.content ?? '',
    set: (v) => {
      const d = ensureActiveDoc()
      d.content = v
    },
  })
  const currentFilePath = computed({
    get: () => activeDoc()?.currentFilePath ?? null,
    set: (v) => {
      const d = activeDoc()
      if (d) d.currentFilePath = v
    },
  })
  const dirty = computed(() => {
    const d = activeDoc()
    return d ? d.content !== d.lastSavedContent : false
  })
  const readOnlyLocked = computed(() => activeDoc()?.readOnlyLocked ?? false)
  const readOnly = computed({
    get: () => {
      const d = activeDoc()
      return d ? d.userReadOnly || d.readOnlyLocked : false
    },
    set: (v) => {
      const d = activeDoc()
      // readOnlyLocked 时尊重锁(sample 不能被翻回可编辑),setter 静默 no-op
      if (!d || d.readOnlyLocked) return
      d.userReadOnly = v
    },
  })
  const virtualFileName = computed({
    get: () => activeDoc()?.virtualFileName ?? null,
    set: (v) => {
      const d = activeDoc()
      if (d) d.virtualFileName = v
    },
  })
  const fileName = computed(() => {
    const d = activeDoc()
    return d ? docFileName(d) : '未命名'
  })

  /** 标签条 UI 用的标签列表(插入序);每项含 id / 标题 / dirty / 只读锁 / 是否激活 */
  const tabs = computed(() => {
    const aid = activeId.value
    return [...documents.value.values()].map(d => ({
      id: d.id,
      fileName: docFileName(d),
      dirty: d.content !== d.lastSavedContent,
      readOnlyLocked: d.readOnlyLocked,
      active: d.id === aid,
    }))
  })

  /** 「干净的空白未命名标签」判断:活动标签无 path + 未编辑 + 内容是空白('' 或 canonical 空文档)。
   *  开文件 / 装载 sample / newDoc 时复用它,避免留一串空标签(典型:启动 init 的空白标签)。
   *  内容必须是真空白(不是 'hello world' 这种有内容的干净未命名文档)—— 否则 newDoc 会吞掉它。 */
  function isPristineBlank(d: DocState | undefined): d is DocState {
    return !!d && !d.currentFilePath
      && d.content === d.lastSavedContent
      && (d.content === '' || d.content === BLANK_CANONICAL)
  }

  function toggleSourceMode() {
    sourceMode.value = !sourceMode.value
  }

  function setDraftScope(scope: string | null) {
    draftScope.value = scope
  }

  // 缓存上一次写进原生 title bar 的字符串。setContent 每次按键都调
  // syncTitle,但 dirty 状态在编辑过程中通常保持不变(只有 clean ↔ dirty
  // 切换、fileName 变化时才真变),所以绝大多数调用算出的 title 跟上次一样。
  // 拿一个 module-local 字符串比一比,相等就跳过 setTitle IPC —— 之前每个
  // 键击都触发一次跨进程调用,长会话下 IPC 通道很吵。
  let lastTitle = ''

  function syncTitle() {
    const d = activeDoc()
    const name = d ? docFileName(d) : '未命名'
    const isDirty = d ? d.content !== d.lastSavedContent : false
    const next = `${name}${isDirty ? ' •' : ''} - Velo Editor`
    if (next === lastTitle) return
    lastTitle = next
    // 浏览器(纯 vite dev,无 Tauri)环境下 getCurrentWindow()
    // 访问 window.__TAURI_INTERNALS__.metadata 同步抛 TypeError。`void expr`
    // 只丢弃返回值,不捕同步异常 —— 导致整个组件渲染失败、浏览器白屏(Tauri 里正常)。
    try {
      void getCurrentWindow().setTitle(next)
    }
    catch {
      // 非 Tauri 环境:没原生 title bar,跳过即可
    }
  }

  // ========== 外部修改监听(每个 DocState 各自监听自己的文件)==========
  //
  // fs:watch 把"文件被改动"信号丢给 checkExternalChange(d);自己写的会被
  // lastSavedContent 比对过滤掉。重入保护(每 doc 一个 flag)避免一次 burst
  // 触发多个 confirm。

  async function stopWatch(d: DocState) {
    if (!d.unwatch) return
    try { await d.unwatch() }
    catch (e) { console.warn('停止文件监听失败', e) }
    d.unwatch = null
  }

  async function startWatchOf(d: DocState, path: string) {
    await stopWatch(d)
    try {
      // delayMs: notify-rs 把短时间内的多次事件合并成一次回调
      d.unwatch = await watch(
        path,
        () => { void checkExternalChange(d) },
        { delayMs: 100 },
      )
    }
    catch (e) {
      console.error('文件监听启动失败', e)
    }
  }

  /**
   * 主动检查某个 doc 在磁盘上是否被改过。
   * — fs 监听回调里调一次(传具体 doc)
   * — App.vue 在 window focus 时调一次(默认 active doc,fallback 覆盖 notify-rs 漏报)
   */
  async function checkExternalChange(d: DocState = activeDoc()!): Promise<void> {
    if (!d) return
    const path = d.currentFilePath
    if (!path) return
    if (d.externalCheckInFlight) return
    d.externalCheckInFlight = true
    try {
      let disk: string
      try {
        disk = await readTextFile(path)
      }
      catch (e) {
        console.warn(`「${docFileName(d)}」无法读取，可能已被删除或重命名`, e)
        return
      }
      // 我们自己写的（save/saveAs 写完会推进 lastSavedContent）
      if (disk === d.lastSavedContent) return
      // 磁盘内容已经和编辑器里的一致（比如别人重写为同样内容）：只刷新基线
      if (disk === d.content) {
        d.lastSavedContent = disk
        return
      }
      // 真的有外部修改
      const isDirty = d.content !== d.lastSavedContent
      if (!isDirty) {
        // 干净：直接重载，不打扰用户
        loadContentInto(d, disk, path)
        return
      }
      const reload = await confirm(
        `「${docFileName(d)}」在编辑器外被修改了。\n本地还有未保存的修改 —— 确定要丢弃本地版本并重新加载吗？`,
        { title: '文件已变化', kind: 'warning' },
      )
      if (reload) loadContentInto(d, disk, path)
    }
    finally {
      d.externalCheckInFlight = false
    }
  }

  /**
   * 编辑器把当前 markdown 回写进 store —— 也是 v-model 的 update 钩子。
   *
   * 注意:这里**不**更新 lastSavedContent。基线只在 loadContent / save /
   * recoverDraft 里推进。之前用 echosToAccept 计数器让编辑器回吐的
   * "规范化版本"推进基线,但计数器没法区分"编辑器 echo"和"用户真实编辑"
   * —— 如果用户恰好在 echo 到达前敲了键,那次编辑会被误吞成 echo,
   * 把 lastSavedContent 推向新内容。后果:切窗口失焦再 focus 时
   * checkExternalChange 看到 disk(旧) !== lastSavedContent(新) !== content(新),
   * dirty=true,于是弹出"文件在编辑器外被修改"的误报。
   */
  function setContent(v: string) {
    const d = activeDoc()
    if (d) d.content = v
    void syncTitle()
  }

  /** App.vue 在 setup 阶段调用一次,创建首个(空白)标签 */
  function init(initial: string) {
    // 幂等:HMR / 二次调用时已有标签则不重建
    if (documents.value.size > 0) return
    const d = newBlankDoc(nextDocId())
    d.content = initial
    d.lastSavedContent = initial
    documents.value.set(d.id, d)
    activeId.value = d.id
    void syncTitle()
  }

  /** 把内容装载到指定 doc,并把它视作磁盘基线。
   * 第三个参数 `readOnlyLocked` 控制锁:sample 装载时传 true(永久只读),
   * 真实文件 / 新建文档传 false(用户可自由翻)。装载时同时重置 `userReadOnly`
   * —— 切到新文件相当于"新的开始",用户之前的偏好不应该带过来。 */
  function loadContentInto(d: DocState, c: string, path: string | null, readOnlyLocked_ = false) {
    d.currentFilePath = path
    // 切换到真实文件时清掉虚拟名(sample 装载后由 caller 单独 setVirtualFileName)
    d.virtualFileName = null
    d.readOnlyLocked = readOnlyLocked_
    d.userReadOnly = false
    // 把磁盘内容过一遍 markdownIO 拿到 PM canonical 形式。
    // 原因:round-trip(multi-empty-lines / html inline 等)在 toMarkdown 不与磁盘原文字节相等,
    // 但 PM 内部状态是稳定的 —— load 时把磁盘内容规范化成 PM canonical 同时塞进
    // `content` 和 `lastSavedContent`,后续编辑器 emit 仍是同一 canonical,
    // 用户 type + delete 回到原状时 emit 与基线一致,`dirty = false` 归零。
    // 等价于 markdown 编辑器的"打开即规范化",打开多空行文件 + 任意编辑 + 删除
    // 不再永久 dirty。sample / new doc 空内容 canonical 也是 ''。
    const canonical = toMarkdown(fromMarkdown(c, pmSchema))
    d.content = canonical
    d.lastSavedContent = canonical
    // 内容已外部替换 → Step 3 的 cached editor state 失效,切回时重建
    d.pmState = undefined
    d.cmState = undefined
    d.scrollTop = undefined
    void syncTitle()
    // 切换文件 / 新建:重建监听
    if (path) void startWatchOf(d, path)
    else void stopWatch(d)
  }

  /** 装载到 active doc 的快捷入口(等价 loadContentInto(activeDoc, ...))。
   *  无活动 doc 时自动创建一个(测试 / 未 init 路径)。 */
  function loadContent(c: string, path: string | null, readOnlyLocked_ = false) {
    const d = ensureActiveDoc()
    loadContentInto(d, c, path, readOnlyLocked_)
  }

  /** active doc 脏盘时弹原生确认,true=用户同意放弃,可继续覆盖 */
  async function confirmDiscardIfDirty(): Promise<boolean> {
    const d = activeDoc()
    if (!d || d.content === d.lastSavedContent) return true
    return await confirm(
      `「${docFileName(d)}」有未保存的修改，确定要放弃吗？`,
      { title: '未保存的修改', kind: 'warning' },
    )
  }

  /** 只读模式下禁止写入磁盘 */
  function guardReadOnly(): boolean {
    const d = activeDoc()
    if (d && (d.userReadOnly || d.readOnlyLocked)) {
      void message('示例文档为只读，请使用"另存为"保存到工作区后再编辑。', { title: '只读文档', kind: 'info' })
      return true
    }
    return false
  }

  /**
   * 打开一个文件到 active doc。readTextFile 抛错(文件不存在 / 无权限 / 网络盘断)时,
   * 弹原生 message 告知用户,**不**调 loadContent —— 不污染当前编辑器状态。
   *
   * 这是 CLI 启动路径(`App.vue` 冷启动 / 二次启动 cli-args)唯一能反馈
   * "打开失败"的地方:这两处都是 `void openPath(...)` fire-and-forget,
   * 不在 store 内 catch 就会变成 unhandled rejection,用户看不到任何提示,
   * 会以为启动正常只是文件不存在。
   *
   * Step 1:仍装载到 active doc(单标签行为);Step 2 起 openPathInTab 负责复用/新开标签。
   */
  async function openPath(path: string): Promise<boolean> {
    try {
      const c = await readTextFile(path)
      loadContent(c, path)
      useRecentFilesStore().push(path)
      return true
    }
    catch (e) {
      console.error('打开文件失败', path, e)
      await message(`无法打开 ${path}:${formatError(e)}`, { title: '打开失败', kind: 'error' })
      return false
    }
  }

  async function open() {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: MARKDOWN_DIALOG_FILTERS,
    })
    if (typeof selected === 'string') {
      await openPathInTab(selected)
    }
  }

  /**
   * 多标签打开入口:已开则切到该标签;未开则新开标签(或复用干净的未命名标签)。
   * 不弹当前活动标签的脏盘确认 —— 新文件走新标签,旧标签原样保留。
   * readTextFile 抛错时弹原生 message,**不**创建空标签。
   */
  async function openPathInTab(path: string): Promise<boolean> {
    const existing = findTabByPath(path)
    if (existing) {
      switchTab(existing)
      useRecentFilesStore().push(path)
      return true
    }
    let c: string
    try {
      c = await readTextFile(path)
    }
    catch (e) {
      console.error('打开文件失败', path, e)
      await message(`无法打开 ${path}:${formatError(e)}`, { title: '打开失败', kind: 'error' })
      return false
    }
    // 复用干净的未命名标签(启动 init 空白),否则新开
    if (!isPristineBlank(activeDoc())) {
      const id = createTab()
      switchTab(id)
    }
    loadContent(c, path)
    useRecentFilesStore().push(path)
    return true
  }

  /** 装载示例(只读,无磁盘实体)到新标签或复用干净未命名标签。 */
  function openSampleTab(content: string, label: string) {
    if (!isPristineBlank(activeDoc())) {
      const id = createTab()
      switchTab(id)
    }
    const d = activeDoc()!
    loadContentInto(d, content, null, true)
    // loadContentInto 清了 virtualFileName,sample 需要虚拟标题 → 装载后再设
    d.virtualFileName = label
  }

  /** 窗口关闭 / 批量保存:遍历所有脏盘标签写盘。无 path 的脏盘标签走 saveAsDoc
   *  (弹 dialog);任一失败 / 用户取消 → 中止返回 false。 */
  async function saveAllDirtyTabs(): Promise<boolean> {
    for (const d of [...documents.value.values()]) {
      if (d.content === d.lastSavedContent) continue
      if (d.userReadOnly || d.readOnlyLocked) continue
      const ok = d.currentFilePath ? await saveDoc(d) : await saveAsDoc(d)
      if (!ok) return false
    }
    return true
  }

  /** 草稿定时落盘:遍历所有脏盘标签各落一份(每 doc 的 pathId 各自独立)。 */
  async function saveAllDrafts() {
    for (const d of [...documents.value.values()]) {
      if (d.content === d.lastSavedContent) continue
      const id = currentDraftIdFor(d)
      if (!id) continue
      await saveDraftToFs({
        version: 1,
        id,
        originalPath: d.currentFilePath,
        content: d.content,
        savedAt: Date.now(),
      })
    }
  }

  /** 写盘成功返回 true；用户取消另存为 / 写盘抛错 返回 false。 */
  async function save(): Promise<boolean> {
    const d = activeDoc()
    if (!d) return false
    if (await guardReadOnly()) return false
    if (!d.currentFilePath) return saveAsDoc(d)
    return saveDoc(d)
  }

  /** 指定 doc 写盘(无需切换激活)。无 path / 只读 → false。 */
  async function saveDoc(d: DocState): Promise<boolean> {
    if (d.userReadOnly || d.readOnlyLocked) return false
    if (!d.currentFilePath) return false
    const path = d.currentFilePath
    const snapshot = d.content
    const previousBaseline = d.lastSavedContent
    // 写盘前就把基线推进 —— 这样 fs:watch 触发的 checkExternalChange 看到
    // disk === lastSavedContent，把我们自己的写当成"非事件"过滤掉。
    // 如果写盘抛错就回滚。
    d.lastSavedContent = snapshot
    try {
      await writeTextFile(path, snapshot)
      // 写盘成功 → 草稿没用了,清掉
      await clearDraftForDoc(d)
      void syncTitle()
      return true
    }
    catch (e) {
      console.error('保存失败', e)
      d.lastSavedContent = previousBaseline
      // 写盘失败必须给用户可见反馈 —— 仅 console.error 用户根本看不到。
      // 自动保存 / Ctrl+S / 关闭拦截都会走这里;任一场景下"以为保存成功"
      // 都会丢数据。弹原生 message 显式告知失败原因。
      await message(`保存失败:${formatError(e)}`, { title: '保存失败', kind: 'error' })
      return false
    }
  }

  async function saveAs(): Promise<boolean> {
    const d = activeDoc()
    if (!d) return false
    return saveAsDoc(d)
  }

  /** 指定 doc 另存为(无需切换激活)。弹 saveDialog → 写新路径 → 切换该 doc 的 path + watch。 */
  async function saveAsDoc(d: DocState): Promise<boolean> {
    if (d.userReadOnly || d.readOnlyLocked) return false
    const target = await saveDialog({ filters: MARKDOWN_DIALOG_FILTERS })
    if (!target) return false
    const snapshot = d.content
    try {
      await writeTextFile(target, snapshot)
      const oldDraftId = currentDraftIdFor(d)

      await stopWatch(d)
      d.currentFilePath = target
      d.lastSavedContent = snapshot

      if (oldDraftId) await deleteDraftFromFs(oldDraftId)
      await clearDraftForDoc(d)
      void syncTitle()
      // 路径变了：换被监听的文件
      await startWatchOf(d, target)
      return true
    }
    catch (e) {
      console.error('另存为失败', e)
      await message(`另存为失败:${formatError(e)}`, { title: '另存为失败', kind: 'error' })
      return false
    }
  }

  /** 多标签下的「新建文档」= 新开一个未命名标签;若已在干净空白标签上则只拉焦点(避免叠空白标签) */
  async function newDoc() {
    if (!isPristineBlank(activeDoc())) {
      const id = createTab()
      switchTab(id)
    }
    focusRequestToken.value++
  }

  // ========== 多标签原语 ==========
  //
  // Step 1:store 内 API 就绪,但 App.vue 仍走单标签路径(openPath 装载到 active doc)。
  // Step 2 起,打开入口改走 openPathInTab(已开则 switchTab / 未开则 createTab+load)。

  /** 新建一个空白标签并入集合,返回 id(不自动激活)。
   *  内容用 canonical('') 对齐 markdownIO,避免「空白标签一挂载就 dirty」
   *  (EditorInner emit 的 canonical 与 '' 基线不等)。 */
  function createTab(): string {
    const d = newBlankDoc(nextDocId())
    const canonical = toMarkdown(fromMarkdown('', pmSchema))
    d.content = canonical
    d.lastSavedContent = canonical
    documents.value.set(d.id, d)
    return d.id
  }

  /** 切到指定标签。Step 3 在此自增 tabSwitchToken,EditorInner 据此恢复缓存 state */
  function switchTab(id: string) {
    if (id === activeId.value) return
    if (!documents.value.has(id)) return
    activeId.value = id
    tabSwitchToken.value++
    void syncTitle()
  }

  /** 已有同 path 的标签则返回其 id,否则 null */
  function findTabByPath(path: string): string | null {
    for (const d of documents.value.values()) {
      if (d.currentFilePath === path) return d.id
    }
    return null
  }

  /** 关闭标签:脏盘弹确认;停该 doc watch;删该 doc 草稿;激活相邻标签。
   *  返回 false = 用户取消关闭。 */
  async function closeTab(id: string): Promise<boolean> {
    const d = documents.value.get(id)
    if (!d) return false
    if (d.content !== d.lastSavedContent) {
      const ok = await confirm(
        `「${docFileName(d)}」有未保存的修改，确定要关闭吗？`,
        { title: '未保存的修改', kind: 'warning' },
      )
      if (!ok) return false
    }
    // 关闭前记下相邻标签(关掉后激活它),Map 保插入序
    const keys = [...documents.value.keys()]
    const idx = keys.indexOf(id)
    await stopWatch(d)
    await clearDraftForDoc(d)
    documents.value.delete(id)
    if (activeId.value === id) {
      const neighbor = keys[idx - 1] ?? keys[idx + 1] ?? ''
      activeId.value = neighbor
      if (neighbor) tabSwitchToken.value++
      void syncTitle()
    }
    return true
  }

  /** 关闭路径前缀下的所有标签(删除文件 / 目录后清理)。
   *  不弹脏盘确认 —— 删除操作本身已在外层 confirm 过("删除后修改将丢失")。
   *  活动标签被关则切到剩余首个,全空则 activeId='' 走空态。 */
  async function closeTabsUnderPath(prefix: string) {
    const under = (p: string) =>
      p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '\\')
    const toClose = [...documents.value.values()].filter(d => d.currentFilePath && under(d.currentFilePath))
    if (toClose.length === 0) return
    for (const d of toClose) {
      await stopWatch(d)
      await clearDraftForDoc(d)
      documents.value.delete(d.id)
    }
    if (!documents.value.has(activeId.value)) {
      const remaining = [...documents.value.keys()]
      activeId.value = remaining[0] ?? ''
      if (remaining.length > 0) tabSwitchToken.value++
      void syncTitle()
    }
  }

  /** 重命名 / 移动后,把所有打开标签里命中 srcPath(文件)或其前缀(目录)的路径
   *  换成 newPath,**不动 content / lastSavedContent**(保留 dirty 状态)。
   *  loadContent 会重置基线 → 改名时丢失 dirty,故这里单独走「只换 path + 重启 watch」。 */
  async function renameOpenPaths(srcPath: string, newPath: string) {
    for (const d of documents.value.values()) {
      if (!d.currentFilePath) continue
      let next: string | null = null
      if (d.currentFilePath === srcPath) next = newPath
      else if (d.currentFilePath.startsWith(srcPath + '/') || d.currentFilePath.startsWith(srcPath + '\\')) {
        next = newPath + d.currentFilePath.slice(srcPath.length)
      }
      if (next) {
        await stopWatch(d)
        d.currentFilePath = next
        await startWatchOf(d, next)
      }
    }
    void syncTitle()
  }

  /** 路径前缀下打开的标签数(文件 = 自身;目录 = 其下任意层)。 */
  function countOpenTabsUnder(prefix: string): number {
    const under = (p: string) =>
      p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '\\')
    let n = 0
    for (const d of documents.value.values()) {
      if (d.currentFilePath && under(d.currentFilePath)) n++
    }
    return n
  }

  /** 路径前缀下**有未保存修改**的标签数(删除 / 移动前判定是否需强警告)。 */
  function countDirtyTabsUnder(prefix: string): number {
    const under = (p: string) =>
      p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '\\')
    let n = 0
    for (const d of documents.value.values()) {
      if (d.currentFilePath && under(d.currentFilePath) && d.content !== d.lastSavedContent) n++
    }
    return n
  }

  // ========== 每标签 EditorState 保留(Step 3)==========
  //
  // 切标签若只换 content,EditorInner 的 modelValue watch 会 view.updateState(
  // EditorState.create(...)) 重建 state,丢 undo 历史 / 滚动 / 光标。这里在 DocState
  // 上缓存 PM / CM6 的 EditorState + scrollTop,切回时由 EditorInner / SourceModeEditor
  // 恢复(而非重建)。
  //
  // EditorState 不可深响应化(Vue 代理它会触发 PM 内部 invalidate 循环),赋值用 markRaw。

  /** 编辑器每次 dispatch 后调:缓存活动标签的 PM state + 滚动位。O(1) 引用交换。 */
  function captureActivePmState(state: unknown, scrollTop: number) {
    const d = activeDoc()
    if (!d) return
    d.pmState = markRaw(state as object)
    d.scrollTop = scrollTop
  }

  /** 切标签恢复用:返回活动标签缓存的 PM state + scrollTop,仅当内容仍匹配(未被外部改)。
   *  内容不匹配 → 返回 null,EditorInner 走 EditorState.create 重建。 */
  function peekActivePmStateForRestore(): { state: unknown, scrollTop: number | undefined } | null {
    const d = activeDoc()
    if (!d || !d.pmState) return null
    try {
      const md = toMarkdown((d.pmState as { doc: unknown }).doc as Parameters<typeof toMarkdown>[0])
      if (md !== d.content) return null // stale(外部改动 / saveAs 换内容)
    }
    catch {
      return null
    }
    return { state: d.pmState, scrollTop: d.scrollTop }
  }

  /** CM6 源码模式对称缓存(用 any 避免在此处引 CM6 类型)。 */
  function captureActiveCmState(state: unknown, scrollTop: number) {
    const d = activeDoc()
    if (!d) return
    d.cmState = markRaw(state as object)
    d.scrollTop = scrollTop
  }

  function peekActiveCmStateForRestore(): { state: unknown, scrollTop: number | undefined } | null {
    const d = activeDoc()
    if (!d || !d.cmState) return null
    return { state: d.cmState, scrollTop: d.scrollTop }
  }

  // ========== 崩溃恢复草稿 ==========
  //
  // dirty 时定期把当前内容写到 appDataDir/drafts/{id}.json;启动时扫描这个目录,
  // 展示给用户让他选择恢复 / 丢弃。
  //
  // ID 策略(window scope + per-doc path):
  //   - 文件: path 的 UTF-8 字节做 base64,把 + / = 替成 _ 变成合法文件名;
  //          确定性 → 同一文件反复 dirty 时原地覆盖
  //   - 未命名:无窗口 scope 时保留旧 fixed slot;有 scope 时每个窗口一个 slot
  const UNTITLED_DRAFT_ID = 'untitled'

  function encodePathAsId(path: string): string {
    const bytes = new TextEncoder().encode(path)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/[/+=]/g, '_')
  }

  function safeDraftScope(): string | null {
    if (!draftScope.value) return null
    return draftScope.value.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  function currentDraftIdFor(d: DocState): string | null {
    const scope = safeDraftScope()
    if (!d.currentFilePath) return scope ? `win-${scope}-untitled` : UNTITLED_DRAFT_ID
    try {
      const fileId = `file-${encodePathAsId(d.currentFilePath)}`
      return scope ? `win-${scope}-${fileId}` : fileId
    }
    catch {
      return null
    }
  }

  function currentDraftId(): string | null {
    const d = activeDoc()
    return d ? currentDraftIdFor(d) : null
  }

  /** 当前 active doc dirty → 落一份草稿。App.vue 周期性调,clean 时直接 return。 */
  async function saveCurrentDraft() {
    const d = activeDoc()
    if (!d) return
    if (d.content === d.lastSavedContent) return
    const id = currentDraftIdFor(d)
    if (!id) return
    await saveDraftToFs({
      version: 1,
      id,
      originalPath: d.currentFilePath,
      content: d.content,
      savedAt: Date.now(),
    })
  }

  /** 写盘成功(手动 save / saveAs) → 对应草稿没用了,删掉。 */
  async function clearCurrentDraft() {
    const d = activeDoc()
    if (!d) return
    await clearDraftForDoc(d)
  }

  async function clearDraftForDoc(d: DocState) {
    const id = currentDraftIdFor(d)
    if (!id) return
    await deleteDraftFromFs(id)
  }

  /** App.vue 启动时调一次,扫出所有"上一会话留下的"草稿。 */
  async function loadRecoverableDrafts() {
    const all = await loadDraftsFromFs()
    // 所有已开标签的草稿 id 都不算"待恢复"(本会话已打开 / 内容跟磁盘一致)
    const openIds = new Set<string>()
    for (const d of documents.value.values()) {
      const id = currentDraftIdFor(d)
      if (id) openIds.add(id)
    }
    const recoverable = all.filter(d => !openIds.has(d.id))
    // 按时间倒序,最新的在最上面
    recoverable.sort((a, b) => b.savedAt - a.savedAt)
    pendingRecoveryDrafts.value = recoverable
  }

  /** 用户选了"恢复这条草稿" → 新开标签(或复用干净未命名)装进去。 */
  async function recoverDraft(id: string) {
    const draft = pendingRecoveryDrafts.value.find(d => d.id === id)
    if (!draft) return
    if (!isPristineBlank(activeDoc())) {
      const nid = createTab()
      switchTab(nid)
    }
    const d = activeDoc()!
    // loadContentInto 会把 currentFilePath 切到 draft 的原文件,
    // 这样 currentDraftId() 也会跟着切,下一次定时 save 会原地覆盖这条草稿
    loadContentInto(d, draft.content, draft.originalPath)

    // 把 lastSavedContent 强行偏离 content,让 dirty=true。
    // 优先用磁盘真实内容做 baseline —— 这样 Ctrl+S 时 save() 是把草稿写到磁盘
    // (正常路径),而 checkExternalChange 后续会走 confirm 分支把决定权交回用户。
    if (draft.originalPath) {
      try {
        const disk = await readTextFile(draft.originalPath)
        d.lastSavedContent = disk
      }
      catch {
        // 文件已删 / 权限 / 网络盘断 —— 用空串当 baseline,反正只要 ≠ content
        // 就能让 dirty=true,达到「阻止静默重载」的目的。
        d.lastSavedContent = ''
      }
    }
    else {
      // 未命名文档(originalPath=null),没有磁盘对照。用空串保证 dirty=true。
      d.lastSavedContent = ''
    }
    // dirty 变了 → title 上要出现 / 消失 "•",刷一次
    syncTitle()

    // 切完路径后重过滤一次弹窗:
    // 1) 用户点的这条要从列表移除(原行为)。
    // 2) 同 currentDraftId 的其他草稿也清掉(防御性):理论上 saveDraft
    //    原地覆盖,同 id 只应有一条;但如果同 id 真出现多条(比如 saveDraft
    //    在 race 下),再点恢复会用另一份历史覆盖刚恢复的内容,UX 上是 bug。
    const cur = currentDraftId()
    const exclude = new Set<string>([id])
    if (cur) exclude.add(cur)
    pendingRecoveryDrafts.value = pendingRecoveryDrafts.value.filter(d => !exclude.has(d.id))
    await deleteDraftFromFs(id)
  }

  /** 用户选了"丢弃这条草稿"。 */
  async function discardDraft(id: string) {
    pendingRecoveryDrafts.value = pendingRecoveryDrafts.value.filter(d => d.id !== id)
    await deleteDraftFromFs(id)
  }

  /** 关闭恢复弹窗(对单条 / 全部都"暂不处理")—— 草稿留在磁盘,下次启动还能选。 */
  function dismissRecoveryDialog() {
    pendingRecoveryDrafts.value = []
  }

  return {
    // 多标签核心
    documents,
    activeId,
    tabSwitchToken,
    tabs,
    content,
    currentFilePath,
    dirty,
    // 全局
    sourceMode,
    autoSaveEnabled,
    autoSaveOnBlur,
    toggleSourceMode,
    setDraftScope,
    readOnly,
    readOnlyLocked,
    virtualFileName,
    fileName,
    pendingRecoveryDrafts,
    focusRequestToken,
    // 生命周期 / IO
    init,
    setContent,
    loadContent,
    loadContentInto,
    open,
    openPath,
    openPathInTab,
    openSampleTab,
    save,
    saveDoc,
    saveAs,
    saveAsDoc,
    saveAllDirtyTabs,
    saveAllDrafts,
    newDoc,
    confirmDiscardIfDirty,
    checkExternalChange,
    // 多标签原语
    createTab,
    switchTab,
    closeTab,
    closeTabsUnderPath,
    renameOpenPaths,
    countOpenTabsUnder,
    countDirtyTabsUnder,
    // 每标签 state 保留(Step 3)
    captureActivePmState,
    peekActivePmStateForRestore,
    captureActiveCmState,
    peekActiveCmStateForRestore,
    findTabByPath,
    // 草稿
    saveCurrentDraft,
    clearCurrentDraft,
    loadRecoverableDrafts,
    recoverDraft,
    discardDraft,
    dismissRecoveryDialog,
  }
})

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { open as openDialog, save as saveDialog, confirm, message } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile, watch, type UnwatchFn } from '@tauri-apps/plugin-fs'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  saveDraft as saveDraftToFs,
  loadDrafts as loadDraftsFromFs,
  deleteDraft as deleteDraftFromFs,
  type Draft,
} from './persistence'

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
]

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

export const useDocumentStore = defineStore('document', () => {
  // 编辑器当前内容,由 store 持有;App.vue 通过 v-model 双向绑给 ProseMirrorEditor
  const content = ref('')
  // "最近一次和磁盘一致"的快照；dirty 由 content vs. 这一份比较得出
  const lastSavedContent = ref('')
  const currentFilePath = ref<string | null>(null)
  const autoSaveEnabled = ref(false)
  const autoSaveOnBlur = ref(false)

  let echosToAccept = 0

  const dirty = computed(() => content.value !== lastSavedContent.value)

  const fileName = computed(() =>
    currentFilePath.value
      ? currentFilePath.value.split(/[\\/]/).pop() ?? '未命名'
      : '未命名',
  )

  // 缓存上一次写进原生 title bar 的字符串。setContent 每次按键都调
  // syncTitle,但 dirty 状态在编辑过程中通常保持不变(只有 clean ↔ dirty
  // 切换、fileName 变化时才真变),所以绝大多数调用算出的 title 跟上次一样。
  // 拿一个 module-local 字符串比一比,相等就跳过 setTitle IPC —— 之前每个
  // 键击都触发一次跨进程调用,长会话下 IPC 通道很吵。
  let lastTitle = ''

  function syncTitle() {
    const next = `${fileName.value}${dirty.value ? ' •' : ''} - Velo Editor`
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

  // ========== 外部修改监听 ==========
  //
  // fs:watch 把"文件被改动"信号丢给 checkExternalChange；自己写的会被
  // lastSavedContent 比对过滤掉。重入保护避免一次 burst 触发多个 confirm。
  let unwatch: UnwatchFn | null = null
  let externalCheckInFlight = false

  async function stopWatch() {
    if (!unwatch) return
    try { await unwatch() }
    catch (e) { console.warn('停止文件监听失败', e) }
    unwatch = null
  }

  async function startWatchOf(path: string) {
    await stopWatch()
    try {
      // delayMs: notify-rs 把短时间内的多次事件合并成一次回调
      unwatch = await watch(
        path,
        () => { void checkExternalChange() },
        { delayMs: 100 },
      )
    }
    catch (e) {
      console.error('文件监听启动失败', e)
    }
  }

  /**
   * 主动检查当前文件在磁盘上是否被改过。
   * — fs 监听回调里调一次
   * — App.vue 在 window focus 时也调一次（fallback，覆盖 notify-rs 漏报的情况，
   *   比如网络盘、原子 rename、某些同步工具）
   */
  async function checkExternalChange() {
    const path = currentFilePath.value
    if (!path) return
    if (externalCheckInFlight) return
    externalCheckInFlight = true
    try {
      let disk: string
      try {
        disk = await readTextFile(path)
      }
      catch (e) {
        console.warn(`「${fileName.value}」无法读取，可能已被删除或重命名`, e)
        return
      }
      // 我们自己写的（save/saveAs 写完会推进 lastSavedContent）
      if (disk === lastSavedContent.value) return
      // 磁盘内容已经和编辑器里的一致（比如别人重写为同样内容）：只刷新基线
      if (disk === content.value) {
        lastSavedContent.value = disk
        return
      }
      // 真的有外部修改
      if (!dirty.value) {
        // 干净：直接重载，不打扰用户
        loadContent(disk, path)
        return
      }
      const reload = await confirm(
        `「${fileName.value}」在编辑器外被修改了。\n本地还有未保存的修改 —— 确定要丢弃本地版本并重新加载吗？`,
        { title: '文件已变化', kind: 'warning' },
      )
      if (reload) loadContent(disk, path)
    }
    finally {
      externalCheckInFlight = false
    }
  }

  /** 编辑器把当前 markdown 回写进 store —— 也是 v-model 的 update 钩子。 */
  function setContent(v: string) {
    if (echosToAccept > 0) {
      echosToAccept--
      // 把规范化后的版本采纳为新基线，dirty 因此保持 false
      lastSavedContent.value = v
    }
    content.value = v
    void syncTitle()
  }

  /** App.vue 在 setup 阶段调用一次，把初始 sample 放进去 */
  function init(initial: string) {
    content.value = initial
    lastSavedContent.value = initial
    echosToAccept = 1 // 等编辑器首次 mount 后的 echo
    void syncTitle()
  }

  /** 加载一份内容到编辑器，并把它视作磁盘基线 */
  function loadContent(c: string, path: string | null) {
    currentFilePath.value = path
    const willRecreateEditor = content.value !== c
    content.value = c
    lastSavedContent.value = c
    // 只在内容真的变了(→ ProseMirrorEditor 会重建 → 会 echo)时才等 echo
    echosToAccept = willRecreateEditor ? 1 : 0
    void syncTitle()
    // 切换文件 / 新建：重建监听
    if (path) void startWatchOf(path)
    else void stopWatch()
  }

  /** 脏盘时弹原生确认，true=用户同意放弃，可继续覆盖 */
  async function confirmDiscardIfDirty(): Promise<boolean> {
    if (!dirty.value) return true
    return await confirm(
      `「${fileName.value}」有未保存的修改，确定要放弃吗？`,
      { title: '未保存的修改', kind: 'warning' },
    )
  }

  /**
   * 打开一个文件。readTextFile 抛错(文件不存在 / 无权限 / 网络盘断)时,
   * 弹原生 message 告知用户,**不**调 loadContent —— 不污染当前编辑器状态。
   *
   * 这是 CLI 启动路径(`App.vue` 冷启动 / 二次启动 cli-args)唯一能反馈
   * "打开失败"的地方:这两处都是 `void openPath(...)` fire-and-forget,
   * 不在 store 内 catch 就会变成 unhandled rejection,用户看不到任何提示,
   * 会以为启动正常只是文件不存在。
   */
  async function openPath(path: string) {
    try {
      const c = await readTextFile(path)
      loadContent(c, path)
    }
    catch (e) {
      console.error('打开文件失败', path, e)
      await message(`无法打开 ${path}:${formatError(e)}`, { title: '打开失败', kind: 'error' })
    }
  }

  async function open() {
    if (!(await confirmDiscardIfDirty())) return
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: MD_FILTERS,
    })
    if (typeof selected === 'string') {
      await openPath(selected)
    }
  }

  /** 写盘成功返回 true；用户取消另存为 / 写盘抛错 返回 false。 */
  async function save(): Promise<boolean> {
    if (!currentFilePath.value) return saveAs()
    const path = currentFilePath.value
    const snapshot = content.value
    const previousBaseline = lastSavedContent.value
    // 写盘前就把基线推进 —— 这样 fs:watch 触发的 checkExternalChange 看到
    // disk === lastSavedContent，把我们自己的写当成"非事件"过滤掉。
    // 如果写盘抛错就回滚。
    lastSavedContent.value = snapshot
    try {
      await writeTextFile(path, snapshot)
      // 写盘成功 → 草稿没用了,清掉
      await clearCurrentDraft()
      await syncTitle()
      return true
    }
    catch (e) {
      console.error('保存失败', e)
      lastSavedContent.value = previousBaseline
      // 写盘失败必须给用户可见反馈 —— 仅 console.error 用户根本看不到。
      // 自动保存 / Ctrl+S / 关闭拦截都会走这里;任一场景下"以为保存成功"
      // 都会丢数据。弹原生 message 显式告知失败原因。
      await message(`保存失败:${formatError(e)}`, { title: '保存失败', kind: 'error' })
      return false
    }
  }

  async function saveAs(): Promise<boolean> {
    const target = await saveDialog({ filters: MD_FILTERS })
    if (!target) return false
    const snapshot = content.value
    try {
      await writeTextFile(target, snapshot)
      const oldDraftId = currentDraftId()

      await stopWatch()
      currentFilePath.value = target
      lastSavedContent.value = snapshot

      if (oldDraftId) await deleteDraftFromFs(oldDraftId)
      await clearCurrentDraft()
      await syncTitle()
      // 路径变了：换被监听的文件
      await startWatchOf(target)
      return true
    }
    catch (e) {
      console.error('另存为失败', e)
      await message(`另存为失败:${formatError(e)}`, { title: '另存为失败', kind: 'error' })
      return false
    }
  }

  async function newDoc() {
    if (!(await confirmDiscardIfDirty())) return
    loadContent('', null)
  }

  // ========== 崩溃恢复草稿 ==========
  //
  // dirty 时定期把当前内容写到 appDataDir/drafts/{id}.json;启动时扫描这个目录,
  // 展示给用户让他选择恢复 / 丢弃。
  //
  // ID 策略:
  //   - 文件: path 的 UTF-8 字节做 base64,把 + / = 替成 _ 变成合法文件名;
  //          确定性 → 同一文件反复 dirty 时原地覆盖
  //   - 未命名: 固定字符串 'untitled',单 slot,新 doc 会覆盖旧 untitled 草稿
  const UNTITLED_DRAFT_ID = 'untitled'

  function encodePathAsId(path: string): string {
    const bytes = new TextEncoder().encode(path)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary).replace(/[/+=]/g, '_')
  }

  function currentDraftId(): string | null {
    if (!currentFilePath.value) return UNTITLED_DRAFT_ID
    try {
      return `file-${encodePathAsId(currentFilePath.value)}`
    }
    catch {
      return null
    }
  }

  const pendingRecoveryDrafts = ref<Draft[]>([])

  /** 当前文档 dirty → 落一份草稿。App.vue 周期性调,clean 时直接 return。 */
  async function saveCurrentDraft() {
    if (!dirty.value) return
    const id = currentDraftId()
    if (!id) return
    await saveDraftToFs({
      version: 1,
      id,
      originalPath: currentFilePath.value,
      content: content.value,
      savedAt: Date.now(),
    })
  }

  /** 写盘成功(手动 save / saveAs) → 对应草稿没用了,删掉。 */
  async function clearCurrentDraft() {
    const id = currentDraftId()
    if (!id) return
    await deleteDraftFromFs(id)
  }

  /** App.vue 启动时调一次,扫出所有"上一会话留下的"草稿。 */
  async function loadRecoverableDrafts() {
    const all = await loadDraftsFromFs()
    const cur = currentDraftId()
    // 当前文档的草稿(本会话刚刚打开,内容跟磁盘一致)不算"待恢复"
    const recoverable = cur ? all.filter(d => d.id !== cur) : all
    // 按时间倒序,最新的在最上面
    recoverable.sort((a, b) => b.savedAt - a.savedAt)
    pendingRecoveryDrafts.value = recoverable
  }

  /** 用户选了"恢复这条草稿" → 把它装进当前编辑器(覆盖原内容)。 */
  async function recoverDraft(id: string) {
    const draft = pendingRecoveryDrafts.value.find(d => d.id === id)
    if (!draft) return
    // loadContent 会把 currentFilePath 切到 draft 的原文件,
    // 这样 currentDraftId() 也会跟着切,下一次定时 save 会原地覆盖这条草稿
    loadContent(draft.content, draft.originalPath)

    // 把 lastSavedContent 强行偏离 content,让 dirty=true。
    // 优先用磁盘真实内容做 baseline —— 这样 Ctrl+S 时 save() 是把草稿写到磁盘
    // (正常路径),而 checkExternalChange 后续会走 confirm 分支把决定权交回用户。
    if (draft.originalPath) {
      try {
        const disk = await readTextFile(draft.originalPath)
        lastSavedContent.value = disk
      }
      catch {
        // 文件已删 / 权限 / 网络盘断 —— 用空串当 baseline,反正只要 ≠ content
        // 就能让 dirty=true,达到「阻止静默重载」的目的。
        lastSavedContent.value = ''
      }
    }
    else {
      // 未命名文档(originalPath=null),没有磁盘对照。用空串保证 dirty=true。
      lastSavedContent.value = ''
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
    content,
    currentFilePath,
    dirty,
    autoSaveEnabled,
    autoSaveOnBlur,
    fileName,
    pendingRecoveryDrafts,
    init,
    setContent,
    loadContent,
    open,
    openPath,
    save,
    saveAs,
    newDoc,
    confirmDiscardIfDirty,
    checkExternalChange,
    saveCurrentDraft,
    clearCurrentDraft,
    loadRecoverableDrafts,
    recoverDraft,
    discardDraft,
    dismissRecoveryDialog,
  }
})

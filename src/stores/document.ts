import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { open as openDialog, save as saveDialog, confirm } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile, watch, type UnwatchFn } from '@tauri-apps/plugin-fs'
import { getCurrentWindow } from '@tauri-apps/api/window'

const MD_FILTERS = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'mdown'] },
]

export const useDocumentStore = defineStore('document', () => {
  // 编辑器当前内容，由 store 持有；App.vue 通过 v-model 双向绑给 MilkdownEditor
  const content = ref('')
  // "最近一次和磁盘一致"的快照；dirty 由 content vs. 这一份比较得出
  const lastSavedContent = ref('')
  const currentFilePath = ref<string | null>(null)
  const autoSaveEnabled = ref(false)
  const autoSaveOnBlur = ref(false)

  // Milkdown 收到 defaultValue 后会回吐一次"规范化"后的 markdown（行尾归一、
  // 列表标记统一等），这次回吐不算用户编辑。loadContent/init 时把它设为 1,
  // 编辑器重建后的第一次 emit 落到 setContent 被消费，并把那一次的值作为新基线。
  let echosToAccept = 0

  const dirty = computed(() => content.value !== lastSavedContent.value)

  const fileName = computed(() =>
    currentFilePath.value
      ? currentFilePath.value.split(/[\\/]/).pop() ?? '未命名'
      : '未命名',
  )

  async function syncTitle() {
    await getCurrentWindow().setTitle(
      `${fileName.value}${dirty.value ? ' •' : ''} - Velo Editor`,
    )
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
    // 只在内容真的变了（→ MilkdownEditor 会重建 → 会 echo）时才等 echo
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

  async function openPath(path: string) {
    const c = await readTextFile(path)
    loadContent(c, path)
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
      await syncTitle()
      return true
    }
    catch (e) {
      console.error('保存失败', e)
      lastSavedContent.value = previousBaseline
      return false
    }
  }

  async function saveAs(): Promise<boolean> {
    const target = await saveDialog({ filters: MD_FILTERS })
    if (!target) return false
    const snapshot = content.value
    try {
      await writeTextFile(target, snapshot)
      currentFilePath.value = target
      lastSavedContent.value = snapshot
      await syncTitle()
      // 路径变了：换被监听的文件
      await startWatchOf(target)
      return true
    }
    catch (e) {
      console.error('另存为失败', e)
      return false
    }
  }

  async function newDoc() {
    if (!(await confirmDiscardIfDirty())) return
    loadContent('', null)
  }

  return {
    content,
    currentFilePath,
    dirty,
    autoSaveEnabled,
    autoSaveOnBlur,
    fileName,
    init,
    setContent,
    open,
    openPath,
    save,
    saveAs,
    newDoc,
    confirmDiscardIfDirty,
    checkExternalChange,
  }
})

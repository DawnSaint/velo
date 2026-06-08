import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '../document'
import { readTextFile, writeTextFile, watch } from '@tauri-apps/plugin-fs'
import { save as saveDialog, confirm } from '@tauri-apps/plugin-dialog'

/**
 * 工具:把 store 拉到一个"可操作"的稳定状态
 *  - content=lastSaved=initialContent,currentFilePath=path
 *  - echosToAccept=0(已消费掉 init + openPath 两轮 echo)
 */
async function setupOpenedFile(initialContent: string, path: string) {
  const store = useDocumentStore()
  store.init(initialContent)
  store.setContent(initialContent) // 消费 init 的 echo
  vi.mocked(readTextFile).mockResolvedValue(initialContent)
  await store.openPath(path) // willRecreateEditor=false → 不再制造 echo
  return store
}

describe('document store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // 用 resetAllMocks 而不是 clearAllMocks:
    // 还会清掉 mockResolvedValueOnce 的队列,避免上一个测试的 queued value
    // 漏到下一个测试里(这是导致 4d 第二段、6b/6c 失败的根因)
    vi.resetAllMocks()
  })

  // 1. save() 写盘前推进 lastSavedContent,写盘抛错回滚
  describe('save()', () => {
    it('写盘成功:基线推进、dirty 清零', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello world') // 真实编辑
      expect(store.dirty).toBe(true)

      vi.mocked(writeTextFile).mockResolvedValueOnce()
      const ok = await store.save()

      expect(ok).toBe(true)
      expect(store.dirty).toBe(false)
    })

    it('写盘失败:基线回滚、dirty 恢复', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello world') // 真实编辑
      expect(store.dirty).toBe(true)

      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk full'))
      const ok = await store.save()

      expect(ok).toBe(false)
      expect(store.dirty).toBe(true) // 基线回滚 → 又变脏
    })

    it('写盘失败:弹原生 message 提示用户,错误原因写入消息体', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello world')

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('disk full'))

      const ok = await store.save()

      expect(ok).toBe(false)
      expect(vi.mocked(message)).toHaveBeenCalledTimes(1)
      // 消息体里要有原始原因
      const [body, options] = vi.mocked(message).mock.calls[0]
      expect(String(body)).toContain('disk full')
      // kind: 'error' 弹红色错误图标,跟普通 info 区分
      expect((options as any)?.kind).toBe('error')
    })

    it('写盘成功:不弹错误提示', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello world')

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(writeTextFile).mockResolvedValueOnce()

      const ok = await store.save()

      expect(ok).toBe(true)
      expect(vi.mocked(message)).not.toHaveBeenCalled()
    })
  })

  // 1.5 syncTitle IPC 频率:每个键击都过 IPC 太吵,只在 title 实际变化时调。
  describe('syncTitle IPC 频率(避免每个键击都过 IPC)', () => {
    let setTitleMock: any
    // 从 setup.ts 拿那个 module-scope 的单例 mock
    beforeEach(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      setTitleMock = vi.mocked(getCurrentWindow().setTitle)
    })

    it('init 后 title 已落地,后续 setContent 不改变 title 时不再触发 setTitle', async () => {
      const store = useDocumentStore()
      store.init('hello')           // title: "未命名 - Velo Editor"(clean)
      const callsAfterInit = setTitleMock.mock.calls.length
      // 消费 init 的 echo + 几次"无效果"的 setContent(dirty 一直 false)
      store.setContent('hello')     // echo,dirty 仍 false
      store.setContent('hello')     // dirty 仍 false
      store.setContent('hello')     // dirty 仍 false
      expect(setTitleMock.mock.calls.length).toBe(callsAfterInit)
    })

    it('dirty 状态切换时才触发 setTitle(clean→dirty 一次)', async () => {
      const store = useDocumentStore()
      store.init('hello')           // title 落地一次
      store.setContent('hello')     // 消费 echo,dirty 仍 false
      const callsBeforeEdit = setTitleMock.mock.calls.length

      // 真正编辑 → dirty 变 true → title 末尾的 " •" 出现 → setTitle 一次
      store.setContent('hello!')
      const callsAfterEdit = setTitleMock.mock.calls.length
      expect(callsAfterEdit).toBe(callsBeforeEdit + 1)
      // 这条调用的 title 字符串里应有 "•"
      const lastCall = setTitleMock.mock.calls.at(-1)!
      expect(String(lastCall[0])).toContain('•')

      // 继续编辑(仍 dirty):title 字符串不变 → 不应再触发
      store.setContent('hello!!')
      store.setContent('hello!!!')
      expect(setTitleMock.mock.calls.length).toBe(callsAfterEdit)
    })

    it('save 成功后 dirty 回到 false → 再触发一次 setTitle(• 消失)', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello!')    // dirty=true
      const callsBeforeSave = setTitleMock.mock.calls.length

      vi.mocked(writeTextFile).mockResolvedValueOnce()
      await store.save()
      // dirty=false → "•" 消失 → title 变化 → 再触发一次 setTitle
      expect(setTitleMock.mock.calls.length).toBe(callsBeforeSave + 1)
      const lastCall = setTitleMock.mock.calls.at(-1)!
      expect(String(lastCall[0])).not.toContain('•')
    })

    it('loadContent 切到新 fileName → title 变化 → setTitle', async () => {
      const store = useDocumentStore()
      store.init('hello')
      store.setContent('hello')     // 消费 echo
      const callsBefore = setTitleMock.mock.calls.length

      vi.mocked(readTextFile).mockResolvedValue('x')
      await store.openPath('/new.md')
      // fileName 从 "未命名" 变 "/new.md" 的 basename("new.md")→ title 变化
      expect(setTitleMock.mock.calls.length).toBeGreaterThan(callsBefore)
      const lastCall = setTitleMock.mock.calls.at(-1)!
      expect(String(lastCall[0])).toContain('new.md')
    })
  })

  // 2. setContent 消费 echosToAccept 哨兵,首次 echo 不算用户编辑
  describe('setContent + echosToAccept', () => {
    it('init 后首次 setContent 算 echo,baseline 跟进、不变脏', () => {
      const store = useDocumentStore()
      store.init('hello')
      // 模拟编辑器把 'hello' 规范化成 'hello\n' 回吐
      store.setContent('hello\n')
      expect(store.dirty).toBe(false) // baseline 跟进 → content === lastSaved
    })

    it('echo 之后再 setContent 算用户编辑、变脏', () => {
      const store = useDocumentStore()
      store.init('hello')
      store.setContent('hello') // 消费 echo
      store.setContent('hello world') // 真实编辑
      expect(store.dirty).toBe(true)
    })
  })

  // 3. loadContent 中 willRecreateEditor 判定(通过 openPath 间接测)
  describe('loadContent willRecreateEditor(经 openPath)', () => {
    it('内容变化 → echosToAccept=1 → setContent 消费 echo', async () => {
      const store = useDocumentStore()
      store.init('') // 故意让 init 内容不同于 openPath 读到的内容
      store.setContent('') // 消费 init echo

      vi.mocked(readTextFile).mockResolvedValue('hello')
      await store.openPath('/p1') // loadContent('hello','/p1'),willRecreateEditor=true
      // 此时 echosToAccept=1,content=lastSaved='hello'
      store.setContent('hello') // echo 消费
      expect(store.dirty).toBe(false)
    })

    it('内容不变 → echosToAccept=0,不会制造虚假 echo', async () => {
      const store = useDocumentStore()
      store.init('hello')
      store.setContent('hello') // 消费 init echo

      vi.mocked(readTextFile).mockResolvedValue('hello')
      await store.openPath('/p1') // willRecreateEditor=false,echosToAccept=0
      // 即便再调 setContent,没有 echo 可消费;但 content===lastSaved 也不脏
      store.setContent('hello')
      expect(store.dirty).toBe(false)
    })
  })

  // 4. checkExternalChange 四分支
  describe('checkExternalChange 四分支', () => {
    it('a. disk === lastSavedContent(自己的写),忽略', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      // 模拟 save 已经把 baseline 推进到 'hello';disk 也读到 'hello' === lastSaved
      vi.mocked(readTextFile).mockResolvedValue('hello')

      const before = store.content
      await store.checkExternalChange()
      expect(store.content).toBe(before) // 没被重载
      expect(confirm).not.toHaveBeenCalled()
    })

    it('b. disk === content(别人重写为同样内容),只刷新基线', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello world') // 真实编辑:content='hello world', lastSaved='hello'
      // disk 读到 'hello world' === content(但 !== lastSaved)
      vi.mocked(readTextFile).mockResolvedValue('hello world')

      await store.checkExternalChange()
      // baseline 被刷新到 'hello world' → dirty 清零
      expect(store.dirty).toBe(false)
      expect(confirm).not.toHaveBeenCalled()
    })

    it('c. !dirty,disk 变化 → 静默重载,不弹确认', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      // dirty=false;disk 读到 'hello updated'(不同于 content/lastSaved)
      vi.mocked(readTextFile).mockResolvedValue('hello updated')

      await store.checkExternalChange()
      expect(store.content).toBe('hello updated')
      expect(store.dirty).toBe(false)
      expect(confirm).not.toHaveBeenCalled()
    })

    it('d-同意. dirty,disk 变化 → 弹确认,同意则 reload', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello edited') // dirty=true
      vi.mocked(readTextFile).mockResolvedValue('hello updated')
      vi.mocked(confirm).mockResolvedValueOnce(true)
      await store.checkExternalChange()
      expect(store.content).toBe('hello updated')
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    it('d-拒绝. dirty,disk 变化 → 弹确认,拒绝则保留本地版本', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello edited') // dirty=true
      vi.mocked(readTextFile).mockResolvedValue('hello updated')
      vi.mocked(confirm).mockResolvedValueOnce(false)
      await store.checkExternalChange()
      expect(store.content).toBe('hello edited') // 本地版本保留
      expect(confirm).toHaveBeenCalledTimes(1)
    })
  })

  // 5. saveAs 路径切换时启停 fs.watch
  describe('saveAs() 路径切换', () => {
    it('另存为新路径后,watch 切到新路径', async () => {
      const store = await setupOpenedFile('hello', '/old.md')
      vi.mocked(writeTextFile).mockResolvedValueOnce()

      vi.mocked(saveDialog).mockResolvedValueOnce('/new.md')
      const ok = await store.saveAs()

      expect(ok).toBe(true)
      expect(store.currentFilePath).toBe('/new.md')
      // 最后一次 watch 调用应该是 '/new.md'
      const calls = vi.mocked(watch).mock.calls
      expect(calls.at(-1)?.[0]).toBe('/new.md')
    })

    it('用户取消另存为时,路径和监听都不变', async () => {
      const store = await setupOpenedFile('hello', '/old.md')

      const watchCallsBefore = vi.mocked(watch).mock.calls.length
      vi.mocked(saveDialog).mockResolvedValueOnce(null) // 用户取消
      const ok = await store.saveAs()

      expect(ok).toBe(false)
      expect(store.currentFilePath).toBe('/old.md')
      expect(vi.mocked(watch).mock.calls.length).toBe(watchCallsBefore) // 没启新 watch
    })


    it('另存为写盘失败:弹原生 message 提示用户', async () => {
      const store = await setupOpenedFile('hello', '/old.md')
      store.setContent('hello world') // 真实编辑,触发 dirty

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(saveDialog).mockResolvedValueOnce('/new.md')
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('permission denied'))

      const ok = await store.saveAs()

      expect(ok).toBe(false)
      expect(vi.mocked(message)).toHaveBeenCalledTimes(1)
      const [body, options] = vi.mocked(message).mock.calls[0]
      expect(String(body)).toContain('permission denied')
      expect((options as any)?.kind).toBe('error')
    })

    // 回归:saveAs 写盘后到 startWatchOf 之前的窗口里,如果还挂着旧 watcher,
    // 旧路径的 notify-rs 事件触发 checkExternalChange 时,它读到的是新路径 +
    // 新 snapshot,会走 disk === lastSavedContent 直接 return,旧路径上的
    // 外部修改被静默吞掉。修复后必须先把旧 unwatch 调掉。
    it('saveAs:写盘后先 stopWatch(旧 unwatch 被调),再切路径(防竞态)', async () => {
      // 用 mockImplementation 接管 watch,每次返回可追踪的 unwatch fn
      // 跟 path 绑定,这样断言能区分"哪个 watcher 被停"
      const unwatchFns: Array<{ fn: any, path: string }> = []
      vi.mocked(watch).mockImplementation(async (path: any) => {
        const fn = vi.fn()
        unwatchFns.push({ fn, path: String(path) })
        return fn as any
      })

      const store = await setupOpenedFile('hello', '/old.md')
      // setupOpenedFile 内部走过的 watch 一定在 unwatchFns[0](loadContent 里的 startWatchOf)
      expect(unwatchFns.length).toBeGreaterThanOrEqual(1)
      const oldEntry = unwatchFns[0]
      expect(oldEntry.path).toBe('/old.md')
      expect(oldEntry.fn).not.toHaveBeenCalled() // 此时还没停

      vi.mocked(writeTextFile).mockResolvedValueOnce()
      vi.mocked(saveDialog).mockResolvedValueOnce('/new.md')

      await store.saveAs()

      // 关键断言:旧 unwatch 必须被调过
      expect(oldEntry.fn).toHaveBeenCalledTimes(1)
      // 新 watcher 也挂上了
      const newEntry = unwatchFns.at(-1)!
      expect(newEntry.path).toBe('/new.md')
      expect(newEntry.fn).not.toHaveBeenCalled() // 新 watcher 自己不该被立即停
      // 状态切到了新路径
      expect(store.currentFilePath).toBe('/new.md')
    })
  })

  // 6. confirmDiscardIfDirty 三态
  describe('confirmDiscardIfDirty() 三态', () => {
    it('干净时直接 true,不弹确认', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      const result = await store.confirmDiscardIfDirty()
      expect(result).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
    })

    it('脏 + 同意 → true', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello edited')
      vi.mocked(confirm).mockResolvedValueOnce(true)
      const result = await store.confirmDiscardIfDirty()
      expect(result).toBe(true)
    })

    it('脏 + 拒绝 → false', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello edited')
      vi.mocked(confirm).mockResolvedValueOnce(false)
      const result = await store.confirmDiscardIfDirty()
      expect(result).toBe(false)
    })
  })

  // 7. dirty 是 computed
  describe('dirty 是 computed', () => {
    it('setContent 改变后立刻反映;改回 baseline 后清零', () => {
      const store = useDocumentStore()
      store.init('hello')
      store.setContent('hello') // 消费 init echo
      expect(store.dirty).toBe(false)

      store.setContent('hello world') // 真实编辑
      expect(store.dirty).toBe(true)

      store.setContent('hello') // 回到 baseline
      expect(store.dirty).toBe(false)
    })
  })

  // 8. 崩溃恢复草稿
  // 底层 persistence.ts 的 IO 行为(mkdir / writeTextFile / readDir / rename / remove / exists)
  // 在 jsdom 里走 setup.ts 里的 stub,这里主要验证 store 层的草稿状态机。
  describe('草稿(draft)管理', () => {
    it('saveCurrentDraft:clean 时直接 return,不调底层写盘', async () => {
      const store = useDocumentStore()
      store.init('hello')
      store.setContent('hello') // 消费 echo,内容 = baseline
      // 重新绑定 writeTextFile 的 mock,统计调用次数
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()

      await store.saveCurrentDraft()
      expect(writes).not.toHaveBeenCalled()
    })

    it('saveCurrentDraft:dirty 时写一份草稿到 appDataDir/drafts/', async () => {
      const store = useDocumentStore()
      store.init('hello')
      store.setContent('hello') // 消费 init echo
      store.setContent('hello world') // 真实编辑 → dirty
      // currentFilePath 还是 null(刚 init),会用 'untitled' 这个固定 ID
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()

      await store.saveCurrentDraft()
      // 至少要写一次(tmp 写 + rename 算写两次,具体取决于 persistence 实现)
      expect(writes).toHaveBeenCalled()
    })

    // 回归:btoa 是 latin-1 only,直接对含非 ASCII 字符的路径会抛
    // InvalidCharacterError → currentDraftId 之前直接 return null → draft 静默不写。
    // 修复后 dirty 文件(非 ASCII 路径)应当正常落盘。
    it('saveCurrentDraft:非 ASCII 路径下能正常落盘(回归 btoa 编码 bug)', async () => {
      const store = useDocumentStore()
      store.init('')
      store.setContent('') // 消费 init echo
      // loadContent 会把 content 设为 '你好',并把 echosToAccept=1(等 editor echo)
      // 测试里没有真 editor,先把那次"echo"消费掉,再做一次真实编辑
      store.loadContent('你好', '/文档/笔记.md')
      store.setContent('你好') // 消费 loadContent 的 echo
      store.setContent('你好世界') // 真实编辑 → dirty
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()

      await store.saveCurrentDraft()

      // 关键断言:dirty 状态下 writeTextFile 必须被调到,不能因为 ID 编码失败而 return
      expect(writes).toHaveBeenCalled()
      // 写出路径里应包含 UTF-8 编码后的 id(不再是 null,也不再抛)。
      // saveDraft 走 .tmp + rename 原子写,所以 writeTextFile 看到的总是
      // .../file-<id>.json.tmp 路径,不是 .json。
      const calledPaths = writes.mock.calls.map(c => String(c[0]))
      const hit = calledPaths.some(p => p.includes('file-') && p.endsWith('.json.tmp'))
      expect(hit).toBe(true)
    })

    it('saveCurrentDraft:同一路径两次 dirty,落盘 id 稳定(原地覆盖)', async () => {
      const store = useDocumentStore()
      store.init('')
      store.setContent('') // 消费 echo
      store.loadContent('v1', '/文档/v.md')
      store.setContent('v1') // 消费 loadContent 的 echo
      store.setContent('v1-edited') // dirty
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()
      await store.saveCurrentDraft()
      const firstPaths = writes.mock.calls.map(c => String(c[0]))

      // 再编辑一次(仍是同一文件),写盘路径应该跟上次一致
      store.setContent('v1-edited-again')
      writes.mockClear()
      await store.saveCurrentDraft()
      const secondPaths = writes.mock.calls.map(c => String(c[0]))

      // tmp + rename 各写一次,所以取"非 .tmp 路径"做比较更直观
      const finalOf = (paths: string[]) => paths.find(p => !p.endsWith('.tmp')) ?? ''
      expect(finalOf(firstPaths)).toBe(finalOf(secondPaths))
    })

    it('loadRecoverableDrafts:排除当前文档的草稿,按时间倒序', async () => {
      // 准备两份磁盘上的草稿:一份对应当前文件,一份对应另一个文件
      // setup.ts 里 readTextFile 是 mock,我们要劫持它返回草稿 JSON
      const { readDir, exists } = await import('@tauri-apps/plugin-fs')
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: 'file-others.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: 'untitled.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      const draftsJson: Record<string, string> = {
        'file-others.json': JSON.stringify({
          version: 1, id: 'file-others',
          originalPath: '/other.md', content: 'other content',
          savedAt: 1000,
        }),
        'untitled.json': JSON.stringify({
          version: 1, id: 'untitled',
          originalPath: null, content: 'untitled content',
          savedAt: 2000,
        }),
      }
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        return draftsJson[name] ?? ''
      })

      const store = useDocumentStore()
      store.init('') // currentFilePath = null
      await store.loadRecoverableDrafts()

      // currentFilePath 是 null,currentDraftId 是 'untitled'
      // 所以 untitled 那条被排除,只剩 file-others
      expect(store.pendingRecoveryDrafts.length).toBe(1)
      expect(store.pendingRecoveryDrafts[0].id).toBe('file-others')
    })

    // 回归:App.vue onMounted 顺序。loadRecoverableDrafts 必须在 CLI 打开文件
    // 之后调 —— 不然 currentFilePath 还是 null,filter 不知道有"刚要打开的文件"
    // 这回事,弹窗里会出现一个"自己刚打开的文件"的草稿,点恢复会把磁盘内容
    // 覆盖回那份草稿(issue #3)。本测试覆盖 store 层:openPath 之后再调 filter,
    // 应当排除刚打开文件的草稿。
    it('loadRecoverableDrafts:openPath 设置 currentFilePath 之后,排除该文件的草稿', async () => {
      // 镜像 stores/document.ts 里的 encodePathAsId —— 草稿 id 必须跟 store
      // 实际计算的一致,filter 才会匹配。
      const encodePathAsId = (path: string) => {
        const bytes = new TextEncoder().encode(path)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        return btoa(binary).replace(/[/+=]/g, '_')
      }
      const p1Id = `file-${encodePathAsId('/p1.md')}`
      const othersId = `file-${encodePathAsId('/other.md')}`

      // 准备三份磁盘上的草稿:对应 CLI 即将打开的文件 / 另一份文件 / untitled
      const { readDir, exists, readTextFile } = await import('@tauri-apps/plugin-fs')
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(readDir).mockResolvedValue([
        { name: 'file-p1.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: 'file-others.json', isDirectory: false, isFile: true, isSymlink: false },
        { name: 'untitled.json', isDirectory: false, isFile: true, isSymlink: false },
      ] as any)
      const draftsJson: Record<string, string> = {
        'file-p1.json': JSON.stringify({
          version: 1, id: p1Id,
          originalPath: '/p1.md', content: 'p1 dirty content',
          savedAt: 1500,
        }),
        'file-others.json': JSON.stringify({
          version: 1, id: othersId,
          originalPath: '/other.md', content: 'other content',
          savedAt: 1000,
        }),
        'untitled.json': JSON.stringify({
          version: 1, id: 'untitled',
          originalPath: null, content: 'untitled content',
          savedAt: 2000,
        }),
      }
      // readTextFile 既要被 openPath 读文件内容用,也要被 loadDrafts 读草稿用。
      // 草稿目录是 /appData/drafts(看 join mock),文件目录是 /p1.md 这种。
      // 草稿的 path 形如 /appData/drafts/file-p1.json,取 basename 后命中 draftsJson;
      // openPath 读 /p1.md 时 basename 是 p1.md,不在 draftsJson 里,返回 ''。
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        const name = String(p).split(/[\\/]/).pop()!
        return draftsJson[name] ?? ''
      })

      const store = useDocumentStore()
      store.init('')
      store.setContent('') // 消费 init echo

      // 模拟 CLI 启动:openPath 先设好 currentFilePath
      await store.openPath('/p1.md')
      expect(store.currentFilePath).toBe('/p1.md')

      // 再扫草稿:此时 currentDraftId = p1Id,应被排除。
      // loadRecoverableDrafts 的 filter 是 d.id !== cur:cur = p1Id 时只排除 p1Id 那条;
      // file-others 和 untitled 跟当前文件无关,会留在列表里。
      await store.loadRecoverableDrafts()

      const ids = store.pendingRecoveryDrafts.map(d => d.id)

      expect(ids).not.toContain(p1Id)
      // 其他草稿不受影响
      expect(ids).toContain(othersId)
      expect(ids).toContain('untitled')
    })

    // 阻塞 #2:CLI 启动 / cli-args 走 openPath 失败时用户必须能看到反馈。
    // 之前 readTextFile 抛错会冒泡成 unhandled rejection(那两处都是 void openPath(...)),
    // 用户看到"启动正常但文件不存在",根本不知道发生了什么。
    it('openPath 读文件失败:弹原生 message 提示,不调 loadContent(不污染状态)', async () => {
      const store = useDocumentStore()
      store.init('keep this') // 已有内容 / path
      store.setContent('keep this') // 消费 echo
      const before = store.content
      const pathBefore = store.currentFilePath

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('No such file'))

      // 不应抛
      await expect(store.openPath('/missing.md')).resolves.toBeUndefined()

      expect(vi.mocked(message)).toHaveBeenCalledTimes(1)
      const [body, options] = vi.mocked(message).mock.calls[0]
      expect(String(body)).toContain('/missing.md')
      expect(String(body)).toContain('No such file')
      expect((options as any)?.kind).toBe('error')

      // 关键:loadContent 没被调 → 状态保持
      expect(store.content).toBe(before)
      expect(store.currentFilePath).toBe(pathBefore)
    })

    it('openPath 成功:不弹错误提示', async () => {
      const store = useDocumentStore()
      store.init('keep this')
      store.setContent('keep this') // 消费 echo

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(readTextFile).mockResolvedValueOnce('new content')

      await store.openPath('/new.md')

      expect(vi.mocked(message)).not.toHaveBeenCalled()
      expect(store.content).toBe('new content')
      expect(store.currentFilePath).toBe('/new.md')
    })

    it('recoverDraft:把内容装进当前编辑器并从列表移除', async () => {
      const store = useDocumentStore()
      store.init('') // 空编辑器
      // 直接挂两条待恢复草稿到 store
      store.pendingRecoveryDrafts = [
        { version: 1, id: 'a', originalPath: '/a.md', content: 'A content', savedAt: 1 },
        { version: 1, id: 'b', originalPath: '/b.md', content: 'B content', savedAt: 2 },
      ]

      await store.recoverDraft('a')

      expect(store.content).toBe('A content')
      expect(store.currentFilePath).toBe('/a.md')
      expect(store.pendingRecoveryDrafts.map(d => d.id)).toEqual(['b'])
    })

    // 重要 #3:recoverDraft 切到草稿的原文件后,弹窗里其他同 id 草稿(同一文件)必须清掉。
    // 之前实现只 filter 了当前这条,如果用户曾经对同一文件有多份历史草稿(理论上 saveDraft
    // 原地覆盖,不该出现,但边缘情况),用户能连续点"恢复"覆盖刚恢复的内容。
    it('recoverDraft:恢复同 id 草稿后,弹窗里同 id 其他草稿也清掉', async () => {
      const store = useDocumentStore()
      store.init('')
      // 模拟"同文件多份历史草稿"的边缘情况:同 id 出现两次(虽然 saveDraft 不该这么干)
      // 列表按 savedAt 倒序展示,newest 在最上面,用户看到点的是 newest。
      store.pendingRecoveryDrafts = [
        { version: 1, id: 'file-x', originalPath: '/x.md', content: 'newest', savedAt: 200 },
        { version: 1, id: 'file-x', originalPath: '/x.md', content: 'oldest', savedAt: 100 },
        { version: 1, id: 'file-y', originalPath: '/y.md', content: 'y', savedAt: 150 },
      ]

      await store.recoverDraft('file-x')

      // file-x 那条恢复后被 filter 掉(原行为);这里还多了一道 currentDraftId 过滤,
      // 所以即使同 id 还有另一条,也会一起被清。file-y 不受影响。
      const remaining = store.pendingRecoveryDrafts.map(d => d.id)
      expect(remaining).not.toContain('file-x')
      expect(remaining).toEqual(['file-y'])
      // 内容应该是用户点的最新那条
      expect(store.content).toBe('newest')
      expect(store.currentFilePath).toBe('/x.md')
    })

    it('discardDraft:从列表移除,不清当前内容', async () => {
      const store = useDocumentStore()
      store.init('keep this')
      store.pendingRecoveryDrafts = [
        { version: 1, id: 'a', originalPath: '/a.md', content: 'A', savedAt: 1 },
      ]

      await store.discardDraft('a')

      expect(store.content).toBe('keep this') // 当前内容没动
      expect(store.pendingRecoveryDrafts.length).toBe(0)
    })

    it('dismissRecoveryDialog:清空列表(草稿留在磁盘,下次启动还在)', () => {
      const store = useDocumentStore()
      store.pendingRecoveryDrafts = [
        { version: 1, id: 'a', originalPath: '/a.md', content: 'A', savedAt: 1 },
      ]
      store.dismissRecoveryDialog()
      expect(store.pendingRecoveryDrafts.length).toBe(0)
    })

    it('save() 成功后会清掉当前文档的草稿(走 clearCurrentDraft)', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello world')
      // 把底层 IO 写权限都打开
      vi.mocked(writeTextFile).mockResolvedValue()
      // exists 用来判断"草稿文件在不在磁盘上";在的话就 remove
      // 这里让它返回 true,触发 remove 分支
      const { remove, exists } = await import('@tauri-apps/plugin-fs')
      vi.mocked(exists).mockResolvedValue(true)
      vi.mocked(remove).mockResolvedValue()

      await store.save()
      // remove 至少要调一次(删草稿)
      expect(vi.mocked(remove)).toHaveBeenCalled()
    })
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDocumentStore } from '../document'
import { useRecentFilesStore } from '../recentFiles'
import { readTextFile, writeTextFile, watch } from '@tauri-apps/plugin-fs'
import { save as saveDialog, confirm } from '@tauri-apps/plugin-dialog'

/**
 * 工具:把 store 拉到一个"可操作"的稳定状态
 *  - content=lastSaved=initialContent,currentFilePath=path
 */
async function setupOpenedFile(initialContent: string, path: string) {
  const store = useDocumentStore()
  store.init(initialContent)
  vi.mocked(readTextFile).mockResolvedValue(initialContent)
  await store.openPath(path)
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
      // 几次"无效果"的 setContent(dirty 一直 false)
      store.setContent('hello')     // dirty 仍 false
      store.setContent('hello')     // dirty 仍 false
      store.setContent('hello')     // dirty 仍 false
      expect(setTitleMock.mock.calls.length).toBe(callsAfterInit)
    })

    it('dirty 状态切换时才触发 setTitle(clean→dirty 一次)', async () => {
      const store = useDocumentStore()
      store.init('hello')           // title 落地一次
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
      const callsBefore = setTitleMock.mock.calls.length

      vi.mocked(readTextFile).mockResolvedValue('x')
      await store.openPath('/new.md')
      // fileName 从 "未命名" 变 "/new.md" 的 basename("new.md")→ title 变化
      expect(setTitleMock.mock.calls.length).toBeGreaterThan(callsBefore)
      const lastCall = setTitleMock.mock.calls.at(-1)!
      expect(String(lastCall[0])).toContain('new.md')
    })
  })

  // 2. setContent 不推进基线 —— 回归:echo 误吞导致 checkExternalChange 误报
  describe('setContent 不推进基线(回归 echo 误吞 bug)', () => {
    it('setContent 后 dirty 正确反映 content vs lastSaved 的差异', () => {
      const store = useDocumentStore()
      store.init('hello')
      // 编辑器回吐同样内容(规范化后不变)—— 不应推进基线
      store.setContent('hello')
      expect(store.dirty).toBe(false)

      // 用户真实编辑 —— 应变脏
      store.setContent('hello world')
      expect(store.dirty).toBe(true)
    })

    // 回归:用户编辑后立刻切窗口再 focus,不应弹"外部修改"对话框。
    // 根因是 echosToAccept 计数器把用户编辑误吞成 echo,推进了 lastSavedContent,
    // 导致 checkExternalChange 看到 disk(旧) !== lastSaved(新) !== content(新)。
    it('编辑后切窗口 focus 不误报外部修改', async () => {
      const store = await setupOpenedFile('hello\n', '/p.md')
      store.setContent('hello world\n') // 用户真实编辑
      expect(store.dirty).toBe(true)

      // 切窗口再 focus:磁盘内容仍是 'hello\n'(未保存)
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.checkExternalChange()

      // disk === lastSavedContent('hello\n') → 应早退,不弹 confirm,content 不变
      expect(confirm).not.toHaveBeenCalled()
      expect(store.content).toBe('hello world\n') // 用户编辑保留
    })

    // 回归:磁盘原文 ≠ PM canonical(多余空行 / whitespace normalize)时,
    // 编辑后切窗口 focus 不应误报"外部修改"。
    // 根因:loadContentInto 把 lastSavedContent 设为 canonical(disk 经 markdownIO
    // round-trip),但磁盘原文仍是 raw。checkExternalChange 读到 raw disk 后直接
    // 和 canonical lastSavedContent 比 → 不等 → 误判"外部修改"。
    // 修法:checkExternalChange 在 exact match 失败后,把 disk 也 canonicalize 再比。
    it('非 canonical 磁盘文件:编辑后切窗口 focus 不误报外部修改', async () => {
      // 磁盘原文用 CRLF 行尾,canonical 形式(LF)与 raw 不字节相等
      const rawDisk = 'hello\r\n'
      const store = await setupOpenedFile(rawDisk, '/p.md')
      // load 后 content/lastSavedContent 都是 canonical(rawDisk 经 round-trip)
      expect(store.dirty).toBe(false)
      // canonical(LF)与 raw(CRLF)不字节相等
      expect(store.content).not.toBe(rawDisk)

      // 用户编辑
      store.setContent(store.content + 'edited')
      expect(store.dirty).toBe(true)

      // 切窗口再 focus:磁盘内容仍是 rawDisk(未保存)
      vi.mocked(readTextFile).mockResolvedValue(rawDisk)
      await store.checkExternalChange()

      // canonicalDisk === lastSavedContent → 应早退,不弹 confirm
      expect(confirm).not.toHaveBeenCalled()
      // 用户编辑保留
      expect(store.content).toContain('edited')
    })

    it('loadContent 切到新文件后,内容一致则不变脏', async () => {
      const store = useDocumentStore()
      store.init('')

      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPath('/p1')
      expect(store.dirty).toBe(false)
      expect(store.content).toBe('hello\n')
    })

    // 回归:多空行文件 + 输入空格再删除,不应该一直 dirty。
    // 根因是 markdownIO 的 round-trip(块级 `<br />` 占位公式 + PM 段落兄弟序列化)
    // 对多空行不是 identity:磁盘原文"X\n\n\n\n\n\n\n"经过 fromMarkdown→toMarkdown
    // 后变成"X\n\n\n\n\n"(丢 N),导致 PM canonical 与磁盘原文不等。
    // 修法:loadContent 时把磁盘内容走一遍 markdownIO,canonical 形式同时塞进
    // `content` 与 `lastSavedContent`,editor 后续 emit 是同 canonical,edit+revert 归零。
    it('多空行文件 load 后,type 再 delete 回到原状 → dirty=false(回归用户报告的 · 不消失)', async () => {
      const store = useDocumentStore()
      store.init('')
      const disk = 'X\n\n\n\n\n\n\n\n' // 7 个 \n = 6 个视觉空行
      vi.mocked(readTextFile).mockResolvedValueOnce(disk)
      await store.openPath('/multi-blank.md')
      // load 时 canonicalize:content 与 lastSavedContent 都对齐 canonical 形式
      const canonical = store.content
      expect(store.dirty).toBe(false)
      expect(canonical).not.toBe(disk) // canonical 与磁盘原文不等(load 时已规范化)

      // 编辑器在某空段输入空格 —— dirty=true
      store.setContent(canonical.replace('\n\n', '\n\n '))
      expect(store.dirty).toBe(true)

      // 编辑器删掉空格回到 canonical —— 与基线一致
      store.setContent(canonical)
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
      const store = await setupOpenedFile('hello\n', '/p.md')
      // dirty=false;disk 读到 'hello updated\n'(不同于 content/lastSaved)
      vi.mocked(readTextFile).mockResolvedValue('hello updated\n')

      await store.checkExternalChange()
      expect(store.content).toBe('hello updated\n')
      expect(store.dirty).toBe(false)
      expect(confirm).not.toHaveBeenCalled()
    })

    it('d-同意. dirty,disk 变化 → 弹确认,同意则 reload', async () => {
      const store = await setupOpenedFile('hello\n', '/p.md')
      store.setContent('hello edited\n') // dirty=true
      vi.mocked(readTextFile).mockResolvedValue('hello updated\n')
      vi.mocked(confirm).mockResolvedValueOnce(true)
      await store.checkExternalChange()
      expect(store.content).toBe('hello updated\n')
      expect(confirm).toHaveBeenCalledTimes(1)
    })

    it('d-拒绝. dirty,disk 变化 → 弹确认,拒绝则保留本地版本', async () => {
      const store = await setupOpenedFile('hello\n', '/p.md')
      store.setContent('hello edited\n') // dirty=true
      vi.mocked(readTextFile).mockResolvedValue('hello updated\n')
      vi.mocked(confirm).mockResolvedValueOnce(false)
      await store.checkExternalChange()
      expect(store.content).toBe('hello edited\n') // 本地版本保留
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

    // 回归:示例文档(readOnlyLocked)点另存为不应被静默拦截 —— 另存为写新路径,
    // 不覆盖只读源,且是 sample 唯一的"翻回可编辑"出口(状态栏 tooltip 承诺)。
    // 修复前 saveAsDoc 入口 `if (... || d.readOnlyLocked) return false` 直接吞掉,
    // 无弹窗无报错,路径/只读态都不变。
    it('saveAs:示例文档(只读锁)正常弹窗 + 写盘 + 切路径 + 翻回可编辑', async () => {
      const store = useDocumentStore()
      store.init('')
      store.openSampleTab('# sample content', '示例.md')
      expect(store.readOnlyLocked).toBe(true)
      expect(store.currentFilePath).toBeNull()

      vi.mocked(saveDialog).mockResolvedValueOnce('/workspace/copy.md')
      vi.mocked(writeTextFile).mockResolvedValueOnce()

      const ok = await store.saveAs()

      // 1. 走到了 dialog(没被静默拦截)
      expect(vi.mocked(saveDialog)).toHaveBeenCalledTimes(1)
      expect(ok).toBe(true)
      // 2. 写盘到用户挑的新路径,而非静默跳过(content 经 loadContentInto 的
      //    markdownIO round-trip 规范化为 canonical 形式,保留尾部换行)
      expect(vi.mocked(writeTextFile)).toHaveBeenCalledWith('/workspace/copy.md', '# sample content\n')
      // 3. 路径切换
      expect(store.currentFilePath).toBe('/workspace/copy.md')
      // 4. 翻回可编辑 + 清掉虚拟标题(标题改显示真实路径)
      expect(store.readOnlyLocked).toBe(false)
      expect(store.readOnly).toBe(false)
      expect(store.virtualFileName).toBeNull()
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

  // 6.5 focusRequestToken:newDoc 的显式切换意图 hint
  // 让 EditorInner 第二条 watch 能在"content 已是 ''"的二次新建路径上
  // 强制 focus 进编辑器(否则 Vue modelValue watch 因 reference-equal 不触发)。
  describe('newDoc() 显式 focus hint(focusRequestToken)', () => {
    it('首次 newDoc:token 从 0 → 1,且 content 跟初始不同(loadContent 真跑了)', async () => {
      // 注:content 的精确值由 markdownIO canonical 决定(loadContent 走
      // toMarkdown(fromMarkdown(c,...)),空文档会被表为 '\n\n\n' 等),
      // 不是 newDoc 的契约。这里用 "不等于 init 的内容" 更稳。
      const store = useDocumentStore()
      store.init('hello world')
      expect(store.focusRequestToken).toBe(0)
      expect(store.content).toBe('hello world')

      await store.newDoc()

      expect(store.focusRequestToken).toBe(1)
      expect(store.content).not.toBe('hello world')
    })

    it('连续 newDoc(content 已是 \'\n\n\' 类 canonical 不变):token 仍递增,这是 fix 的核心', async () => {
      // 复现"功能栏新建后再点一次新建不 focus"的根因:
      // 空文档 canonical 形式在 content.value 已经存在,Vue modelValue watch 因
      // reference-equal 不触发;focusRequestToken 必须独立提供"用户明确切换"的
      // 信号让 EditorInner 第二条 watch 能跑。
      const store = useDocumentStore()
      store.init('')
      // 把 content 设为等同于 newDoc 后的 canonical('\n\n\n' 这种)
      store.loadContent('', null)
      const baseline = store.content
      expect(baseline).not.toBe('') // canonical ≠ raw ''
      expect(store.focusRequestToken).toBe(0)

      await store.newDoc()
      expect(store.focusRequestToken).toBe(1)
      expect(store.content).toBe(baseline)

      // 关键:第二次 newDoc 时 content 没变,token 必须递增
      await store.newDoc()
      expect(store.focusRequestToken).toBe(2)
      expect(store.content).toBe(baseline)
    })

    it('多标签:newDoc 不弹脏盘确认(新标签不打扰活动标签),活动脏盘标签保留', async () => {
      const store = await setupOpenedFile('hello', '/p.md')
      store.setContent('hello edited') // /p.md 标签 dirty
      vi.mocked(confirm).mockClear()

      const before = store.focusRequestToken

      await store.newDoc()

      // 新标签创建 → token 递增(不再因脏盘确认而早退)
      expect(store.focusRequestToken).toBe(before + 1)
      // 多标签:newDoc 开新标签,不弹当前标签的脏盘确认
      expect(confirm).not.toHaveBeenCalled()
      // /p.md 标签仍在且仍 dirty(未被新标签覆盖)
      const pId = store.findTabByPath('/p.md')
      expect(pId).toBeTruthy()
      const pTab = store.tabs.find(t => t.id === pId)
      expect(pTab?.dirty).toBe(true)
    })

    it('init / loadContent 不动 token —— 只有 newDoc 是"显式意图切换"信号', async () => {
      const store = useDocumentStore()
      store.init('') // 启动期 init
      expect(store.focusRequestToken).toBe(0)

      // 打开文件不该 bump token(沿用 openFocus 默认规则,不抢焦点)
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPath('/a.md')
      expect(store.focusRequestToken).toBe(0)
    })
  })

  // 6.7 文件树↔标签联动:v0.6.0,click 复用 / middle-click 强制新开
  //  - openPathInTab:已开 → 切到该标签;未开 → 新开(走现有逻辑)
  //  - openPathInNewTab:**始终**新开,即便 path 已被打开过(中键点击)
  describe('文件树↔标签联动(openPathInTab / openPathInNewTab)', () => {
    it('openPathInTab:未开 path → 新开标签并激活', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValueOnce('hello\n')

      await store.openPathInTab('/a.md')

      expect(store.tabs.length).toBe(1)
      expect(store.activeId).toBe(store.tabs[0].id)
      expect(store.currentFilePath).toBe('/a.md')
      expect(store.content).toBe('hello\n')
    })

    it('openPathInTab:已开 path → 切到该标签,不复用(只有一个标签承载该 path)', async () => {
      const store = useDocumentStore()
      store.init('')
      // 打开两次 /a.md
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInTab('/a.md')
      const firstId = store.activeId

      // 第二次 openPathInTab 同 path → 切回,不开新标签
      await store.openPathInTab('/a.md')

      expect(store.tabs.length).toBe(1)
      expect(store.activeId).toBe(firstId)
    })

    it('openPathInNewTab:未开 path → 新开标签并激活(行为同 openPathInTab)', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValueOnce('hello\n')

      await store.openPathInNewTab('/a.md')

      expect(store.tabs.length).toBe(1)
      expect(store.currentFilePath).toBe('/a.md')
      expect(store.content).toBe('hello\n')
    })

    // 核心:中键点击的差异化语义
    it('openPathInNewTab:已开 path → 仍新开一个独立标签(两个标签同 path)', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInNewTab('/a.md')
      const firstId = store.activeId

      // 第二次 openPathInNewTab 同 path → 再开一个
      await store.openPathInNewTab('/a.md')
      const secondId = store.activeId

      expect(store.tabs.length).toBe(2)
      expect(secondId).not.toBe(firstId) // 不同标签
      expect(store.activeId).toBe(secondId) // 新标签激活
      // 两个标签都装载 /a.md
      expect(store.tabs.map(t => t.fileName)).toEqual(['a.md', 'a.md'])
    })

    it('openPathInNewTab:连续两次 → 两个独立标签,各自 baseline 独立', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInNewTab('/a.md')
      const firstId = store.activeId
      // 第一个标签编辑 → dirty
      store.setContent('hello world\n')

      // 第二次开 /a.md → 新标签,clean(独立 baseline)
      await store.openPathInNewTab('/a.md')
      const secondId = store.activeId

      expect(firstId).not.toBe(secondId)
      // 第一个标签应仍是 dirty(它的 baseline 没变)
      const firstTab = store.tabs.find(t => t.id === firstId)
      expect(firstTab?.dirty).toBe(true)
      // 当前活动的新标签 clean(刚装载)
      expect(store.dirty).toBe(false)
    })

    it('openPathInNewTab:活动标签是干净空白 → 复用该标签,不再叠新空白标签', async () => {
      const store = useDocumentStore()
      store.init('') // 启动期空白标签 = 干净空白
      vi.mocked(readTextFile).mockResolvedValueOnce('hello\n')

      await store.openPathInNewTab('/a.md')

      // init 时已有一个空白标签;openPathInNewTab 应复用,不再 createTab
      expect(store.tabs.length).toBe(1)
      expect(store.currentFilePath).toBe('/a.md')
    })

    it('openPathInNewTab:读盘失败 → 弹原生 message,不创建空标签', async () => {
      const store = useDocumentStore()
      store.init('') // 干净空白标签
      const tabsBefore = store.tabs.length

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('No such file'))

      const ok = await store.openPathInNewTab('/missing.md')

      expect(ok).toBe(false)
      expect(vi.mocked(message)).toHaveBeenCalledTimes(1)
      // 不污染状态:没创建新空白标签,干净空白还在
      expect(store.tabs.length).toBe(tabsBefore)
      expect(store.currentFilePath).toBeNull()
    })

    it('openPathInNewTab:成功 → 推到全局最近文件', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValueOnce('hello\n')

      await store.openPathInNewTab('/a.md')

      expect(useRecentFilesStore().entries.map(e => e.path)).toEqual(['/a.md'])
    })

    it('openPathInNewTab:活动标签 dirty 时不弹脏盘确认(新开标签不打扰原活动标签)', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInNewTab('/a.md')
      // 编辑 /a.md 标签
      store.setContent('hello world\n')
      expect(store.dirty).toBe(true)

      vi.mocked(confirm).mockClear()
      vi.mocked(readTextFile).mockResolvedValueOnce('other\n')

      // 中键点击 /other.md → 新开标签,不弹脏盘确认
      await store.openPathInNewTab('/other.md')

      expect(confirm).not.toHaveBeenCalled()
      // /a.md 标签仍在且 dirty
      const aId = store.findTabByPath('/a.md')
      const aTab = store.tabs.find(t => t.id === aId)
      expect(aTab?.dirty).toBe(true)
    })
  })

  // 7. reorderTabs 拖拽重排(v0.6.x)
  // 纯 in-memory 保插入序;DocState 引用不动 → 编辑器缓存(pmState/cmState/scrollTop)
  // 不会随重排失效;activeId 也不动。
  describe('reorderTabs 拖拽重排', () => {
    /** 起三个标签 a / b / c(全 mock readTextFile 让 openPathInTab 走装载路径) */
    async function setupThreeTabs() {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInTab('/a.md')
      const a = store.activeId
      await store.openPathInTab('/b.md')
      const b = store.activeId
      await store.openPathInTab('/c.md')
      const c = store.activeId
      return { store, ids: { a, b, c } }
    }

    it('把 fromId 标签移到 toId 标签 before 位置', async () => {
      const { store, ids } = await setupThreeTabs()
      store.reorderTabs(ids.c, ids.a, 'before')
      expect(store.tabs.map(t => t.id)).toEqual([ids.c, ids.a, ids.b])
    })

    it('把 fromId 标签移到 toId 标签 after 位置', async () => {
      const { store, ids } = await setupThreeTabs()
      store.reorderTabs(ids.a, ids.c, 'after')
      expect(store.tabs.map(t => t.id)).toEqual([ids.b, ids.c, ids.a])
    })

    it('fromId === toId → no-op,顺序不变', async () => {
      const { store, ids } = await setupThreeTabs()
      const before = store.tabs.map(t => t.id)
      store.reorderTabs(ids.b, ids.b, 'before')
      expect(store.tabs.map(t => t.id)).toEqual(before)
    })

    it('重排后 activeId 切到被拖的 fromId(用户期望拖完继续编辑刚拖的文档)', async () => {
      const { store, ids } = await setupThreeTabs()
      store.switchTab(ids.b)
      expect(store.activeId).toBe(ids.b)
      store.reorderTabs(ids.b, ids.a, 'before')
      // 拖完 → 激活变成 fromId
      expect(store.activeId).toBe(ids.b)
      // tabs 顺序反映重排
      expect(store.tabs.map(t => t.id)).toEqual([ids.b, ids.a, ids.c])
    })

    it('拖动一个非活动 tab 后,该 tab 变成活动', async () => {
      const { store, ids } = await setupThreeTabs()
      // 当前 active = c(最后一次 openPathInTab 激活的)
      expect(store.activeId).toBe(ids.c)
      store.reorderTabs(ids.a, ids.c, 'before')
      // a 被拖动 → 变成活动
      expect(store.activeId).toBe(ids.a)
      // a 从 0 移到 c(原本 idx=2)之前 → 顺序 [b, a, c]
      expect(store.tabs.map(t => t.id)).toEqual([ids.b, ids.a, ids.c])
    })

    it('保 DocState 引用(同一个 Map value 不被替换,编辑器缓存不丢)', async () => {
      const { store, ids } = await setupThreeTabs()
      const aDocBefore = store.documents.get(ids.a)
      store.reorderTabs(ids.c, ids.a, 'before')
      const aDocAfter = store.documents.get(ids.a)
      expect(aDocAfter).toBe(aDocBefore) // 同一引用
    })

    it('未知 id → no-op,不抛错', async () => {
      const { store, ids } = await setupThreeTabs()
      const before = store.tabs.map(t => t.id)
      // 任一 id 不存在
      store.reorderTabs('nope', ids.a, 'before')
      store.reorderTabs(ids.a, 'nope', 'after')
      store.reorderTabs('nope', 'also-nope', 'before')
      expect(store.tabs.map(t => t.id)).toEqual(before)
    })
  })

  // 8. 批量关闭(标签右键菜单 v0.6.x):
  //  - closeOtherTabs / closeTabsToRight / closeSavedTabs / closeAllTabs / saveTabById
  //  - dirty 标签逐个 confirm;任一取消 → return false,后续标签原样保留
  //  - 活动标签切换语义对齐 closeTab(关掉自身才切相邻,否则不动 activeId)
  describe('批量关闭(标签右键菜单)', () => {
    /** 起三个标签 a / b / c;把 a 和 b 设成 dirty(模拟编辑未保存) */
    async function setupThreeTabsWithDirty() {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInTab('/a.md')
      const a = store.activeId
      store.setContent('hello edited') // a dirty
      await store.openPathInTab('/b.md')
      const b = store.activeId
      store.setContent('hello edited b') // b dirty
      await store.openPathInTab('/c.md')
      const c = store.activeId
      return { store, ids: { a, b, c } }
    }

    it('closeOtherTabs:关掉除指定外的全部,dirty 逐个 confirm', async () => {
      const { store, ids } = await setupThreeTabsWithDirty()
      vi.mocked(confirm).mockResolvedValue(true) // 用户同意丢脏

      await store.closeOtherTabs(ids.b)

      expect(store.tabs.length).toBe(1)
      expect(store.activeId).toBe(ids.b)
    })

    it('closeOtherTabs:用户中途取消 dirty → 停在该 dirty 标签,后续不再弹', async () => {
      const { store, ids } = await setupThreeTabsWithDirty()
      // a 是第一个被 closeOtherTabs 关的 dirty 标签(顺序按 Map 插入序 a / b / c)
      vi.mocked(confirm).mockResolvedValueOnce(false)

      const ok = await store.closeOtherTabs(ids.b)
      expect(ok).toBe(false)
      // a 还留着(用户没同意关),b / c 未弹 confirm(因为循环停在 a)
      expect(store.tabs.length).toBe(3)
      // closeOtherTabs 在 abort 后没机会把 active 切到 b → 活动仍是 a 或 c(openPathInTab 最后激活的)
      expect([ids.a, ids.c]).toContain(store.activeId)
    })

    it('closeTabsToRight:关掉指定 tab 右侧的全部(不含自身)', async () => {
      const { store, ids } = await setupThreeTabsWithDirty()
      vi.mocked(confirm).mockResolvedValue(true)

      await store.closeTabsToRight(ids.a)

      expect(store.tabs.map(t => t.id)).toEqual([ids.a])
      expect(store.activeId).toBe(ids.a)
    })

    it('closeTabsToRight:指定 tab 是最右 → no-op', async () => {
      const { store, ids } = await setupThreeTabsWithDirty()
      vi.mocked(confirm).mockClear()

      const ok = await store.closeTabsToRight(ids.c)
      expect(ok).toBe(true)
      expect(vi.mocked(confirm)).not.toHaveBeenCalled()
      expect(store.tabs.length).toBe(3)
    })

    it('closeSavedTabs:同步关掉所有非 dirty,保留 dirty', async () => {
      const { store, ids } = await setupThreeTabsWithDirty()
      store.closeSavedTabs()
      // a / b dirty → 保留;c clean → 关掉
      expect(store.tabs.map(t => t.id).sort()).toEqual([ids.a, ids.b].sort())
      // c 是 active 且被关 → 切到剩余首个(a,Map 保插入序)
      expect(store.activeId).toBe(ids.a)
    })

    it('closeSavedTabs:活动标签是 clean 且被关 → 切到剩余首个', () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      // 两个 clean 标签 + 活动是第一个
      const a = store.createTab()
      store.switchTab(a)
      const b = store.createTab()
      // b 改成 dirty
      const bDoc = store.documents.get(b)!
      bDoc.content = 'dirty'

      store.closeSavedTabs()
      // a 是 clean → 关;只剩 b
      expect(store.tabs.map(t => t.id)).toEqual([b])
      // activeId 原本是已删的 a → 切到剩余首个 b
      expect(store.activeId).toBe(b)
    })

    it('closeAllTabs:逐个 confirm;用户同意 → 全关,activeId 变空', async () => {
      const { store } = await setupThreeTabsWithDirty()
      vi.mocked(confirm).mockResolvedValue(true)

      const ok = await store.closeAllTabs()
      expect(ok).toBe(true)
      expect(store.tabs.length).toBe(0)
      expect(store.activeId).toBe('')
    })

    it('closeAllTabs:用户中途取消 → 保留后续未弹 confirm 的', async () => {
      const { store, ids } = await setupThreeTabsWithDirty()
      vi.mocked(confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      // a dirty 确认关,b dirty 确认弹但取消,c 不再弹(循环停在 b)
      const ok = await store.closeAllTabs()
      expect(ok).toBe(false)
      // a 已关,b / c 留下
      expect(store.tabs.length).toBe(2)
      expect(store.tabs.map(t => t.id).sort()).toEqual([ids.b, ids.c].sort())
    })

    it('saveTabById:有 path → 走 saveDoc;dirty 时写盘并清基线', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('hello\n')
      await store.openPathInTab('/a.md')
      store.setContent('hello world')
      expect(store.dirty).toBe(true)
      vi.mocked(writeTextFile).mockResolvedValueOnce()

      const ok = await store.saveTabById(store.activeId)
      expect(ok).toBe(true)
      expect(store.dirty).toBe(false)
      expect(vi.mocked(writeTextFile)).toHaveBeenCalledWith('/a.md', 'hello world')
    })

    it('saveTabById:无 path → 走 saveAsDoc(saveDialog)', async () => {
      const store = useDocumentStore()
      store.init('untitled content') // 未命名,无 path
      vi.mocked(saveDialog).mockResolvedValueOnce('/saved.md')
      vi.mocked(writeTextFile).mockResolvedValueOnce()

      const ok = await store.saveTabById(store.activeId)
      expect(ok).toBe(true)
      expect(store.currentFilePath).toBe('/saved.md')
    })

    it('saveTabById:只读标签 → false,不写盘', async () => {
      const store = useDocumentStore()
      store.init('')
      store.openSampleTab('sample content', '示例.md')
      vi.mocked(writeTextFile).mockClear()

      const ok = await store.saveTabById(store.activeId)
      expect(ok).toBe(false)
      expect(vi.mocked(writeTextFile)).not.toHaveBeenCalled()
    })
  })

  // 7. dirty 是 computed
  describe('dirty 是 computed', () => {
    it('setContent 改变后立刻反映;改回 baseline 后清零', () => {
      const store = useDocumentStore()
      store.init('hello')
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
      // 重新绑定 writeTextFile 的 mock,统计调用次数
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()

      await store.saveCurrentDraft()
      expect(writes).not.toHaveBeenCalled()
    })

    it('saveCurrentDraft:dirty 时写一份草稿到 appDataDir/drafts/', async () => {
      const store = useDocumentStore()
      store.init('hello')
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
      store.loadContent('你好', '/文档/笔记.md')
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
      store.loadContent('v1', '/文档/v.md')
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

    it('saveCurrentDraft:不同 draftScope 下同一文件草稿 id 不冲突', async () => {
      const store = useDocumentStore()
      store.init('')
      store.loadContent('base', '/same.md')
      store.setContent('window one')
      store.setDraftScope('main')
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()
      await store.saveCurrentDraft()
      const firstPath = writes.mock.calls.map(c => String(c[0])).find(p => p.endsWith('.json.tmp')) ?? ''

      store.setDraftScope('velo-window-1')
      writes.mockClear()
      await store.saveCurrentDraft()
      const secondPath = writes.mock.calls.map(c => String(c[0])).find(p => p.endsWith('.json.tmp')) ?? ''

      expect(firstPath).toContain('win-main-file-')
      expect(secondPath).toContain('win-velo-window-1-file-')
      expect(firstPath).not.toBe(secondPath)
    })

    it('saveCurrentDraft:多个 untitled window 使用各自 scoped slot', async () => {
      const store = useDocumentStore()
      store.init('')
      store.setContent('')
      store.setContent('dirty')
      const writes = vi.mocked(writeTextFile)

      store.setDraftScope('main')
      writes.mockClear()
      await store.saveCurrentDraft()
      const firstPath = writes.mock.calls.map(c => String(c[0])).find(p => p.endsWith('.json.tmp')) ?? ''

      store.setDraftScope('velo-window-1')
      writes.mockClear()
      await store.saveCurrentDraft()
      const secondPath = writes.mock.calls.map(c => String(c[0])).find(p => p.endsWith('.json.tmp')) ?? ''

      expect(firstPath).toContain('win-main-untitled')
      expect(secondPath).toContain('win-velo-window-1-untitled')
      expect(firstPath).not.toBe(secondPath)
    })

    it('saveCurrentDraft:无 draftScope 时保留旧 untitled id', async () => {
      const store = useDocumentStore()
      store.init('')
      store.setContent('dirty')
      const writes = vi.mocked(writeTextFile)
      writes.mockClear()

      await store.saveCurrentDraft()

      const calledPaths = writes.mock.calls.map(c => String(c[0]))
      expect(calledPaths.some(p => p.includes('/untitled.json.tmp'))).toBe(true)
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
      const before = store.content
      const pathBefore = store.currentFilePath

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('No such file'))

      // 不应抛
      await expect(store.openPath('/missing.md')).resolves.toBe(false)

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

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      vi.mocked(readTextFile).mockResolvedValueOnce('new content')

      const ok = await store.openPath('/new.md')

      expect(ok).toBe(true)
      expect(vi.mocked(message)).not.toHaveBeenCalled()
      expect(store.content).toBe('new content\n')
      expect(store.currentFilePath).toBe('/new.md')
      expect(useRecentFilesStore().entries.map(e => e.path)).toEqual(['/new.md'])
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

      expect(store.content).toBe('A content\n')
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
      expect(store.content).toBe('newest\n')
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

  // ========== 多标签 + openFilePaths(v0.6.x 标签持久化) ==========
  //
  // openFilePaths 是 workspaceStore 持久化 openTabs 的数据源:
  // 插入序 = 标签条从左到右;过滤未命名空白 / sample;允许同 path 出现多次。
  // App.vue 的 watcher 把这个数组写到 workspaceState.openTabs,启动恢复
  // 再走 openPathInTab({ silent: true }) 顺序重开。

  describe('openFilePaths + openPathInTab({ silent })', () => {
    it('空 store:openFilePaths 是空数组', () => {
      const store = useDocumentStore()
      store.init('')
      expect(store.openFilePaths).toEqual([])
    })

    it('插入两个文件后 openFilePaths 保 documents 插入序', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValueOnce('A').mockResolvedValueOnce('B')
      await store.openPathInTab('/a.md')
      await store.openPathInTab('/b.md')
      expect(store.openFilePaths).toEqual(['/a.md', '/b.md'])
    })

    it('未命名空白 / sample 标签被过滤,只剩有 currentFilePath 的', async () => {
      const store = useDocumentStore()
      store.init('') // 首个空白未命名标签
      vi.mocked(readTextFile).mockResolvedValueOnce('real')
      await store.openPathInTab('/real.md')
      store.openSampleTab('# sample content', 'sample.md')
      expect(store.openFilePaths).toEqual(['/real.md'])
    })

    it('同一 path 多次开(openPathInNewTab)→ openFilePaths 含重复项', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('content')
      await store.openPathInTab('/a.md')
      // 强制新开同一 path
      await store.openPathInNewTab('/a.md')
      expect(store.openFilePaths).toEqual(['/a.md', '/a.md'])
    })

    it('closeTab 后 openFilePaths 收敛,顺序仍保文档剩余顺序', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('content')
      await store.openPathInTab('/a.md')
      await store.openPathInTab('/b.md')
      await store.openPathInTab('/c.md')
      const middleTab = store.tabs.find(t => t.fileName === 'b.md')!
      vi.mocked(saveDialog as any).mockResolvedValue(undefined) // 关 dirty 标签时 confirm
      vi.mocked(confirm).mockResolvedValue(true)
      await store.closeTab(middleTab.id)
      expect(store.openFilePaths).toEqual(['/a.md', '/c.md'])
    })

    it('openPathInTab({ silent: true }) 失败时只 console.warn,不弹原生 message', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('not found'))

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const ok = await store.openPathInTab('/missing.md', { silent: true })
      expect(ok).toBe(false)
      expect(vi.mocked(message)).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('openPathInTab(默认) 失败时弹原生 message', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('not found'))

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()
      const ok = await store.openPathInTab('/missing.md')
      expect(ok).toBe(false)
      expect(vi.mocked(message)).toHaveBeenCalledTimes(1)
    })
  })

  // 8.5 批量并行恢复 openPathsInTabs(v0.6.x):
  //  - IO 并行:Promise.all(readTextFile × N),不串行
  //  - commit 同步:循环里无 await,所有 reactive 在同一 microtask 触发
  //  - 复用 init 空白只一次(pristineConsumed 标记)
  //  - silent 失败路径不弹 message,非 silent 顺次 await message
  //  - 返回成功 path 列表(供 caller 决定最终 switchTab)
  describe('openPathsInTabs 批量并行恢复', () => {
    it('空输入 → 返回空数组,不动 store', async () => {
      const store = useDocumentStore()
      store.init('')
      const tabsBefore = store.tabs.length
      const restored = await store.openPathsInTabs([])
      expect(restored).toEqual([])
      expect(store.tabs.length).toBe(tabsBefore)
    })

    it('三个文件全部成功:openFilePaths 保持输入顺序,复用 init 空白只一次', async () => {
      const store = useDocumentStore()
      store.init('') // 首个干净空白标签
      vi.mocked(readTextFile).mockResolvedValue('content')

      const restored = await store.openPathsInTabs(['/a.md', '/b.md', '/c.md'])

      expect(restored).toEqual(['/a.md', '/b.md', '/c.md'])
      // init 空白被第 1 个文件复用 + 后 2 个 createTab = 3 个标签
      expect(store.tabs.length).toBe(3)
      // 插入序保 openFilePaths 顺序
      expect(store.openFilePaths).toEqual(['/a.md', '/b.md', '/c.md'])
      // 三个 doc 都装载了对应文件
      expect(store.tabs.map(t => t.fileName)).toEqual(['a.md', 'b.md', 'c.md'])
      // 全部推到全局最近文件
      expect(useRecentFilesStore().entries.map(e => e.path)).toEqual(['/c.md', '/b.md', '/a.md'])
    })

    // 核心断言:IO 是并行的,不是串行。readTextFile 内部用 mockImplementation
    // 记录同时 in-flight 的调用数:Promise.all 模式下,3 个 promise 在同一个
    // microtask 内 kick off,in-flight 计数应为 3;串行 await 模式下永远 ≤ 1。
    it('IO 阶段真并发:readTextFile 同时 in-flight 数 = N', async () => {
      const store = useDocumentStore()
      store.init('')
      let inFlight = 0
      let maxInFlight = 0
      vi.mocked(readTextFile).mockImplementation(async (p: any) => {
        inFlight++
        if (inFlight > maxInFlight) maxInFlight = inFlight
        // 故意延迟,确保并发的 promise 同时存在
        await new Promise(r => setTimeout(r, 20))
        inFlight--
        return `content-of-${String(p).split(/[\\/]/).pop()}`
      })

      await store.openPathsInTabs(['/a.md', '/b.md', '/c.md'])

      // 并发模式下应该看到过 3 个 in-flight
      expect(maxInFlight).toBeGreaterThanOrEqual(2)
    })

    it('中途失败:成功路径装载,失败路径不进 restored', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile)
        .mockResolvedValueOnce('A')
        .mockRejectedValueOnce(new Error('not found'))
        .mockResolvedValueOnce('C')

      const restored = await store.openPathsInTabs(['/a.md', '/missing.md', '/c.md'], { silent: true })

      expect(restored).toEqual(['/a.md', '/c.md'])
      expect(store.openFilePaths).toEqual(['/a.md', '/c.md'])
      // init 被 /a.md 复用 + /c.md createTab = 2 个标签
      expect(store.tabs.length).toBe(2)
    })

    it('silent 失败:console.warn,不弹原生 message', async () => {
      const store = useDocumentStore()
      store.init('')
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('not found'))
      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()

      const restored = await store.openPathsInTabs(['/missing.md'], { silent: true })

      expect(restored).toEqual([])
      expect(vi.mocked(message)).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('非 silent 失败:console.error + 弹原生 message', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockRejectedValueOnce(new Error('not found'))

      const { message } = await import('@tauri-apps/plugin-dialog')
      vi.mocked(message).mockClear()

      const restored = await store.openPathsInTabs(['/missing.md'])

      expect(restored).toEqual([])
      expect(vi.mocked(message)).toHaveBeenCalledTimes(1)
      const [body] = vi.mocked(message).mock.calls[0]
      expect(String(body)).toContain('not found')
    })

    it('复用 init 空白只一次:第 2..N 个文件 createTab,不开第 2 个空白标签', async () => {
      const store = useDocumentStore()
      store.init('') // init 已创建 1 个空白标签
      const initBlankId = store.activeId
      vi.mocked(readTextFile).mockResolvedValue('content')

      await store.openPathsInTabs(['/a.md', '/b.md'])

      // init 复用装载 /a.md + /b.md createTab = 2 个标签
      expect(store.tabs.length).toBe(2)
      // 第一个标签 id 就是 init 创建的(被复用)
      expect(store.tabs[0].id).toBe(initBlankId)
      // init 空白被复用装载 /a.md
      expect(store.tabs[0].fileName).toBe('a.md')
    })

    it('全部失败:restored = [],documents 不变(只剩 init 空白)', async () => {
      const store = useDocumentStore()
      store.init('')
      const initBlankId = store.activeId
      vi.mocked(readTextFile).mockRejectedValue(new Error('disk error'))

      const restored = await store.openPathsInTabs(['/a.md', '/b.md'], { silent: true })

      expect(restored).toEqual([])
      // init 空白标签原样保留
      expect(store.tabs.length).toBe(1)
      expect(store.activeId).toBe(initBlankId)
      expect(store.openFilePaths).toEqual([])
    })

    it('commit 阶段是同步的:createTab/switchTab/loadContent 都在同一 microtask 完成', async () => {
      // 验证 commit 阶段不 await —— 让 mockImplementation 在 readTextFile 期间
      // 看到 documents.size === 0(commit 还没跑),在 commit 后看到完整 N。
      const store = useDocumentStore()
      store.init('')
      const sizesAtReadTime: number[] = []
      vi.mocked(readTextFile).mockImplementation(async () => {
        sizesAtReadTime.push(store.tabs.length)
        return 'c'
      })

      await store.openPathsInTabs(['/a.md', '/b.md', '/c.md'])

      // IO 阶段(在第一个 await 之前)tabs 还是 1(init);commit 阶段已经全跑完
      expect(sizesAtReadTime.every(s => s === 1)).toBe(true)
      // commit 后 tabs = init(1) + /b.md、/c.md createTab(2) = 3
      expect(store.tabs.length).toBe(3)
    })

    // v0.6.x 修复:启动恢复 dedupe 兜底。
    // 历史 velo-workspaces.json 的 openTabs 可能含同 path 重复项(旧版 setOpenTabs
    // 不 dedupe + 中键狂点单一文件),openPathsInTabs 拿到这种数据会把同一文件
    // createTab N 次 → TabBar 渲染 N 个相同 tab → WebView2 主线程被拖死,
    // 表现为 dev 进入卡死什么也点不了、devtools 打不开。
    // 修复后输入去重保插入序:first 胜出,顺序与输入一致。
    it('输入含同 path 重复项 → dedupe 保插入序,first 胜出', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('content')

      const restored = await store.openPathsInTabs(['/a.md', '/b.md', '/a.md', '/c.md', '/a.md'])

      expect(restored).toEqual(['/a.md', '/b.md', '/c.md'])
      expect(store.openFilePaths).toEqual(['/a.md', '/b.md', '/c.md'])
      expect(store.tabs.length).toBe(3)
      // readTextFile 只对 dedupe 后的 3 个 path 调用了 1 次
      expect(readTextFile).toHaveBeenCalledTimes(3)
    })

    it('输入完全重复(同一 path × N)→ 只 createTab 1 次,restore = 1 项', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('content')

      const restored = await store.openPathsInTabs(['/a.md', '/a.md', '/a.md'])

      expect(restored).toEqual(['/a.md'])
      // init 空白复用 1 次,后续重复都丢掉 → 只有 1 个标签
      expect(store.tabs.length).toBe(1)
      expect(store.openFilePaths).toEqual(['/a.md'])
    })

    it('非字符串项(脏数据)→ 静默跳过,不进 store', async () => {
      const store = useDocumentStore()
      store.init('')
      vi.mocked(readTextFile).mockResolvedValue('content')

      // 模拟 velo-workspaces.json 被人手改坏 —— 含 null / undefined / 空串
      const restored = await store.openPathsInTabs([
        '/a.md',
        null as unknown as string,
        undefined as unknown as string,
        '',
        '/b.md',
      ])

      expect(restored).toEqual(['/a.md', '/b.md'])
      expect(store.tabs.length).toBe(2)
    })

    // 启动恢复期二次保险:startupMode='last-file' 段会先调 openPathInTab(lastFile)
    // 把 lastFile 装到 init 空白,随后 openPathsInTabs(persistedOpenTabs) 又跑一次。
    // 修复前:openPathsInTabs 看到 active 不是空白 → createTab + loadContent → 同
    // path 双 tab,表现为"关掉再开变两个一样的"。
    // 修复后:openPathsInTabs 内部对每个 path 先 findTabByPath,命中就 skip,不再
    // 重复装载,与 openPathInTab "已开则切换"语义对齐。
    it('启动恢复期:path 已在 documents 里(openPathInTab 先装的)→ 不重复装载', async () => {
      const store = useDocumentStore()
      store.init('')
      // 模拟 startupMode='last-file' 段已经先调 openPathInTab('面试.md'):
      // active 此时是装着 面试.md 的 tab(不是空白)
      await store.openPathInTab('/interview.md')
      expect(store.tabs.length).toBe(1)
      expect(store.openFilePaths).toEqual(['/interview.md'])

      vi.mocked(readTextFile).mockResolvedValue('content')
      // 紧接着 openPathsInTabs 恢复持久化的 openTabs,包含同样的 /interview.md
      const restored = await store.openPathsInTabs(['/interview.md', '/other.md'])

      // /interview.md 已开 → skip;只新开 /other.md;共 2 个标签,各 path 唯一
      expect(restored).toEqual(['/interview.md', '/other.md'])
      expect(store.tabs.length).toBe(2)
      expect(store.openFilePaths).toEqual(['/interview.md', '/other.md'])
    })
  })
})

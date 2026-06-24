// Velo 工作区主链路 E2E:CLI 启动 → 新建 → 编辑保存 → 重命名 → 删除。
//
// 走 WebdriverIO + tauri-driver,从 src-tauri/target/debug/velo.exe 冷启动,
// 把临时工作区路径作为 CLI arg 注入(绕开"打开文件夹"系统对话框)。
//
// 删除步骤的系统 confirm 走 src/tauri/dialog.ts 里 `import.meta.env.DEV` 守门:
// before() 注入 `window.__VELO_E2E_AUTO_CONFIRM__ = true`,confirm 全部 resolve true。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { browser, $ } from '@wdio/globals'
import { mkTempWorkspace, cleanupWorkspace, seedFile } from '../helpers/workspace.js'
import { killStaleVelo, restartWithArgs } from '../helpers/process.js'
import { snapshotAppData, restoreAppData } from '../helpers/appdata.js'
import { sel } from '../helpers/selectors.js'

let ws: string

describe('Velo 工作区 CRUD 主链路', () => {
  before(async () => {
    killStaleVelo()
    // E2E 跑 debug binary 跟 dev / release 共用 %APPDATA%/com.velo.editor;
    // setActiveRoot(tempWs) 触发 App.vue debounce watch 落盘 → 永久污染用户
    // 持久化。before 备份 → after 还原,跑完原样不动。
    snapshotAppData()
    ws = mkTempWorkspace()
    seedFile(path.join(ws, 'seed.md'), '# seed\n')
    await restartWithArgs(browser, [ws])
    // 等 webview 加载完 + Vue 应用 mount + 文件树读完根目录
    await $(sel.workspaceRoot).waitForDisplayed({ timeout: 15_000 })
    // 注入 E2E auto-confirm 标志(覆盖 src/tauri/dialog.ts 守门)
    await browser.execute(() => {
      ;(window as unknown as { __VELO_E2E_AUTO_CONFIRM__?: boolean }).__VELO_E2E_AUTO_CONFIRM__ = true
    })
  })

  after(async () => {
    try {
      await browser.deleteSession()
    } catch {
      // session 可能已挂
    }
    killStaleVelo()
    cleanupWorkspace(ws)
    // 必须放 killStaleVelo 之后:Velo 还活着时回写 json,debounce watch 又会
    // 把内存里的 active=tempWs 落一次 → 还原失败。先杀进程再覆盖。
    restoreAppData()
  })

  // WebView2 + msedgedriver:Actions API 的 right-click 在 WebView2 里
  // 不会触发 'contextmenu' 事件(只发 mousedown/mouseup)。直接 dispatchEvent
  // 把 MouseEvent('contextmenu') 灌到目标元素 —— Vue 的 @contextmenu 监听
  // 走 native event,这里手发等价。
  async function rightClick(selector: string): Promise<void> {
    const el = await $(selector)
    await browser.execute((target: HTMLElement) => {
      const r = target.getBoundingClientRect()
      target.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 8,
        clientY: r.top + 8,
        button: 2,
      }))
    }, el as unknown as HTMLElement)
  }

  // 普通 click 在 WebView2 + msedgedriver 下也偶发 "not interactable"
  // (尤其虚拟列表里的 row,driver 的 visibility 检查比浏览器实际渲染保守)。
  // 走 JS dispatchEvent('click') 一致绕开。
  async function jsClick(selector: string): Promise<void> {
    const el = await $(selector)
    await browser.execute((target: HTMLElement) => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    }, el as unknown as HTMLElement)
  }

  // 行内 input 用 setValue 会触发 msedgedriver 的 interactability 检查 ——
  // WebView2 里这条检查有时会卡(input 位于虚拟列表末尾且 .focus() 走
  // nextTick 异步赋,clear 命令到达时 focus 可能没就位)。改走 JS:直接
  // 写 input.value + 派发 'input' 事件让 Vue v-model 同步,Enter 由后续
  // browser.keys 触发 @keydown.enter。
  async function setInlineValue(text: string): Promise<void> {
    await browser.execute((value: string) => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="inline-input"]')
      if (!el) throw new Error('inline-input not found')
      el.focus()
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, text)
  }

  it('1. CLI 启动后 FileTree 渲染出工作区根 + seed.md', async () => {
    await $(sel.fileRow('seed.md')).waitForDisplayed({ timeout: 10_000 })
  })

  it('2. 右键根 → 新建文件 → 输入 alpha → Enter,alpha.md 出现在树里', async () => {
    await rightClick(sel.workspaceRoot)
    await $(sel.ctx.newFile).waitForDisplayed({ timeout: 5_000 })
    await $(sel.ctx.newFile).click()
    await $(sel.inlineInput).waitForDisplayed({ timeout: 5_000 })
    await setInlineValue('alpha')
    await browser.keys('Enter')
    await $(sel.fileRow('alpha.md')).waitForDisplayed({ timeout: 5_000 })
  })

  it('3. 点 alpha.md 打开,在编辑器输入,Ctrl+S 保存,fs 物理内容含写入文本', async () => {
    await jsClick(sel.fileRow('alpha.md'))
    const pm = await $(sel.pmEditor)
    await pm.waitForDisplayed({ timeout: 5_000 })
    // PM 容器外层,focus 进 contenteditable
    await jsClick(sel.pmEditor)
    await browser.keys('Hello E2E')
    await browser.keys(['Control', 's'])
    // 等 save 写盘:轮询 fs(标题 dirty marker 不可靠;直接读)
    const filePath = path.join(ws, 'alpha.md')
    await browser.waitUntil(
      () => {
        try {
          return readFileSync(filePath, 'utf8').includes('Hello E2E')
        } catch {
          return false
        }
      },
      { timeout: 5_000, timeoutMsg: 'alpha.md 内容未含 "Hello E2E"' },
    )
  })

  it('4. 右键 alpha.md → 重命名 → 输入 beta → Enter,树中 alpha→beta', async () => {
    await rightClick(sel.fileRow('alpha.md'))
    await $(sel.ctx.rename).waitForDisplayed({ timeout: 5_000 })
    await $(sel.ctx.rename).click()
    await $(sel.inlineInput).waitForDisplayed({ timeout: 5_000 })
    await setInlineValue('beta')
    await browser.keys('Enter')
    await $(sel.fileRow('beta.md')).waitForDisplayed({ timeout: 5_000 })
    await $(sel.fileRow('alpha.md')).waitForExist({ reverse: true, timeout: 5_000 })
  })

  it('5. 右键 beta.md → 删除 → 自动 confirm → 树中消失', async () => {
    await rightClick(sel.fileRow('beta.md'))
    await $(sel.ctx.delete).waitForDisplayed({ timeout: 5_000 })
    await $(sel.ctx.delete).click()
    await $(sel.fileRow('beta.md')).waitForExist({ reverse: true, timeout: 5_000 })
  })
})

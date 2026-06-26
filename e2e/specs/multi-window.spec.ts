import { spawn } from 'node:child_process'
import path from 'node:path'
import { browser, $, expect } from '@wdio/globals'
import { mkTempWorkspace, cleanupWorkspace, seedFile } from '../helpers/workspace.js'
import { killStaleVelo, restartWithArgs, findVeloBinary } from '../helpers/process.js'
import { sel } from '../helpers/selectors.js'
import { snapshotAppData, restoreAppData } from '../helpers/appdata.js'

async function waitForWindowCount(count: number): Promise<string[]> {
  await browser.waitUntil(async () => (await browser.getWindowHandles()).length >= count, {
    timeout: 10_000,
    interval: 250,
    timeoutMsg: `expected at least ${count} windows`,
  })
  return await browser.getWindowHandles()
}

describe('Velo 多窗口', () => {
  let wsA: string
  let wsB: string

  before(async () => {
    killStaleVelo()
    snapshotAppData()
    wsA = mkTempWorkspace()
    wsB = mkTempWorkspace()
    seedFile(path.join(wsA, 'a.md'), '# A\n')
    seedFile(path.join(wsB, 'b.md'), '# B\n')
    await restartWithArgs(browser, [wsA])
    await $(sel.workspaceRoot).waitForDisplayed({ timeout: 15_000 })
  })

  after(async () => {
    try {
      await browser.deleteSession()
    } catch {
      // session 可能已挂
    }
    killStaleVelo()
    cleanupWorkspace(wsA)
    cleanupWorkspace(wsB)
    restoreAppData()
  })

  it('二次启动打开独立工作区窗口', async () => {
    await $(sel.workspaceLabel).waitForDisplayed({ timeout: 10_000 })
    await expect($(sel.workspaceLabel)).toHaveTextContaining(path.basename(wsA))
    const firstHandle = await browser.getWindowHandle()

    const child = spawn(findVeloBinary(), [wsB], { detached: true, stdio: 'ignore' })
    child.unref()

    const handles = await waitForWindowCount(2)
    const secondHandle = handles.find(h => h !== firstHandle)
    expect(secondHandle).toBeTruthy()

    await browser.switchToWindow(firstHandle)
    await expect($(sel.workspaceLabel)).toHaveTextContaining(path.basename(wsA))

    await browser.switchToWindow(secondHandle!)
    await $(sel.workspaceLabel).waitForDisplayed({ timeout: 10_000 })
    await expect($(sel.workspaceLabel)).toHaveTextContaining(path.basename(wsB))
  })
})

// 阶段 2 引入:在所有测试运行前注册 Tauri mock。
// vi.mock 会被 hoist 到文件顶部,所以即使业务代码 import 这些模块,
// 拿到的也是这里的 stub。
import { vi } from 'vitest'

// jsdom 不实现 CSS.escape(W3C CSSOM spec 的一部分)。linkClickPlugin 用它
// 做 querySelector `[id="..."]` 时转义 heading id 里的特殊字符。
// 这里补一个 spec 的 ASCII 子集实现,够我们用(production 用浏览器原生)。
if (typeof globalThis.CSS === 'undefined' || !globalThis.CSS.escape) {
  globalThis.CSS = {
    ...(globalThis.CSS ?? {}),
    escape(value: string): string {
      return String(value).replace(/[\0-\x1F\x7F!"#$%&'()*+,./:;<=>?@[\]^`{|}~\\]/g, '\\$&')
    },
  }
}

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  // Tauri 2.5 把 readBinaryFile / writeBinaryFile 合并为 readFile / writeFile(binary)
  readFile: vi.fn(),
  writeFile: vi.fn(),
  watch: vi.fn(async () => () => {}),
  // 草稿管理(drafts/)用到的:存在判断 / 建目录 / 列目录 / 原子 rename / 删文件
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  // copyFile 给潜在的图片复制场景备用
  copyFile: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
}))

// linkClick 插件用 open() 调系统浏览器打开外部 URL。
// 同 plugin-dialog 的 open 不同名模块,保持各自 stub 独立。
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => {}),
}))

// getCurrentWindow 整个进程是单例 —— 真实 Tauri 运行时也是同一个 window 对象。
// 测试里如果每次调用都 new 一个 vi.fn(),跨次检查调用次数就废了(每次都是新 mock)。
// 这里用 module-scope 持有唯一的 setTitle,beforeEach 用 vi.resetAllMocks() 清历史。
const setTitleMock = vi.fn()
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: setTitleMock }),
}))

vi.mock('@tauri-apps/api/path', () => ({
  // 草稿 / 设置 / 大纲持久化都通过 appDataDir() 拿到数据目录,join() 拼路径。
  // 测试里返回固定字符串,让 readDir / writeTextFile 这类 fs 操作的 path 参数可预测。
  appDataDir: vi.fn(async () => '/appData'),
  join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\\/g, '/')),
  // imageStorage 拿 dirname(currentFilePath) 算 fileDir
  dirname: vi.fn(async (p: string) => p.split('/').slice(0, -1).join('/') || '/'),
  // FileTree rootDisplay 用 sep 拿路径分隔符
  sep: vi.fn(() => '/'),
}))

// 默认 isTauri() 在 jsdom 里返回 false(globalThis.isTauri 没注入),
// persistence.ts 的 tauriOnly() 守门会让所有草稿 IO 走 noop 分支,
// store 层的 draft 测试拿不到任何 IO 调用。测试环境一律按 "Tauri 运行时"
// 处理:让 persistence 实际调 plugin-fs mock,业务代码自身的 isTauri()
// 守门路径不归这里管(由 store 单元测试直接覆盖)。
//
// 只暴露 persistence.ts / 其它受测代码用得到的导出;其它(convertFileSrc
// / invoke 等)给个 stub,免得业务代码意外走到真实实现抛 "no IPC"。
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(async () => undefined),
  convertFileSrc: vi.fn((p: string) => p),
}))

// 阶段 2 引入:在所有测试运行前注册 Tauri mock。
// vi.mock 会被 hoist 到文件顶部,所以即使业务代码 import 这些模块,
// 拿到的也是这里的 stub。
import { vi } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  watch: vi.fn(async () => () => {}),
  // 草稿管理(drafts/)用到的:存在判断 / 建目录 / 列目录 / 原子 rename / 删文件
  exists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
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
}))

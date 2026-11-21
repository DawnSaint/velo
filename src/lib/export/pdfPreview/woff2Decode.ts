// wawoff2 解压器封装 —— 绕开 wawoff2/decompress.js 在 Vite dev 预构建下的悬挂 bug。
//
// 根因（2026-11-20 实测定位）：
//   wawoff2 的 emscripten binding 只在 ENVIRONMENT_IS_NODE 分支里写
//   `module["exports"] = Module`。Vite dev 的 rolldown 预构建把 binding 包成
//   `__commonJSMin((exports, module) => {...})` 且按浏览器环境执行 —— NODE 分支
//   不进，返回的是空 `mod.exports` 而不是 Module 对象。decompress.js 随后把
//   `onRuntimeInitialized = resolve` 注册在这个空对象上，binding 内部 doRun
//   触发的是真 Module 上的回调（undefined）→ runtimeInit Promise 永久悬挂 →
//   buildFontSet 卡死 → 预览面板一直「重排中…」。生产构建同样会踩（同一份
//   预构建/转换逻辑），并非 dev 独有。
//
// 修法：?raw 拿 binding 源码，new Function 在受控作用域执行 ——
//   1. 首行 `var Module = typeof Module !== "undefined" ? Module : {}` 直接采用
//      我们传入的 Module 参数，对象身份由我们持有；
//   2. 传入 module/exports 参数，NODE 分支的 exports 赋值落在我们的对象上；
//   3. onRuntimeInitialized 由我们在执行后立刻注册：WEB 分支 wasm 异步实例化，
//      doRun 必然晚于当前同步栈；NODE 分支（vitest）doRun 在微任务里，同样赶得上。
//      另以 calledRun 兜底同步完成的情形，15s 超时兜底异常路径。
//
// 本模块只能被懒加载链路 import（fontSubset.ts 是唯一消费方）。

import bindingSource from 'wawoff2/build/decompress_binding.js?raw'

interface Wawoff2Module {
  calledRun?: boolean
  onRuntimeInitialized?: () => void
  decompress(buffer: Uint8Array): Uint8Array | false
}

let readyPromise: Promise<Wawoff2Module> | null = null

function loadRuntime(): Promise<Wawoff2Module> {
  if (!readyPromise) {
    readyPromise = new Promise<Wawoff2Module>((resolve, reject) => {
      // decompress 由 embind 在 runtime 初始化时注册，执行前断言为完整类型
      const em = {} as Wawoff2Module
      const fakeModule = { exports: em }
      const timer = setTimeout(() => reject(new Error('wawoff2 wasm 初始化超时（15s）')), 15_000)
      const done = () => { clearTimeout(timer); resolve(em) }
      try {
        // binding 是 CJS 风格的 emscripten 产物：NODE 分支引用 require/__dirname，
        // WEB 分支引用 window/document/fetch/atob。new Function 的函数体是非严格
        // 模式，与原始脚本求值语义一致。浏览器里 require/__dirname 传 undefined
        // 即可（NODE 分支不会执行）；vitest 里 process 存在会走 NODE 分支，但
        // wasm 是 base64 内嵌（tryParseAsDataURI 先命中），不会真的读盘。
        const factory = new Function(
          'Module', 'module', 'exports', 'require', '__dirname',
          'window', 'self', 'document', 'fetch', 'atob',
          'WebAssembly', 'setTimeout', 'clearTimeout', 'console',
          bindingSource as string,
        )
        factory(
          em, fakeModule, em, undefined, undefined,
          globalThis.window, globalThis.self, globalThis.document,
          globalThis.fetch?.bind(globalThis), globalThis.atob?.bind(globalThis),
          WebAssembly, setTimeout, clearTimeout, console,
        )
      } catch (e) {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      if (em.calledRun) done()
      else em.onRuntimeInitialized = done
    })
  }
  return readyPromise
}

/** woff2 字节 → sfnt（TTF）字节。返回独立副本，不挂在 wasm 堆上。 */
export async function decompressWoff2(woff2: Uint8Array): Promise<Uint8Array> {
  const em = await loadRuntime()
  const result = em.decompress(woff2)
  if (result === false) throw new Error('ConvertWOFF2ToTTF failed（woff2 损坏？）')
  // 输出是 wasm 堆上的视图：立刻拷出，防后续调用覆盖 / 内存增长 detach
  return result.slice()
}
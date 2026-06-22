/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

// node:fs / node:path —— 仅用于 vitest 测试侧读取 SCSS 源(验证 CSS 规则存在,
// vitest 跑 ?inline / ?raw 对 .scss 都返回空,见 katexCss.ts 注释)。项目本身
// 没装 @types/node(避免拉不必要的依赖,运行时 vitest 自带 Node API);这里给
// 测试用到的最小 API 表面写 ambient 声明。生产代码路径不走这些。
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}
declare module 'node:path' {
  export function resolve(...paths: string[]): string
}

// vitest 在 ESM 测试文件里也提供 CommonJS `__dirname` 全局(Vite 的
// `import.meta.dirname` 别名)。给 TS 一个明确声明,免去 @types/node。
declare const __dirname: string

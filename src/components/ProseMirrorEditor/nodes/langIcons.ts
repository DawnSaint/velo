// 语言图标静态 map —— 直接从 lang-icons/*.svg 文件 import(body 字符串),加别名表
// 和 lucide Code(< > 双尖括号)兜底。
//
// 图标源:lang-icons/*.svg(Nonicons 开源图标库 17 个品牌视觉,单色 currentColor 风格,
// 16×16 画布)。文件清单即本目录下的 *.svg;键对齐 CodeBlockLangs.ts 的 LANG_OPTIONS。
//
// 新增语言 = 往 lang-icons/ 丢一个 <lang>.svg + LANG_ICON_BRAND 补一行,重跑构建;
// picker / toolbar 代码不动。

import javascriptSvg from './lang-icons/javascript.svg?raw'
import typescriptSvg from './lang-icons/typescript.svg?raw'
import pythonSvg from './lang-icons/python.svg?raw'
import goSvg from './lang-icons/go.svg?raw'
import rustSvg from './lang-icons/rust.svg?raw'
import javaSvg from './lang-icons/java.svg?raw'
import cSvg from './lang-icons/c.svg?raw'
import cppSvg from './lang-icons/cpp.svg?raw'
import csharpSvg from './lang-icons/csharp.svg?raw'
import htmlSvg from './lang-icons/html.svg?raw'
import cssSvg from './lang-icons/css.svg?raw'
import jsonSvg from './lang-icons/json.svg?raw'
import yamlSvg from './lang-icons/yaml.svg?raw'
import tomlSvg from './lang-icons/toml.svg?raw'
import dockerSvg from './lang-icons/docker.svg?raw'
import vueSvg from './lang-icons/vue.svg?raw'
import svelteSvg from './lang-icons/svelte.svg?raw'

const LANG_ICON_VIEWBOX = '0 0 16 16'

/**
 * 从 lang-icons/*.svg 的完整 SVG 字符串里抽出内部 markup(去掉外层 <svg ...> 与
 * </svg>),保留路径 / 形状元素。langIconSvg 再套一层带 viewBox 与尺寸的外壳。
 */
function inner(svg: string): string {
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg\s*>/)
  return m ? m[1].trim() : ''
}

/**
 * lang 内部 markup 品牌表。未列出的 LANG_OPTIONS 项(含 plain text / bash / shell /
 * powershell / sql / xml / markdown / diff / makefile / mermaid)走 fallback:
 * langIconSvg 用 lucide Code(< > 双尖括号)兜底。别名复用同一 body:jsx→javascript /
 * tsx→typescript / scss→css / sass→css / less→css / shell→bash / dockerfile→docker。
 */
const LANG_ICON_BRAND: Readonly<Record<string, string>> = {
  javascript: inner(javascriptSvg),
  typescript: inner(typescriptSvg),
  jsx: inner(javascriptSvg),
  tsx: inner(typescriptSvg),
  python: inner(pythonSvg),
  go: inner(goSvg),
  rust: inner(rustSvg),
  java: inner(javaSvg),
  c: inner(cSvg),
  cpp: inner(cppSvg),
  csharp: inner(csharpSvg),
  html: inner(htmlSvg),
  css: inner(cssSvg),
  scss: inner(cssSvg),
  sass: inner(cssSvg),
  less: inner(cssSvg),
  json: inner(jsonSvg),
  yaml: inner(yamlSvg),
  toml: inner(tomlSvg),
  dockerfile: inner(dockerSvg),
  vue: inner(vueSvg),
  svelte: inner(svelteSvg),
}

// fallback 图标:与 @lucide/vue 的 Code(< > 双尖括号)同风格,但适配本项目 16×16 画布。
// stroke 路径,需外层 svg 走 stroke / currentColor(而非 fill=currentColor),故
// langIconSvg 对 fallback 分支套 stroke 风格外壳。
const FALLBACK_BODY = '<path d="M5 3.5L1.5 8l3.5 4.5" /><path d="M11 3.5L14.5 8 11 11.5" />'

/**
 * 工厂:返回可直接 innerHTML / v-html 的带尺寸 <svg> 字符串。
 * 品牌分支(fill=currentColor,nonicons 风格);未命中品牌分支(stroke=currentColor,
 * lucide Code 双尖括号 fallback)。lang 不在 LANG_OPTIONS 里同样走 fallback(不崩溃)。
 */
export function langIconSvg(lang: string, size: number): string {
  const brand = LANG_ICON_BRAND[lang]
  if (brand)
    return `<svg viewBox="${LANG_ICON_VIEWBOX}" fill="currentColor" width="${size}" height="${size}">${brand}</svg>`
  return `<svg viewBox="${LANG_ICON_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}">${FALLBACK_BODY}</svg>`
}

/** map 版本(hover 计算 / tooltip 等需要 raw inner 的场景复用)。 */
export const LANG_ICON_INNER: Readonly<Record<string, string>> = LANG_ICON_BRAND
export { LANG_ICON_VIEWBOX }

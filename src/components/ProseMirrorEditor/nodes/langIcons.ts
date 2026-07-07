// 语言图标静态 map —— 直接从 lang-icons/*.svg 文件 import(body 字符串),加别名表
// 和 fallback code 图标兜底。
//
// 图标源:lang-icons/*.svg —— 品牌图标取自 Nonicons(nonicons/*.svg),通用图标取自
// Nonicons 仓库内附的 Octicons(octicons/*.svg),均为单色 currentColor 风格、16×16 画布。
// 文件清单即本目录下的 *.svg;键对齐 CodeBlockLangs.ts 的 LANG_OPTIONS。
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
import terminalSvg from './lang-icons/terminal.svg?raw'
import databaseSvg from './lang-icons/database.svg?raw'
import diffSvg from './lang-icons/diff.svg?raw'
import markdownSvg from './lang-icons/markdown.svg?raw'
import fileCodeSvg from './lang-icons/file-code.svg?raw'
import gearSvg from './lang-icons/gear.svg?raw'
import dartSvg from './lang-icons/dart.svg?raw'
import elixirSvg from './lang-icons/elixir.svg?raw'
import elmSvg from './lang-icons/elm.svg?raw'
import graphqlSvg from './lang-icons/graphql.svg?raw'
import kotlinSvg from './lang-icons/kotlin.svg?raw'
import luaSvg from './lang-icons/lua.svg?raw'
import perlSvg from './lang-icons/perl.svg?raw'
import phpSvg from './lang-icons/php.svg?raw'
import rSvg from './lang-icons/r.svg?raw'
import scalaSvg from './lang-icons/scala.svg?raw'
import swiftSvg from './lang-icons/swift.svg?raw'
import reactSvg from './lang-icons/react.svg?raw'
import mermaidSvg from './lang-icons/mermaid.svg?raw'
import codeSvg from './lang-icons/code.svg?raw'
import noteSvg from './lang-icons/note.svg?raw'

// viewBox 四周各留 1 单位内边距(-1 -1 18 18):nonicons / octicons 源图标路径紧贴
// 16×16 画布边缘,直接缩放到 12-14px 渲染时边缘像素被抗锯齿裁切,加 padding 后不裁。
// 调用方传 size 时按 18/16 ≈ 1.125 放大(12→14、14→16)保持视觉大小不变。
const LANG_ICON_VIEWBOX = '-1 -1 18 18'

/**
 * 从 lang-icons/*.svg 的完整 SVG 字符串里抽出内部 markup(去掉外层 <svg ...> 与
 * </svg>),保留路径 / 形状元素。同时去掉 path / shape 上的 fill="..." 属性,
 * 让外层 svg 的 fill 统一控制颜色(nonicons 源 SVG 的 path 带冗余 fill="currentColor"
 * 或 fill="black",去掉后不影响渲染)。langIconSvg 再套一层带 viewBox 与尺寸的外壳。
 */
function inner(svg: string): string {
  const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg\s*>/)
  return m ? m[1].trim().replace(/\sfill="[^"]*"/g, '') : ''
}

/**
 * lang 品牌色表(hex)。取自各语言官方品牌色 / simple-icons 社区数据。未列出的语言
 * (json / diff / xml / plain text)无公认品牌色,langIconSvg 走 currentColor
 * 跟随文字色。别名需在此同步登记颜色。
 */
const LANG_ICON_COLOR: Readonly<Record<string, string>> = {
  javascript: '#F7DF1E',
  jsx: '#61DAFB',
  typescript: '#3178C6',
  tsx: '#61DAFB',
  python: '#3776AB',
  go: '#00ADD8',
  rust: '#DEA584',
  java: '#007396',
  c: '#A8B9CC',
  cpp: '#00599C',
  csharp: '#239120',
  html: '#E34F26',
  css: '#1572B6',
  scss: '#CC6699',
  sass: '#CC6699',
  less: '#1D365D',
  yaml: '#CB171E',
  toml: '#9C4221',
  dockerfile: '#2496ED',
  vue: '#4FC08D',
  svelte: '#FF3E00',
  bash: '#4EAA25',
  shell: '#89E051',
  powershell: '#5391FE',
  sql: '#E48E00',
  markdown: '#083FA1',
  makefile: '#427819',
  dart: '#0175C2',
  elixir: '#4B275F',
  elm: '#60B5CC',
  graphql: '#E10098',
  kotlin: '#7F52FF',
  lua: '#2C2D72',
  perl: '#39457E',
  php: '#777BB4',
  r: '#276DC3',
  scala: '#DC322F',
  swift: '#F05138',
  react: '#61DAFB',
  mermaid: '#FF3670',
}

/**
 * lang 内部 markup 品牌表。别名复用同一 body:jsx/tsx→react /
 * scss→css / sass→css / less→css / shell→bash / dockerfile→docker /
 * powershell→terminal(同 bash 共用 terminal 图标)。空字符串 ''(plain text)
 * 用 note 图标。未命中表的 lang(用户手敲的未注册 lang)走 fallback code 图标。
 *
 * 品牌图标(nonicons):js/ts/py/go/rust/java/c/cpp/csharp/html/css/json/yaml/toml/
 * docker/vue/svelte/react/dart/elixir/elm/graphql/kotlin/lua/perl/php/r/scala/swift。
 * 通用图标(octicons):bash/shell/powershell→terminal、sql→database、diff→diff、
 * markdown→markdown、xml→file-code、makefile→gear、mermaid→flowchart、
 * plain text→note、fallback→code。
 */
const LANG_ICON_BRAND: Readonly<Record<string, string>> = {
  '': inner(noteSvg),
  javascript: inner(javascriptSvg),
  typescript: inner(typescriptSvg),
  jsx: inner(reactSvg),
  tsx: inner(reactSvg),
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
  react: inner(reactSvg),
  bash: inner(terminalSvg),
  shell: inner(terminalSvg),
  powershell: inner(terminalSvg),
  sql: inner(databaseSvg),
  diff: inner(diffSvg),
  markdown: inner(markdownSvg),
  xml: inner(fileCodeSvg),
  makefile: inner(gearSvg),
  dart: inner(dartSvg),
  elixir: inner(elixirSvg),
  elm: inner(elmSvg),
  graphql: inner(graphqlSvg),
  kotlin: inner(kotlinSvg),
  lua: inner(luaSvg),
  perl: inner(perlSvg),
  php: inner(phpSvg),
  r: inner(rSvg),
  scala: inner(scalaSvg),
  swift: inner(swiftSvg),
  mermaid: inner(mermaidSvg),
}

// fallback 图标(octicons code-16):未命中 LANG_ICON_BRAND 的 lang 用此图标。
// fill 风格,与品牌图标一致,由 langIconSvg 外层 fill 统一控制颜色。
const FALLBACK_BODY = inner(codeSvg)

/**
 * 工厂:返回可直接 innerHTML / v-html 的带尺寸 <svg> 字符串。
 * 品牌分支:有品牌色 → fill=品牌色;有图标但无品牌色(json/diff/xml/plain text)
 * → fill=currentColor 跟随文字色。未命中品牌分支(fallback code 图标)同样
 * 走 fill=currentColor。lang 不在 LANG_OPTIONS 里同样走 fallback(不崩溃)。
 */
export function langIconSvg(lang: string, size: number): string {
  const brand = LANG_ICON_BRAND[lang] ?? FALLBACK_BODY
  const color = LANG_ICON_COLOR[lang] ?? 'currentColor'
  return `<svg viewBox="${LANG_ICON_VIEWBOX}" fill="${color}" width="${size}" height="${size}">${brand}</svg>`
}

/** map 版本(hover 计算 / tooltip 等需要 raw inner 的场景复用)。 */
export const LANG_ICON_INNER: Readonly<Record<string, string>> = LANG_ICON_BRAND
export { LANG_ICON_VIEWBOX }

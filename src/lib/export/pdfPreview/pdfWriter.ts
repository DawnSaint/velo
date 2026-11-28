// Display List → PDF 字节。
//
// 不依赖 WebView2 / PrintToPdf / 任何原生打印 API：纯 TS 拼 PDF 对象。
// 三平台（Windows / macOS / Linux）行为完全一致，导出只走前端 writeFile。
//
// 字体：Type0 / Identity-H + CIDFontType2 + FontFile2（子集 TTF）+ /W 宽度表
// + /CIDToGIDMap /Identity + ToUnicode CMap。文字是真正的 PDF text 算子，
// 可选中 / 可搜索 / 可复制，不是路径轮廓。
//
// 富片段：
//   B 档 → `q sx 0 0 sy x y cm <矢量内容流> Q`（正缩放，svgToPdf 已翻好 y）
//   A 档 → `q w 0 0 h x y cm /ImN Do Q`（/DCTDecode 图像 XObject）
//   都没有 → 降级为 fallbackText，进 warnings。

import {
  fontMeta, fontSlotKeys, FONT_RES, colorToRgb, encodeGidsHex, encodeMixed, formulaFontList,
  loadFontBytes, type3FontData,
  type FontMeta, type Type3FontData,
} from './tokens'
import type { DisplayOp, PdfDocument, RichFragment } from './types'

const enc = new TextEncoder()
const f = (n: number): string => (Math.round(n * 100) / 100).toString()
const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0')
const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0')

/** 圆角矩形路径（PDF 坐标，y 向上；调用方负责填色 / 描边）。 */
function roundedRectPdf(x: number, yBottom: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  const L = x, R = x + w, B = yBottom, T = yBottom + h
  if (rr === 0) return `${f(L)} ${f(B)} ${f(w)} ${f(h)} re `
  const k = 0.5523 * rr
  return [
    `${f(L + rr)} ${f(T)} m `,
    `${f(R - rr)} ${f(T)} l `,
    `${f(R - rr + k)} ${f(T)} ${f(R)} ${f(T - rr + k)} ${f(R)} ${f(T - rr)} c `,
    `${f(R)} ${f(B + rr)} l `,
    `${f(R)} ${f(B + rr - k)} ${f(R - rr + k)} ${f(B)} ${f(R - rr)} ${f(B)} c `,
    `${f(L + rr)} ${f(B)} l `,
    `${f(L + rr - k)} ${f(B)} ${f(L)} ${f(B + rr - k)} ${f(L)} ${f(B + rr)} c `,
    `${f(L)} ${f(T - rr)} l `,
    `${f(L)} ${f(T - rr + k)} ${f(L + rr - k)} ${f(T)} ${f(L + rr)} ${f(T)} c `,
    'h ',
  ].join('')
}

/** gid → UTF-16BE 码位（支持 BMP 外字符的代理对）。 */
function unicodeHex(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0
  if (cp <= 0xFFFF) return hex4(cp)
  const v = cp - 0x10000
  return hex4(0xD800 + (v >> 10)) + hex4(0xDC00 + (v & 0x3FF))
}

function toUnicodeCmap(meta: FontMeta): string {
  const map = new Map<number, string>()
  for (const [ch, pair] of Object.entries(meta.chars)) {
    const gid = pair[0]
    if (!map.has(gid)) map.set(gid, unicodeHex(ch))
  }
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
  const lines: string[] = []
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    lines.push(`${chunk.length} beginbfchar`)
    for (const [gid, u] of chunk) lines.push(`<${hex4(gid)}> <${u}>`)
    lines.push('endbfchar')
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...lines,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
}

function toUnicodeCmapType3(meta: FontMeta): string {
  const map = new Map<number, string>()
  for (const [ch, pair] of Object.entries(meta.chars)) {
    const code = pair[0]
    if (code >= 1 && code <= 255 && !map.has(code)) map.set(code, unicodeHex(ch))
  }
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
  const lines: string[] = []
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100)
    lines.push(`${chunk.length} beginbfchar`)
    for (const [code, u] of chunk) lines.push(`<${hex2(code)}> <${u}>`)
    lines.push('endbfchar')
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    ...lines,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
}

/** 惰性 A 档：只在导出时把还没位图的富片段光栅化。 */
async function ensureFragmentImages(doc: PdfDocument): Promise<string[]> {
  const warnings: string[] = []
  const pending = new Set<string>()
  for (const page of doc.pages) {
    for (const op of page.ops) {
      if (op.op !== 'fragment') continue
      const fr = doc.fragments[op.id]
      if (fr && !fr.pdf && !fr.image && fr.rasterize) pending.add(op.id)
    }
  }
  await Promise.all([...pending].map(async (id) => {
    const fr = doc.fragments[id]
    try {
      const img = await fr.rasterize?.()
      if (img) fr.image = img
      else warnings.push(`富片段 ${id} 位图化失败，已降级为文字`)
    } catch {
      warnings.push(`富片段 ${id} 位图化异常，已降级为文字`)
    }
  }))
  return warnings
}

interface FontIds {
  type0: number
  cid: number
  desc: number
  file: number
  tounicode: number
}

class PdfBuilder {
  private bodies: (Uint8Array | null)[] = []
  private nextId = 1

  reserve(): number { const id = this.nextId++; this.bodies.push(null); return id }

  set(id: number, body: string): void { this.bodies[id - 1] = enc.encode(body) }

  setStream(id: number, dict: string, bytes: Uint8Array): void {
    const head = enc.encode(`${dict}\nstream\n`)
    const tail = enc.encode('\nendstream')
    const body = new Uint8Array(head.length + bytes.length + tail.length)
    body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length)
    this.bodies[id - 1] = body
  }

  build(catalogId: number, infoId: number): Uint8Array {
    const chunks: Uint8Array[] = []
    const offsets: number[] = []
    let len = 0
    const push = (u: Uint8Array) => { chunks.push(u); len += u.length }
    push(enc.encode('%PDF-1.7\n%Velo\n'))
    for (let i = 0; i < this.bodies.length; i++) {
      offsets.push(len)
      push(enc.encode(`${i + 1} 0 obj\n`))
      push(this.bodies[i] ?? enc.encode('<< >>'))
      push(enc.encode('\nendobj\n'))
    }
    const xref = len
    let table = `xref\n0 ${this.bodies.length + 1}\n0000000000 65535 f \n`
    for (const off of offsets) table += `${off.toString().padStart(10, '0')} 00000 n \n`
    table += `trailer\n<< /Size ${this.bodies.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    push(enc.encode(table))
    const out = new Uint8Array(len)
    let at = 0
    for (const c of chunks) { out.set(c, at); at += c.length }
    return out
  }
}

function contentStream(
  doc: PdfDocument,
  pageIndex: number,
  imgIds: Record<string, number>,
  bodyFontCount: number,
  formulaFonts: { key: string }[],
): string {
  const H = doc.pageHeight
  const page = doc.pages[pageIndex]
  let out = ''
  const color = (c: string, stroke = false) => `${colorToRgb(c)} ${stroke ? 'RG' : 'rg'}\n`
  const resNameOf = (font: string): string | null => {
    if (font in FONT_RES) return `/${FONT_RES[font]}`
    const i = formulaFonts.findIndex(e => e.key === font)
    return i >= 0 ? `/F${bodyFontCount + i + 1}` : null
  }

  for (const op of page.ops) {
    switch (op.op) {
      case 'text': {
        const hex = encodeGidsHex(op.font, op.gids)
        if (!hex) break
        out += `${color(op.color)}BT /${FONT_RES[op.font]} ${f(op.size)} Tf 1 0 0 1 ${f(op.x)} ${f(H - op.y)} Tm <${hex}> Tj ET\n`
        break
      }
      case 'rect':
        out += `${color(op.fill)}${f(op.x)} ${f(H - op.y - op.h)} ${f(op.w)} ${f(op.h)} re f\n`
        break
      case 'strokeRect':
        out += `${color(op.color, true)}${f(op.width)} w ${f(op.x)} ${f(H - op.y - op.h)} ${f(op.w)} ${f(op.h)} re S\n`
        break
      case 'line':
        out += `${color(op.color, true)}${f(op.width)} w ${f(op.x1)} ${f(H - op.y1)} m ${f(op.x2)} ${f(H - op.y2)} l S\n`
        break
      case 'link':
        // 内容流里不画任何东西：注解是独立对象，/Border [0 0 0] 不描边。
        break
      case 'deco': {
        // 自写 HTML 标签底衬：先填充再描边（圆角框）。
        const { x, y, w, h, fill, stroke, radius } = op
        const width = op.width ?? 1
        const bottom = H - y - h
        if (fill) out += `${color(fill)}`
        if (stroke) out += `${color(stroke, true)}${f(width)} w\n`
        out += roundedRectPdf(x, bottom, w, h, radius ?? 3)
        if (fill && stroke) out += 'B\n'
        else if (fill) out += 'f\n'
        else if (stroke) out += 'S\n'
        else out += 'n\n'
        break
      }
      case 'fragment': {
        const fr: RichFragment | undefined = doc.fragments[op.id]
        const bottom = H - op.y - op.h
        if (!fr) break
        if (fr.formula) {
          // KaTeX 矢量：算子已是基线系 y 向上 pt；外层 cm 原样铺到片段盒，
          // 内部再上移 depth（盒底 = 基线下 depth）。srcW/srcH == w/h → sx=sy=1。
          const fx = fr.formula
          let body = `q 1 0 0 1 0 ${f(fx.depth)} cm\n`
          for (const r of fx.rects) {
            body += `${color(r.color)}${f(r.x)} ${f(r.y)} ${f(r.w)} ${f(r.h)} re f\n`
          }
          for (const p of fx.paths) {
            // 每条路径自带 q/Q：clip 是图形状态，不能漏到下一条
            body += 'q\n'
            if (p.clip) body += `${f(p.clip.x)} ${f(p.clip.y)} ${f(p.clip.w)} ${f(p.clip.h)} re W n\n`
            if (p.fill) body += `${color(p.fill)} rg\n`
            if (p.stroke) body += `${color(p.stroke)} RG\n${f(p.strokeWidth ?? 0.5)} w\n`
            body += p.ops
            body += p.fill && p.stroke ? 'B\n' : p.fill ? 'f\n' : p.stroke ? 'S\n' : 'n\n'
            body += 'Q\n'
          }
          for (const t of fx.texts) {
            const res = resNameOf(t.font)
            if (!res) continue
            body += `${color(t.color)} rg\nBT ${res} ${f(t.size)} Tf 1 0 0 1 ${f(t.x)} ${f(t.y)} Tm <${encodeGidsHex(t.font, [t.gid])}> Tj ET\n`
          }
          body += 'Q\n'
          out += `q 1 0 0 1 ${f(op.x)} ${f(bottom)} cm\n${body}Q\n`
          break
        }
        if (fr.pdf && fr.srcW > 0 && fr.srcH > 0) {
          const sx = op.w / fr.srcW, sy = op.h / fr.srcH
          out += `q ${f(sx)} 0 0 ${f(sy)} ${f(op.x)} ${f(bottom)} cm\n${fr.pdf}\nQ\n`
        } else if (fr.image && imgIds[fr.id]) {
          out += `q ${f(op.w)} 0 0 ${f(op.h)} ${f(op.x)} ${f(bottom)} cm /Im${imgIds[fr.id]} Do Q\n`
        } else if (fr.fallbackText) {
          // 保底：仍写文字层，不让内容整块消失
          const size = Math.min(10, op.h / 2)
          let x = op.x
          for (const g of encodeMixed(fr.fallbackText.slice(0, 200), 'sans')) {
            out += `0.4 0.4 0.4 rg\nBT /${FONT_RES[g.font]} ${f(size)} Tf 1 0 0 1 ${f(x)} ${f(H - op.y - size)} Tm <${encodeGidsHex(g.font, g.gids)}> Tj ET\n`
            x += g.units / 1000 * size
          }
        }
        break
      }
      default: break
    }
  }
  return out
}

/** PDF 字符串字面量转义（圆括号 / 反斜杠）。 */
function pdfLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * PDF Name 对象编码：非安全字节按 UTF-8 逐字节写 #XX。
 * 命名目标（/Dest 与 catalog /Dests 的 key）必须用同一种编码，否则 reader 匹配不上。
 * 对齐 Chromium PrintToPdf：中文 slug 会以 #E4#BD#... 形式写入。
 */
function pdfName(s: string): string {
  const unsafe = new Set([0x23, 0x25, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d]) // # % ( ) / < > [ ] { }
  let out = '/'
  for (const byte of enc.encode(s)) {
    if (byte >= 0x21 && byte <= 0x7e && !unsafe.has(byte)) out += String.fromCharCode(byte)
    else out += '#' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/**
 * 收集每页的链接注解对象 id。返回 { annotsByPage, destNames }：
 * - URI → /A << /Type /Action /S /URI /URI (...) >>
 * - 内部锚点 → /Dest /name，catalog /Dests 用 PDF 1.1 命名目标字典
 *
 * 注意：一个 /Rect 必须恰好 4 个数；多块热区（如跨段 run）拆成多个注解，
 * 不能把 8 个数拼进同一个 /Rect —— 那样整条注解会被 reader 判为非法而忽略。
 */
function collectLinkAnnots(
  doc: PdfDocument,
  b: PdfBuilder,
  reserveId: () => number,
): { annotsByPage: Record<number, number[]>; destNames: string[] } {
  const H = doc.pageHeight
  const W = doc.pageWidth
  const annotsByPage: Record<number, number[]> = {}
  const destNameSet = new Set<string>()

  doc.pages.forEach((page, pi) => {
    for (const op of page.ops) {
      if (op.op !== 'link') continue
      // 目标不存在的内部链接整条跳过（引用了未渲染的 heading）
      if (op.dest && !doc.destinations[op.dest]) continue
      if (!op.uri && !op.dest) continue
      const name = op.dest ? pdfName(op.dest) : ''
      if (op.dest) destNameSet.add(op.dest)

      for (const r of op.rects) {
        if (r.w <= 0.5 || r.h <= 0.5) continue
        const x1 = Math.max(0, Math.min(W, r.x))
        const x2 = Math.max(0, Math.min(W, r.x + r.w))
        // 注解矩形是 PDF 坐标（左下角原点、y 向上）
        const y1 = Math.max(0, Math.min(H, H - r.y - r.h))
        const y2 = Math.max(0, Math.min(H, H - r.y))
        if (x2 <= x1 || y2 <= y1) continue

        const id = reserveId()
        let body = `<< /Type /Annot /Subtype /Link /F 4 /Border [0 0 0]`
        if (op.uri) body += ` /A << /Type /Action /S /URI /URI (${pdfLiteral(op.uri)}) >>`
        else body += ` /Dest ${name}`
        body += ` /Rect [${[x1, y1, x2, y2].map(f).join(' ')}] >>`
        b.set(id, body)
        ;(annotsByPage[pi] ??= []).push(id)
      }
    }
  })
  return { annotsByPage, destNames: [...destNameSet] }
}
export async function writePdf(doc: PdfDocument): Promise<Uint8Array> {
  const warnings = await ensureFragmentImages(doc)
  if (warnings.length) doc.warnings.push(...warnings)
  const fontBytes = await loadFontBytes()
  const b = new PdfBuilder()

  const catalogId = b.reserve()
  const pagesId = b.reserve()
  const infoId = b.reserve()

  const fontKeys = fontSlotKeys()

  // 图像 XObject：给所有已就绪的 A 档片段各分一个 id
  const imgIds: Record<string, number> = {}
  for (const fr of Object.values(doc.fragments)) {
    if (fr.image && !fr.pdf) imgIds[fr.id] = b.reserve()
  }

  // 每页 2 个对象：Page + Contents
  const pageIds = doc.pages.map(() => ({ page: b.reserve(), content: b.reserve() }))

  // ---- 链接注解 + 命名目标（先占 id，页对象随后引用）----
  const { annotsByPage, destNames } = collectLinkAnnots(doc, b, () => b.reserve())
  const destTreeId = destNames.length ? b.reserve() : 0

  // ---- 字体 ----
  const writeFontObjects = (meta: FontMeta, bytes: Uint8Array, base: string): number => {
    const ids: FontIds = {
      type0: b.reserve(), cid: b.reserve(), desc: b.reserve(),
      file: b.reserve(), tounicode: b.reserve(),
    }
    b.setStream(ids.file, `<< /Length ${bytes.length} /Length1 ${bytes.length} >>`, bytes)
    b.set(ids.desc, `<< /Type /FontDescriptor /FontName /${base} /Flags 4 /FontBBox [${meta.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${meta.ascent} /Descent ${meta.descent} /CapHeight ${meta.capHeight} /StemV 80 /FontFile2 ${ids.file} 0 R >>`)
    b.set(ids.cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ids.desc} 0 R /DW 1000 /W [0 [${meta.widths.join(' ')}]] /CIDToGIDMap /Identity >>`)
    const cmap = enc.encode(toUnicodeCmap(meta))
    b.setStream(ids.tounicode, `<< /Length ${cmap.length} >>`, cmap)
    b.set(ids.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${base} /Encoding /Identity-H /DescendantFonts [${ids.cid} 0 R] /ToUnicode ${ids.tounicode} 0 R >>`)
    return ids.type0
  }

  const writeType3FontObjects = (meta: FontMeta, t3: Type3FontData): number => {
    const fontId = b.reserve()
    const tounicodeId = b.reserve()

    const codes = Object.keys(t3.charProcs).map(Number).filter(c => c >= 1 && c <= 255).sort((a, c) => a - c)
    const firstChar = codes[0] ?? 1
    const lastChar = codes[codes.length - 1] ?? 1

    const procRefs: string[] = []
    for (const code of codes) {
      const pid = b.reserve()
      const stream = enc.encode(t3.charProcs[code])
      b.setStream(pid, `<< /Length ${stream.length} >>`, stream)
      procRefs.push(`/g${code} ${pid} 0 R`)
    }

    // Type3 字体私有资源（ExtGState 常量透明度 + 渐变软遮罩 / Shading 渐变 / Image 位图）
    const resParts: string[] = []
    const gsRefs: string[] = []
    for (const [name, alpha] of t3.alphas) {
      const gid = b.reserve()
      const a = Math.round(alpha * 1000) / 1000
      b.set(gid, `<< /Type /ExtGState /ca ${a} /CA ${a} >>`)
      gsRefs.push(`/${name} ${gid} 0 R`)
    }
    for (const sm of t3.softMasks) {
      const shId = b.reserve()
      b.set(shId, sm.shadingDict)
      const formId = b.reserve()
      const formStream = enc.encode('/ShM sh\n')
      b.setStream(
        formId,
        `<< /Type /XObject /Subtype /Form /BBox [${sm.bbox.map(f).join(' ')}] /Group << /Type /Group /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /ShM ${shId} 0 R >> >> /Length ${formStream.length} >>`,
        formStream,
      )
      const gsId = b.reserve()
      b.set(gsId, `<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G ${formId} 0 R >> >>`)
      gsRefs.push(`/${sm.name} ${gsId} 0 R`)
    }
    if (gsRefs.length > 0) {
      resParts.push(`/ExtGState << ${gsRefs.join(' ')} >>`)
    }
    if (t3.shadings.length > 0) {
      const shRefs: string[] = []
      for (const sh of t3.shadings) {
        const sid = b.reserve()
        b.set(sid, sh.pdfDict)
        shRefs.push(`/${sh.name} ${sid} 0 R`)
      }
      resParts.push(`/Shading << ${shRefs.join(' ')} >>`)
    }
    if (t3.images.length > 0) {
      const imRefs: string[] = []
      for (const img of t3.images) {
        let smaskPart = ''
        if (img.alphaFlate) {
          const smId = b.reserve()
          b.setStream(
            smId,
            `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${img.alphaFlate.length} >>`,
            img.alphaFlate,
          )
          smaskPart = ` /SMask ${smId} 0 R`
        }
        const imId = b.reserve()
        b.setStream(
          imId,
          `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smaskPart} /Length ${img.rgbFlate.length} >>`,
          img.rgbFlate,
        )
        imRefs.push(`/${img.name} ${imId} 0 R`)
      }
      resParts.push(`/XObject << ${imRefs.join(' ')} >>`)
    }

    const diffNames: string[] = []
    const widths: number[] = []
    for (let c = firstChar; c <= lastChar; c++) {
      diffNames.push(c in t3.charProcs ? `/g${c}` : '/.notdef')
      widths.push(meta.widths[c] ?? 0)
    }

    const scale = 1000 / Math.max(1, meta.upem)
    const bbox1000 = meta.bbox.map(v => Math.round(v * scale))

    const cmap = enc.encode(toUnicodeCmapType3(meta))
    b.setStream(tounicodeId, `<< /Length ${cmap.length} >>`, cmap)
    const resDict = resParts.length ? ` /Resources << ${resParts.join(' ')} >>` : ''
    b.set(
      fontId,
      `<< /Type /Font /Subtype /Type3 /FontBBox [${bbox1000.join(' ')}] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << ${procRefs.join(' ')} >> /Encoding << /Type /Encoding /Differences [${firstChar} ${diffNames.join(' ')}] >> /FirstChar ${firstChar} /LastChar ${lastChar} /Widths [${widths.join(' ')}]${resDict} /ToUnicode ${tounicodeId} 0 R >>`,
    )
    return fontId
  }

  const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9]/g, '')
  const bodyRes: string[] = []
  const metaMap = fontMeta()
  for (const key of fontKeys) {
    const t3 = type3FontData(key)
    const id = t3
      ? writeType3FontObjects(metaMap[key], t3)
      : (() => {
          const clean = sanitize(key)
          const base = `Velo${clean[0]?.toUpperCase() ?? 'F'}${clean.slice(1)}`
          return writeFontObjects(metaMap[key], fontBytes[key], base)
        })()
    bodyRes.push(`/${FONT_RES[key]} ${id} 0 R`)
  }

  // KaTeX 公式子集族：资源名紧跟正文全部槽位之后（无扩展槽位时仍从 F4 起）
  const formulaFonts = formulaFontList()
  const formulaRes: string[] = []
  formulaFonts.forEach((entry, i) => {
    const id = writeFontObjects(entry.meta, entry.ttf, `VeloKatex${sanitize(entry.key)}`)
    formulaRes.push(`/F${fontKeys.length + 1 + i} ${id} 0 R`)
  })

  // ---- 图像 ----
  for (const fr of Object.values(doc.fragments)) {
    const id = imgIds[fr.id]
    if (!id || !fr.image) continue
    const jpeg = fr.image.jpeg
    b.setStream(id, `<< /Type /XObject /Subtype /Image /Width ${fr.image.pxW} /Height ${fr.image.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>`, jpeg)
  }

  // ---- 命名目标字典（PDF 1.1：catalog /Dests → << /name [page /XYZ x y z] >>）----
  // 对齐 Chromium PrintToPdf：key 是 PDF Name（/xxx，非 ASCII 走 #XX），不是字符串字面量；
  // 不套 /Names name tree —— 那样 reader 会解析失败，所有内部跳转失效。
  if (destNames.length) {
    const H = doc.pageHeight
    const entries = destNames.map((name) => {
      const d = doc.destinations[name]
      const pageRef = d ? `${pageIds[d.page - 1].page} 0 R` : `${pageIds[0].page} 0 R`
      // [page /XYZ x y null]：x/y 是 PDF 坐标（y 向上），null = 保持当前缩放
      const x = d ? f(d.x) : '0'
      const y = d ? f(H - d.y) : f(H)
      return `${pdfName(name)} [${pageRef} /XYZ ${x} ${y} null]`
    }).join('\n')
    b.set(destTreeId, `<<\n${entries}\n>>`)
  }

  // ---- 页 ----
  const fontRes = [...bodyRes, ...formulaRes].join(' ')
  const xobjRes = Object.entries(imgIds).map(([, id]) => `/Im${id} ${id} 0 R`).join(' ')
  const resources = `<< /Font << ${fontRes} >>${xobjRes ? ` /XObject << ${xobjRes} >>` : ''} >>`
  doc.pages.forEach((_page, i) => {
    const { page, content } = pageIds[i]
    const stream = enc.encode(contentStream(doc, i, imgIds, fontKeys.length, formulaFonts))
    b.setStream(content, `<< /Length ${stream.length} >>`, stream)
    const annots = annotsByPage[i]
    const annotPart = annots && annots.length ? ` /Annots [${annots.map(id => `${id} 0 R`).join(' ')}]` : ''
    b.set(page, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(doc.pageWidth)} ${f(doc.pageHeight)}] /Resources ${resources} /Contents ${content} 0 R${annotPart} >>`)
  })

  const kids = pageIds.map(p => `${p.page} 0 R`).join(' ')
  b.set(pagesId, `<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>`)
  const namesPart = destNames.length ? ` /Dests ${destTreeId} 0 R` : ''
  b.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R${namesPart} >>`)
  b.set(infoId, '<< /Producer (Velo PDF Display List) /Creator (Velo) >>')
  return b.build(catalogId, infoId)
}

/** 供诊断：统计一份 Display List 的算子构成。 */
export function opsSummary(doc: PdfDocument): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of doc.pages) for (const o of p.ops as DisplayOp[]) out[o.op] = (out[o.op] ?? 0) + 1
  return out
}

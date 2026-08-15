<script setup lang="ts">
// 图片资产面板(v0.6.4):
//  - 扫描当前文档 markdown 中的所有 image 引用 `![alt](src "title")`
//  - 分组:本地图片(相对/绝对路径)/ 外链(http/https/data:)
//  - 点击文档图片条目 → emit('locate-image', src, occurrence) → App.vue
//    走 PM doc NodeSelection + scrollIntoView 定位
//  - 未被引用的图片文件:扫描 <docDir>/assets/ 下的图片文件,文档未引用的标灰展示
//    扩展名过滤:8 种标准图片 + 'bin'(当前版本 paste 兜底) + '(null)'(旧版字面量)
//    src 归一化:scanMarkdownImages 正则提取后走 unescapeMdUrl 剥转义反斜杠,
//    避免与孤儿磁盘路径(无转义)比对时误判为未引用
//  - 右键本地图片/孤儿条目 → 复制/移动到工作区 assets/<docName>/,编辑器引用路径同步重写
//
// 扫描走 markdown 字符串正则(非 PM doc),因为 Sidebar 不可达 PM view;
// 点击定位时 App.vue 负责在 PM doc 里按 src + occurrence 匹配节点。
//
// 未被引用图片扫描走 Tauri fs.readDir,dev web 端降级为只显示文档图片。

import { computed, onMounted, ref, watch } from 'vue'
import { Image as ImageIcon, ExternalLink, Unlink, ChevronRight } from '@lucide/vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { writeImage } from '@tauri-apps/plugin-clipboard-manager'
import { Image as TauriImage } from '@tauri-apps/api/image'
import { readDir, readFile, remove, copyFile, tauriOnly } from '@/tauri/fs'
import { save as dialogSave, confirm as dialogConfirm } from '@/tauri/dialog'
import { resolveImageAssetAbsPath, dirnameSync, isImageExt } from '@/utils/imagePath'
import { reorganizeAsset, docNameFromPath, isPathInRoot } from '@/utils/assetReorganize'
import { writeClipboardText } from '@/utils/clipboard'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNotifyStore } from '@/stores/notify'
import { useContextMenu, clampToViewport } from '@/composables/useContextMenu'
import { ASSET_IMAGE_MIME } from '@/components/ProseMirrorEditor/image/treeDrop'
import { basename as basenameSync } from './treeUtils'
import AssetContextMenu from './AssetContextMenu.vue'

const props = defineProps<{
  modelValue: string
  filePath: string | null
}>()

const emit = defineEmits<{
  'locate-image': [src: string, occurrence: number]
  'reorganize-asset': [payload: { oldAbsPath: string; newSrc: string; mode: 'copy' | 'move' }]
}>()

const workspaceStore = useWorkspaceStore()
const notify = useNotifyStore()

// ============================================================
//  类型
// ============================================================

interface ImageEntry {
  src: string
  alt: string
  title: string
  /** 同 src 在文档中第几次出现(0-based),用于点击定位时区分多个同 src 图片 */
  occurrence: number
  /** 用于缩略图展示的 URL(本地走 convertFileSrc,外链原样) */
  displayUrl: string
  /** 本地图片的磁盘绝对路径(外链为 null) */
  absPath: string | null
  /** 展示名:basename(src) 或截断的 URL */
  label: string
}

interface OrphanEntry {
  fileName: string
  absPath: string
  displayUrl: string
}

// ============================================================
//  图片分类
// ============================================================

function isExternalSrc(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')
}

/**
 * 去掉 markdown 链接中 url 部分的转义反斜杠(与 treeDrop.ts 的 escapeMdUrl 对仗)。
 * escapeMdUrl 对 `[\]()` 前置反斜杠,这里把 `\[` `\]` `\(` `\)` 还原。
 * 不处理别的 `\` 序列(标题里可能有 `\\` 合法转义),只剥这几个语法字符前的转义。
 */
function unescapeMdUrl(s: string): string {
  return s.replace(/\\([[\]()])/g, '$1')
}

/** 从 markdown 中提取所有图片引用,跳过围栏代码块和行内代码。 */
function scanMarkdownImages(markdown: string): { src: string; alt: string; title: string }[] {
  const results: { src: string; alt: string; title: string }[] = []
  const lines = markdown.split('\n')
  let inFence = false
  let fenceMarker = ''

  for (const line of lines) {
    const trimmed = line.trim()
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      const ch = fenceMatch[1][0]
      if (!inFence) { inFence = true; fenceMarker = ch }
      else if (ch === fenceMarker) { inFence = false; fenceMarker = '' }
      continue
    }
    if (inFence) continue

    // 移除行内代码 span,避免 `![alt](src)` 被误匹配
    let cleaned = line.replace(/`[^`]+`/g, '')

    // 链接目标里括号会被 escapeMdUrl 写成 `\(` `\)`,正则遇到
    // 第一个 `)` 就会截断,导致 src 解析失败。先把 `\(` `\)` 分别替换成
    // 两个路径里几乎不可能出现的 ASCII 占位标记 `__LPAR__` / `__RPAR__`,
    // 链接结束的裸 `)` 照常匹配占截断位。提取 src 后再把占位符还原回裸括号。
    // (旧文件可能仍有转义括号;新文件 toMarkdown 不转义,裸括号走 balanced 分支)
    cleaned = cleaned.replace(/\\\(/g, '__LPAR__').replace(/\\\)/g, '__RPAR__')

    // src 允许含 balanced 括号(本地路径常见,如 `(null).png`),用
    // `(?:[^()\s]|\([^()]*\))*` 匹配非括号非空白字符或 balanced `(...)` 对。
    const regex = /!\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))*)(?:\s+"([^"]*)")?\)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(cleaned)) !== null) {
      const srcRaw = match[2].replace(/__LPAR__/g, '(').replace(/__RPAR__/g, ')')
      results.push({
        alt: match[1],
        src: unescapeMdUrl(srcRaw),
        title: match[3] ?? '',
      })
    }
  }
  return results
}

function resolveDisplayUrl(src: string, filePath: string | null): { displayUrl: string; absPath: string | null } {
  if (isExternalSrc(src)) {
    return { displayUrl: src, absPath: null }
  }
  const absPath = resolveImageAssetAbsPath(src, filePath)
  if (absPath.startsWith('/') || /^[A-Z]:/i.test(absPath)) {
    return { displayUrl: convertFileSrc(absPath), absPath }
  }
  return { displayUrl: absPath, absPath }
}

function makeLabel(src: string): string {
  if (isExternalSrc(src)) {
    // 外链:显示域名 + 路径,截断
    try {
      const url = new URL(src)
      return url.hostname + (url.pathname !== '/' ? url.pathname : '')
    }
    catch {
      return src.length > 40 ? src.slice(0, 37) + '...' : src
    }
  }
  // 本地:取 basename
  const i = Math.max(src.lastIndexOf('/'), src.lastIndexOf('\\'))
  return i === -1 ? src : src.slice(i + 1)
}

/** 全部图片条目(本地 + 外链),按文档出现顺序 */
const allImages = computed<ImageEntry[]>(() => {
  const raw = scanMarkdownImages(props.modelValue)
  // 按 src 统计 occurrence + 总数(用于判断是否需要显示序号)
  const srcCount = new Map<string, number>()
  const entries = raw.map((img) => {
    const occ = srcCount.get(img.src) ?? 0
    srcCount.set(img.src, occ + 1)
    const { displayUrl, absPath } = resolveDisplayUrl(img.src, props.filePath)
    return {
      src: img.src,
      alt: img.alt,
      title: img.title,
      occurrence: occ,
      displayUrl,
      absPath,
      label: makeLabel(img.src),
    }
  })
  // 同 src 出现多次时,给 label 追加 #N(1-based)序号
  for (const e of entries) {
    if ((srcCount.get(e.src) ?? 0) > 1) {
      e.label = `${e.label} #${e.occurrence + 1}`
    }
  }
  return entries
})

const localImages = computed(() => allImages.value.filter((e) => e.absPath !== null))
const externalImages = computed(() => allImages.value.filter((e) => e.absPath === null))

/** 本地图片的 absPath 集合(去重),用于孤儿判定 */
const referencedAbsPaths = computed(() => {
  const set = new Set<string>()
  for (const img of localImages.value) {
    if (img.absPath) set.add(img.absPath.replace(/\\/g, '/'))
  }
  return set
})

// ============================================================
//  孤儿检测
// ============================================================

const orphans = ref<OrphanEntry[]>([])
const orphanLoading = ref(false)
let orphanScanTimer: ReturnType<typeof setTimeout> | null = null

async function scanOrphans() {
  if (!tauriOnly() || !props.filePath) {
    orphans.value = []
    return
  }

  const docDir = dirnameSync(props.filePath)
  if (!docDir) {
    orphans.value = []
    return
  }

  const assetsDir = `${docDir}/assets`
  orphanLoading.value = true

  try {
    const entries = await readDir(assetsDir)
    const referenced = referencedAbsPaths.value
    const found: OrphanEntry[] = []

    for (const entry of entries) {
      if (entry.isDirectory) continue
      if (!entry.name) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot === -1 || dot === entry.name.length - 1) continue
      const ext = entry.name.slice(dot + 1).toLowerCase()
      // paste 时若 file.type 为空 / 未知 MIME,旧版会把 ext 字面写成 '(null)';
      // 当前版本已改为 'bin'(imageStorage.saveImageAsset → mimeToExt 默认 'bin')。
      // 这三类都是实际图片,不能被孤儿过滤挡掉
      if (ext !== 'bin' && ext !== '(null)' && !isImageExt(ext)) continue

      const absPath = `${assetsDir}/${entry.name}`.replace(/\\/g, '/')
      if (referenced.has(absPath)) continue

      found.push({
        fileName: entry.name,
        absPath,
        displayUrl: convertFileSrc(absPath),
      })
    }

    // 按文件名排序
    found.sort((a, b) => a.fileName.localeCompare(b.fileName, 'zh'))
    orphans.value = found
  }
  catch {
    // assets 目录不存在或读取失败 → 无孤儿
    orphans.value = []
  }
  finally {
    orphanLoading.value = false
  }
}

function scheduleOrphanScan() {
  if (orphanScanTimer) clearTimeout(orphanScanTimer)
  orphanScanTimer = setTimeout(() => {
    orphanScanTimer = null
    void scanOrphans()
  }, 300)
}

// 监听 filePath + 文档本地图片集合变化 → debounced 重新扫描孤儿
watch(
  () => [props.filePath, JSON.stringify(localImages.value.map((e) => e.absPath))] as const,
  () => scheduleOrphanScan(),
)

onMounted(() => {
  void scanOrphans()
})

// ============================================================
//  折叠状态
// ============================================================

const docImagesCollapsed = ref(false)
const unreferencedCollapsed = ref(false)

// ============================================================
//  交互
// ============================================================

function onImageClick(entry: ImageEntry) {
  emit('locate-image', entry.src, entry.occurrence)
}

// ============================================================
//  右键菜单
// ============================================================

interface ContextMenuState {
  x: number
  y: number
  absPath: string
  /** 文档图片的 src（用于路径重写 / 复制相对路径）；孤儿为 null */
  src: string | null
}

const contextMenu = ref<ContextMenuState | null>(null)
const contextMenuRef = ref<InstanceType<typeof AssetContextMenu> | null>(null)

useContextMenu({
  isOpen: () => contextMenu.value !== null,
  getMenuEl: () => contextMenuRef.value?.rootEl ?? null,
  close: () => { contextMenu.value = null },
})

const isTauri = tauriOnly()

/** 是否允许"复制/移动到工作区"：需 Tauri + 有工作区 + 有 filePath + 文档在工作区内 */
const canReorganize = computed(() => {
  return isTauri
    && !!workspaceStore.activeRoot
    && !!props.filePath
    && isPathInRoot(props.filePath, workspaceStore.activeRoot)
})

const contextMenuDocName = computed(() => {
  return props.filePath ? docNameFromPath(props.filePath) : ''
})

function onContextMenu(event: MouseEvent, absPath: string, src: string | null) {
  const { x, y } = clampToViewport(event.clientX, event.clientY, 220, 340)
  contextMenu.value = { x, y, absPath, src }
}

/** 当前右键选中的资产绝对路径，用于高亮选中态 */
const selectedAbsPath = computed(() => contextMenu.value?.absPath ?? null)

function closeContextMenu() {
  contextMenu.value = null
}

// ========== 剪贴板操作 ==========

async function onCopyImage() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  try {
    const bytes = await readFile(absPath)
    // writeImage 直接传 raw bytes 会被 Rust 当作 RGBA 像素数据，报
    // "expected RGBA image data, found raw bytes"。需要先用 canvas 解码
    // 图片文件为 RGBA 像素，再构造 Tauri Image 对象传给 writeImage。
    const blob = new Blob([bytes])
    const bitmap = await createImageBitmap(blob)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    bitmap.close()
    const img = await TauriImage.new(
      new Uint8Array(imageData.data.buffer),
      canvas.width,
      canvas.height,
    )
    await writeImage(img)
  }
  catch (e) {
    console.error('复制图片失败', e)
  }
}

async function onCopyPath() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  await writeClipboardText(absPath)
}

async function onCopyRelativePath() {
  if (!contextMenu.value || !props.filePath) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  const docDir = dirnameSync(props.filePath)
  const normalizedDocDir = docDir.replace(/\\/g, '/')
  const normalizedAbs = absPath.replace(/\\/g, '/')
  if (normalizedAbs.startsWith(normalizedDocDir + '/')) {
    await writeClipboardText(normalizedAbs.slice(normalizedDocDir.length + 1))
  } else {
    await writeClipboardText(absPath)
  }
}

// ========== 重新组织到工作区 ==========

async function onCopyToWorkspace() {
  if (!contextMenu.value || !workspaceStore.activeRoot || !props.filePath) return
  const { absPath, src } = contextMenu.value
  closeContextMenu()
  try {
    const result = await reorganizeAsset({
      sourceAbsPath: absPath,
      currentFilePath: props.filePath,
      workspaceRoot: workspaceStore.activeRoot,
      mode: 'copy',
    })
    if (src !== null && result.moved) {
      emit('reorganize-asset', { oldAbsPath: absPath, newSrc: result.newSrc, mode: 'copy' })
    }
    scheduleOrphanScan()
  }
  catch (e) {
    console.error('复制资产失败', e)
  }
}

async function onMoveToWorkspace() {
  if (!contextMenu.value || !workspaceStore.activeRoot || !props.filePath) return
  const { absPath, src } = contextMenu.value
  closeContextMenu()
  try {
    const result = await reorganizeAsset({
      sourceAbsPath: absPath,
      currentFilePath: props.filePath,
      workspaceRoot: workspaceStore.activeRoot,
      mode: 'move',
    })
    if (src !== null && result.moved) {
      emit('reorganize-asset', { oldAbsPath: absPath, newSrc: result.newSrc, mode: 'move' })
    }
    scheduleOrphanScan()
  }
  catch (e) {
    console.error('移动资产失败', e)
  }
}

// ========== 另存为 ==========

async function onSaveAs() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  const fileName = basenameSync(absPath)
  try {
    const targetPath = await dialogSave({ defaultPath: fileName })
    if (!targetPath) return
    await copyFile(absPath, targetPath)
  }
  catch (e) {
    console.error('另存为失败', e)
  }
}

// ========== 删除 ==========

async function onDelete() {
  if (!contextMenu.value) return
  const { absPath, src } = contextMenu.value
  const fileName = basenameSync(absPath)
  closeContextMenu()
  const ok = await dialogConfirm(`确定要删除「${fileName}」吗？`, { title: '确认删除', kind: 'warning' })
  if (!ok) return
  try {
    await remove(absPath)
    // 如果是文档引用的图片，通知 App.vue 从 PM doc 中移除对应 image 节点
    if (src !== null) {
      emit('reorganize-asset', { oldAbsPath: absPath, newSrc: '', mode: 'move' })
    }
    scheduleOrphanScan()
  }
  catch (e) {
    notify.error(`删除失败:${e instanceof Error ? e.message : String(e)}`)
  }
}

// ========== 在资源管理器中显示 ==========

async function onReveal() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  try {
    await revealItemInDir(absPath)
  }
  catch (e) {
    console.error('在资源管理器中显示失败', e)
  }
}

// ============================================================
//  缩略图错误兜底
// ============================================================

const brokenThumbs = ref(new Set<string>())

function onThumbError(src: string) {
  brokenThumbs.value.add(src)
}

// ============================================================
//  拖拽源:图片条目 → 编辑器
// ============================================================

/** 孤儿图片的 markdown src:孤儿扫描自 <docDir>/assets/,相对路径即 assets/<fileName>。
 *  无 filePath(理论不会出现,孤儿扫描需 filePath)时回退绝对路径。 */
function orphanToSrc(orphan: OrphanEntry): string {
  return props.filePath ? `assets/${orphan.fileName}` : orphan.absPath
}

/** 把图片条目拖到编辑器:写入 ASSET_IMAGE_MIME(JSON { src, alt }),编辑器侧
 *  直接插 image 节点 / markdown 文本,不落盘(图片已在磁盘上 / 是外链 URL)。
 *  不写 text/plain —— 防止 drop 未被接管时 PM 把 src 串当文本插入。 */
function onAssetDragStart(event: DragEvent, src: string, alt: string) {
  if (!event.dataTransfer) return
  closeContextMenu()
  event.dataTransfer.setData(ASSET_IMAGE_MIME, JSON.stringify({ src, alt }))
  event.dataTransfer.effectAllowed = 'copy'
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 滚动内容(无顶部标题栏,直接展示折叠分组) -->
    <div v-velo-scroll class="min-h-0 flex-1 overflow-y-auto">
      <!-- 空态 -->
      <div
        v-if="allImages.length === 0 && orphans.length === 0 && !orphanLoading"
        class="flex h-full flex-col items-center justify-center gap-2 px-4 text-gray-400 dark:text-gray-600"
      >
        <ImageIcon :size="32" :stroke-width="1.2" />
        <span class="text-xs">当前文档没有图片</span>
      </div>

      <template v-else>
        <!-- ========== 文档图片 ========== -->
        <div v-if="allImages.length > 0" class="asset-section">
          <button
            type="button"
            class="asset-section__header"
            @click="docImagesCollapsed = !docImagesCollapsed"
          >
            <ChevronRight
              :size="12"
              class="asset-section__chevron"
              :style="{ transform: docImagesCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }"
            />
            <ImageIcon :size="12" />
            <span>文档图片</span>
            <span class="asset-section__count">{{ allImages.length }}</span>
          </button>

          <template v-if="!docImagesCollapsed">
            <!-- 本地图片 -->
            <div v-if="localImages.length > 0" class="asset-subgroup">
              <div class="asset-subgroup__label">本地 ({{ localImages.length }})</div>
              <button
                v-for="img in localImages"
                :key="`local-${img.occurrence}-${img.src}`"
                type="button"
                draggable="true"
                :class="['asset-item', { 'asset-item--selected': selectedAbsPath === img.absPath }]"
                :title="img.src + (img.alt ? ` — ${img.alt}` : '')"
                @click="onImageClick(img)"
                @contextmenu.prevent="onContextMenu($event, img.absPath!, img.src)"
                @dragstart="onAssetDragStart($event, img.src, img.alt)"
              >
                <div class="asset-item__thumb">
                  <img
                    v-if="!brokenThumbs.has(img.displayUrl)"
                    :src="img.displayUrl"
                    :alt="img.alt"
                    loading="lazy"
                    class="asset-item__img"
                    @error="onThumbError(img.displayUrl)"
                  >
                  <ImageIcon v-else :size="14" class="text-gray-400" />
                </div>
                <div class="asset-item__info">
                  <span class="asset-item__name">{{ img.label }}</span>
                  <span v-if="img.alt" class="asset-item__alt">{{ img.alt }}</span>
                </div>
              </button>
            </div>

            <!-- 外链图片 -->
            <div v-if="externalImages.length > 0" class="asset-subgroup">
              <div class="asset-subgroup__label">
                <ExternalLink :size="11" />
                外链 ({{ externalImages.length }})
              </div>
              <button
                v-for="img in externalImages"
                :key="`ext-${img.occurrence}-${img.src}`"
                type="button"
                draggable="true"
                class="asset-item"
                :title="img.src + (img.alt ? ` — ${img.alt}` : '')"
                @click="onImageClick(img)"
                @dragstart="onAssetDragStart($event, img.src, img.alt)"
              >
                <div class="asset-item__thumb">
                  <img
                    v-if="!brokenThumbs.has(img.displayUrl)"
                    :src="img.displayUrl"
                    :alt="img.alt"
                    loading="lazy"
                    class="asset-item__img"
                    @error="onThumbError(img.displayUrl)"
                  >
                  <ImageIcon v-else :size="14" class="text-gray-400" />
                </div>
                <div class="asset-item__info">
                  <span class="asset-item__name">{{ img.label }}</span>
                  <span v-if="img.alt" class="asset-item__alt">{{ img.alt }}</span>
                </div>
              </button>
            </div>
          </template>
        </div>

        <!-- ========== 未被引用的图片文件 ========== -->
        <div v-if="orphans.length > 0" class="asset-section">
          <button
            type="button"
            class="asset-section__header"
            @click="unreferencedCollapsed = !unreferencedCollapsed"
          >
            <ChevronRight
              :size="12"
              class="asset-section__chevron"
              :style="{ transform: unreferencedCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }"
            />
            <Unlink :size="12" />
            <span>未被引用的图片文件</span>
            <span class="asset-section__count">{{ orphans.length }}</span>
          </button>
          <div v-if="!unreferencedCollapsed" class="asset-subgroup">
            <div
              v-for="orphan in orphans"
              :key="orphan.absPath"
              draggable="true"
              :class="['asset-item', { 'asset-item--selected': selectedAbsPath === orphan.absPath }]"
              :title="orphan.fileName"
              @contextmenu.prevent="onContextMenu($event, orphan.absPath, null)"
              @dragstart="onAssetDragStart($event, orphanToSrc(orphan), orphan.fileName)"
            >
              <div class="asset-item__thumb">
                <img
                  v-if="!brokenThumbs.has(orphan.displayUrl)"
                  :src="orphan.displayUrl"
                  :alt="orphan.fileName"
                  loading="lazy"
                  class="asset-item__img"
                  @error="onThumbError(orphan.displayUrl)"
                >
                <ImageIcon v-else :size="14" class="text-gray-400" />
              </div>
              <div class="asset-item__info">
                <span class="asset-item__name">{{ orphan.fileName }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 未被引用图片扫描中 -->
        <div v-if="orphanLoading && orphans.length === 0" class="px-3 py-2 text-[10px] text-gray-400">
          扫描资产目录...
        </div>
      </template>
    </div>
    <!-- 右键上下文菜单 -->
    <AssetContextMenu
      v-if="contextMenu"
      ref="contextMenuRef"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :can-reorganize="canReorganize"
      :doc-name="contextMenuDocName"
      :is-tauri="isTauri"
      :has-src="!!props.filePath"
      @copy-image="onCopyImage"
      @copy-path="onCopyPath"
      @copy-relative-path="onCopyRelativePath"
      @copy-to-workspace="onCopyToWorkspace"
      @move-to-workspace="onMoveToWorkspace"
      @save-as="onSaveAs"
      @delete="onDelete"
      @reveal="onReveal"
    />
  </div>
</template>

<style scoped>
.asset-section {
  padding-bottom: 4px;
}

.asset-section__header {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 0.5em 1em;
  font-size: 12px;
  font-weight: 600;
  color: var(--chrome-text-primary);
  cursor: pointer;
  transition: background-color 120ms ease;
  text-align: left;
  border: none;
  background: none;
}

.asset-section__header:hover {
  background: rgb(243 244 246); /* gray-100 */
}

.dark .asset-section__header {
  color: var(--chrome-text-secondary);
}

.dark .asset-section__header:hover {
  background: rgb(31 41 55 / 0.5); /* gray-800/50 */
}

.asset-section__chevron {
  flex-shrink: 0;
  transition: transform 120ms ease;
  color: var(--chrome-text-secondary);
}

.asset-section__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: rgb(209 213 219); /* gray-300 */
  font-size: 9px;
  font-weight: 600;
  color: var(--chrome-text-secondary);
}

.dark .asset-section__count {
  background: rgb(55 65 81); /* gray-700 */
  color: var(--chrome-text-secondary);
}

.asset-subgroup {
  padding: 0 4px;
}

.asset-subgroup__label {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 8px 2px;
  font-size: 10px;
  color: var(--chrome-text-secondary);
}

.dark .asset-subgroup__label {
  color: var(--chrome-text-secondary);
}

.asset-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease;
  text-align: left;
}

.asset-item:hover {
  background: rgb(243 244 246); /* gray-100 */
}

.dark .asset-item:hover {
  background: rgb(31 41 55 / 0.5); /* gray-800/50 */
}

/* 右键选中态：复用 hover 底色 + 字体加粗，与 hover 区分靠 font-weight */
.asset-item.asset-item--selected,
.asset-item.asset-item--selected:hover {
  background: rgb(243 244 246); /* gray-100 */
}

.dark .asset-item.asset-item--selected,
.dark .asset-item.asset-item--selected:hover {
  background: rgb(31 41 55 / 0.5); /* gray-800/50 */
}


.asset-item__thumb {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 4px;
  background: rgb(243 244 246); /* gray-100 */
  overflow: hidden;
}

.dark .asset-item__thumb {
  background: var(--chrome-text-active);
}

.asset-item__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.asset-item__info {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.asset-item__name {
  font-size: 12px;
  color: var(--chrome-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .asset-item__name {
  color: var(--chrome-text-primary);
}

.asset-item__alt {
  font-size: 10px;
  color: var(--chrome-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .asset-item__alt {
  color: var(--chrome-text-secondary);
}
</style>

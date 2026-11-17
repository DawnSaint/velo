<script setup lang="ts">
// 图片资产面板:
//  - 扫描当前文档 markdown 中的所有 image 引用 `![alt](src "title")`
//  - 分组:失效引用(本地文件不存在/无法加载)/ 本地图片 / 外链(http/https/data:)
//  - 点击条目 → emit('locate-image', src, occurrence) → App.vue
//    走 PM doc NodeSelection + scrollIntoView 定位
//  - 失效引用:fs.exists 判定文件缺失(Tauri),缩略图加载失败兜底(web dev /
//    文件损坏);右键 → 重新链接(选新文件改写 src)/ 移除引用(删 image 节点)
//  - 右键本地图片 → 预览(lightbox)/ 复制/移动到工作区 assets/<docName>/,
//    编辑器引用路径同步重写;双击条目直接预览
//
// 扫描走 markdown 字符串正则(非 PM doc),因为 Sidebar 不可达 PM view;
// 点击定位时 App.vue 负责在 PM doc 里按 src + occurrence 匹配节点。
//
// 不做"未被引用图片"统计:跨文档引用判定不可靠(引用式链接/HTML/工作区外
// 文档都会误报),且低频清理需求不值得常驻扫描。工作区图片浏览走文件树预览。

import { computed, onMounted, ref, watch } from 'vue'
import { Image as ImageIcon, ImageOff, ExternalLink, Unlink, ChevronRight } from '@lucide/vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { exists, remove, copyFile, tauriOnly } from '@/tauri/fs'
import { open as dialogOpen, save as dialogSave } from '@/tauri/dialog'
import { resolveImageAssetAbsPath, dirnameSync, IMAGE_EXTS } from '@/utils/imagePath'
import { reorganizeAsset, docNameFromPath, isPathInRoot } from '@/utils/assetReorganize'
import { writeClipboardText, writeClipboardImage } from '@/utils/clipboard'
import { useWorkspaceStore } from '@/stores/workspace'
import { useNotifyStore } from '@/stores/notify'
import { useConfirmStore } from '@/stores/confirm'
import { useImagePreviewStore } from '@/stores/imagePreview'
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

// ============================================================
//  失效引用检测
// ============================================================

/** fs.exists 确认不存在的本地 absPath 集合 */
const missingPaths = ref(new Set<string>())
/** 缩略图加载失败的 displayUrl 集合(web dev 降级 + 文件损坏兜底) */
const brokenThumbs = ref(new Set<string>())

let existCheckTimer: ReturnType<typeof setTimeout> | null = null
let existCheckToken = 0

async function checkExistence() {
  if (!tauriOnly()) return
  const token = ++existCheckToken
  const paths = [...new Set(localImages.value.flatMap((e) => e.absPath ? [e.absPath] : []))]
  const next = new Set<string>()
  await Promise.all(paths.map(async (p) => {
    try {
      if (!(await exists(p))) next.add(p)
    }
    catch { /* 查不到状态 ≠ 不存在,不误报 */ }
  }))
  if (token === existCheckToken) missingPaths.value = next
}

function scheduleExistenceCheck() {
  if (existCheckTimer) clearTimeout(existCheckTimer)
  existCheckTimer = setTimeout(() => {
    existCheckTimer = null
    void checkExistence()
  }, 300)
}

watch(
  () => [props.filePath, localImages.value.map((e) => e.absPath).join('|')] as const,
  () => scheduleExistenceCheck(),
)

onMounted(() => {
  void checkExistence()
})

function isBroken(e: ImageEntry): boolean {
  return e.absPath !== null
    && (missingPaths.value.has(e.absPath) || brokenThumbs.value.has(e.displayUrl))
}

function brokenReason(e: ImageEntry): string {
  return e.absPath !== null && missingPaths.value.has(e.absPath) ? '文件不存在' : '无法加载'
}

const brokenImages = computed(() => localImages.value.filter(isBroken))
const okLocalImages = computed(() => localImages.value.filter((e) => !isBroken(e)))

function onThumbError(src: string) {
  brokenThumbs.value.add(src)
}

// ============================================================
//  折叠状态
// ============================================================

const docImagesCollapsed = ref(false)
const brokenCollapsed = ref(false)

// ============================================================
//  交互
// ============================================================

function onImageClick(entry: ImageEntry) {
  emit('locate-image', entry.src, entry.occurrence)
}

/** 预览:文档内所有未失效图片(去重)作为一组,lightbox ←→ 切换 */
function openPreview(entry: ImageEntry) {
  const seen = new Set<string>()
  const list = allImages.value.filter((e) => {
    if (isBroken(e) || seen.has(e.displayUrl)) return false
    seen.add(e.displayUrl)
    return true
  })
  const idx = list.findIndex((e) => e.displayUrl === entry.displayUrl)
  if (idx === -1) return
  useImagePreviewStore().open(
    list.map((e) => ({ url: e.displayUrl, name: e.label, absPath: e.absPath })),
    idx,
  )
}

// ============================================================
//  右键菜单
// ============================================================

interface ContextMenuState {
  x: number
  y: number
  absPath: string
  /** 文档图片的 src（用于路径重写 / 复制相对路径） */
  src: string | null
  /** 失效引用条目:菜单换成 重新链接 / 移除引用 */
  broken: boolean
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

function onContextMenu(event: MouseEvent, absPath: string, src: string | null, broken = false) {
  const { x, y } = clampToViewport(event.clientX, event.clientY, 220, 340)
  contextMenu.value = { x, y, absPath, src, broken }
}

/** 当前右键选中的资产绝对路径，用于高亮选中态 */
const selectedAbsPath = computed(() => contextMenu.value?.absPath ?? null)

function closeContextMenu() {
  contextMenu.value = null
}

// ========== 预览 ==========

function onPreviewFromMenu() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  const entry = allImages.value.find((e) => e.absPath === absPath && !isBroken(e))
  if (entry) openPreview(entry)
}

// ========== 剪贴板操作 ==========

async function onCopyImage() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  try {
    await writeClipboardImage(absPath)
  }
  catch (e) {
    console.error('复制图片失败', e)
    notify.error(`复制图片失败:${e instanceof Error ? e.message : String(e)}`)
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

// ========== 失效引用:重新链接 / 移除引用 ==========

/** 选一张新图片,把文档中所有引用旧 absPath 的 image 节点 src 改写过去。
 *  新文件在 docDir 下 → 相对路径;否则绝对路径(跨盘符也能解析)。 */
async function onRelink() {
  if (!contextMenu.value || !props.filePath) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  try {
    const picked = await dialogOpen({
      multiple: false,
      filters: [{ name: '图片', extensions: [...IMAGE_EXTS] }],
    })
    if (!picked || typeof picked !== 'string') return
    const newAbs = picked.replace(/\\/g, '/')
    const docDir = dirnameSync(props.filePath).replace(/\\/g, '/')
    const newSrc = newAbs.startsWith(docDir + '/') ? newAbs.slice(docDir.length + 1) : newAbs
    emit('reorganize-asset', { oldAbsPath: absPath, newSrc, mode: 'copy' })
    scheduleExistenceCheck()
  }
  catch (e) {
    notify.error(`重新链接失败:${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 只删文档里的 image 节点,不动磁盘文件(文件本就缺失/损坏);可 Ctrl+Z 撤销 */
function onRemoveReference() {
  if (!contextMenu.value) return
  const { absPath } = contextMenu.value
  closeContextMenu()
  emit('reorganize-asset', { oldAbsPath: absPath, newSrc: '', mode: 'move' })
  scheduleExistenceCheck()
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
    scheduleExistenceCheck()
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
    scheduleExistenceCheck()
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
  const ok = await useConfirmStore().ask({
    title: '确认删除',
    message: src !== null
      ? `确定要删除「${fileName}」吗？文档中引用该图片的位置也会一并移除。`
      : `确定要删除「${fileName}」吗？删除后无法恢复。`,
    detail: absPath,
    confirmText: '删除',
    cancelText: '取消',
    kind: 'danger',
  })
  if (!ok) return
  try {
    await remove(absPath)
    // 如果是文档引用的图片，通知 App.vue 从 PM doc 中移除对应 image 节点
    if (src !== null) {
      emit('reorganize-asset', { oldAbsPath: absPath, newSrc: '', mode: 'move' })
    }
    scheduleExistenceCheck()
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
//  拖拽源:图片条目 → 编辑器
// ============================================================

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
        v-if="allImages.length === 0"
        class="flex h-full flex-col items-center justify-center gap-2 px-4 text-gray-400 dark:text-gray-600"
      >
        <ImageIcon :size="32" :stroke-width="1.2" />
        <span class="text-xs">当前文档没有图片</span>
      </div>

      <template v-else>
        <!-- ========== 失效引用 ========== -->
        <div v-if="brokenImages.length > 0" class="asset-section">
          <button
            type="button"
            class="asset-section__header asset-section__header--warn"
            data-testid="broken-section-header"
            @click="brokenCollapsed = !brokenCollapsed"
          >
            <ChevronRight
              :size="12"
              class="asset-section__chevron"
              :style="{ transform: brokenCollapsed ? 'rotate(0deg)' : 'rotate(90deg)' }"
            />
            <Unlink :size="12" />
            <span>失效引用</span>
            <span class="asset-section__count asset-section__count--warn">{{ brokenImages.length }}</span>
          </button>
          <div v-if="!brokenCollapsed" class="asset-subgroup">
            <div
              v-for="img in brokenImages"
              :key="`broken-${img.occurrence}-${img.src}`"
              :class="['asset-item', 'asset-item--broken', { 'asset-item--selected': selectedAbsPath === img.absPath }]"
              :title="img.src"
              data-testid="broken-item"
              @click="onImageClick(img)"
              @contextmenu.prevent="onContextMenu($event, img.absPath!, img.src, true)"
            >
              <div class="asset-item__thumb asset-item__thumb--broken">
                <ImageOff :size="14" class="text-amber-500" />
              </div>
              <div class="asset-item__info">
                <span class="asset-item__name">{{ img.label }}</span>
                <span class="asset-item__alt asset-item__alt--warn">{{ brokenReason(img) }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ========== 文档图片 ========== -->
        <div v-if="okLocalImages.length > 0 || externalImages.length > 0" class="asset-section">
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
            <span class="asset-section__count">{{ okLocalImages.length + externalImages.length }}</span>
          </button>

          <template v-if="!docImagesCollapsed">
            <!-- 本地图片 -->
            <div v-if="okLocalImages.length > 0" class="asset-subgroup">
              <div class="asset-subgroup__label">本地 ({{ okLocalImages.length }})</div>
              <button
                v-for="img in okLocalImages"
                :key="`local-${img.occurrence}-${img.src}`"
                type="button"
                draggable="true"
                :class="['asset-item', { 'asset-item--selected': selectedAbsPath === img.absPath }]"
                :title="img.src + (img.alt ? ` — ${img.alt}` : '')"
                @click="onImageClick(img)"
                @dblclick="openPreview(img)"
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
                  <ImageOff v-else :size="14" class="text-gray-400" />
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
                @dblclick="openPreview(img)"
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
                  <ImageOff v-else :size="14" class="text-gray-400" />
                </div>
                <div class="asset-item__info">
                  <span class="asset-item__name">{{ img.label }}</span>
                  <span v-if="img.alt" class="asset-item__alt">{{ img.alt }}</span>
                </div>
              </button>
            </div>
          </template>
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
      :broken="contextMenu.broken"
      :can-preview="!contextMenu.broken"
      @preview="onPreviewFromMenu"
      @copy-image="onCopyImage"
      @copy-path="onCopyPath"
      @copy-relative-path="onCopyRelativePath"
      @relink="onRelink"
      @remove-reference="onRemoveReference"
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

.asset-section__header--warn {
  color: rgb(180 83 9); /* amber-700 */
}

.dark .asset-section__header--warn {
  color: rgb(251 191 36); /* amber-400 */
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

.asset-section__count--warn {
  background: rgb(254 243 199); /* amber-100 */
  color: rgb(180 83 9); /* amber-700 */
}

.dark .asset-section__count--warn {
  background: rgb(120 53 15 / 0.4); /* amber-900/40 */
  color: rgb(251 191 36); /* amber-400 */
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

.asset-item__thumb--broken {
  background: rgb(254 243 199); /* amber-100 */
}

.dark .asset-item__thumb--broken {
  background: rgb(120 53 15 / 0.3); /* amber-900/30 */
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

.asset-item__alt--warn {
  color: rgb(180 83 9); /* amber-700 */
}

.dark .asset-item__alt--warn {
  color: rgb(251 191 36); /* amber-400 */
}
</style>
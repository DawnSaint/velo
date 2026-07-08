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
//
// 扫描走 markdown 字符串正则(非 PM doc),因为 Sidebar 不可达 PM view;
// 点击定位时 App.vue 负责在 PM doc 里按 src + occurrence 匹配节点。
//
// 未被引用图片扫描走 Tauri fs.readDir,dev web 端降级为只显示文档图片。

import { computed, onMounted, ref, watch } from 'vue'
import { Image as ImageIcon, ExternalLink, Unlink, ChevronRight } from '@lucide/vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { readDir, tauriOnly } from '@/tauri/fs'
import { resolveImageAssetAbsPath, dirnameSync, isImageExt } from '@/utils/imagePath'

const props = defineProps<{
  modelValue: string
  filePath: string | null
}>()

const emit = defineEmits<{
  'locate-image': [src: string, occurrence: number]
}>()

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
  return s.replace(/\\([\[\]()])/g, '$1')
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

    // 链接目标里括号会被 escapeMdUrl 写成 `\(` `\)`,正则 `[^)\s]+` 遇到
    // 第一个 `)` 就会截断,导致 src 解析失败。先把 `\(` `\)` 分别替换成
    // 两个路径里几乎不可能出现的 ASCII 占位标记 `__LPAR__` / `__RPAR__`,
    // 链接结束的裸 `)` 照常匹配占截断位。提取 src 后再把占位符还原回裸括号。
    cleaned = cleaned.replace(/\\\(/g, '__LPAR__').replace(/\\\)/g, '__RPAR__')

    const regex = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g
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
  // 按 src 统计 occurrence
  const srcCount = new Map<string, number>()
  return raw.map((img) => {
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
//  缩略图错误兜底
// ============================================================

const brokenThumbs = ref(new Set<string>())

function onThumbError(src: string) {
  brokenThumbs.value.add(src)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 滚动内容(无顶部标题栏,直接展示折叠分组) -->
    <div class="min-h-0 flex-1 overflow-y-auto">
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
                class="asset-item"
                :title="img.src + (img.alt ? ` — ${img.alt}` : '')"
                @click="onImageClick(img)"
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
                class="asset-item"
                :title="img.src + (img.alt ? ` — ${img.alt}` : '')"
                @click="onImageClick(img)"
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
          <template v-if="!unreferencedCollapsed">
            <div
              v-for="orphan in orphans"
              :key="orphan.absPath"
              class="asset-item"
              :title="orphan.fileName"
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
          </template>
        </div>

        <!-- 未被引用图片扫描中 -->
        <div v-if="orphanLoading && orphans.length === 0" class="px-3 py-2 text-[10px] text-gray-400">
          扫描资产目录...
        </div>
      </template>
    </div>
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
  color: rgb(75 85 99); /* gray-600 */
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
  color: rgb(156 163 175); /* gray-400 */
}

.dark .asset-section__header:hover {
  background: rgb(31 41 55 / 0.5); /* gray-800/50 */
}

.asset-section__chevron {
  flex-shrink: 0;
  transition: transform 120ms ease;
  color: rgb(156 163 175); /* gray-400 */
}

.asset-section__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: rgb(229 231 235); /* gray-200 */
  font-size: 9px;
  font-weight: 600;
  color: rgb(107 114 128); /* gray-500 */
}

.dark .asset-section__count {
  background: rgb(55 65 81); /* gray-700 */
  color: rgb(156 163 175); /* gray-400 */
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
  color: rgb(156 163 175); /* gray-400 */
}

.dark .asset-subgroup__label {
  color: rgb(107 114 128); /* gray-500 */
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
  background: rgb(31 41 55); /* gray-800 */
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
  color: rgb(55 65 81); /* gray-700 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .asset-item__name {
  color: rgb(209 213 219); /* gray-300 */
}

.asset-item__alt {
  font-size: 10px;
  color: rgb(156 163 175); /* gray-400 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dark .asset-item__alt {
  color: rgb(107 114 128); /* gray-500 */
}
</style>

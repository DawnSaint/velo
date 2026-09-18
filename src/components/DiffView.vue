<script setup lang="ts">
// DiffView(#local-timeline):编辑器区 diff 视图。
// 当用户在侧栏 VersionHistoryPanel 选中某条目时,编辑器区切换为 DiffView,
// 展示该版本与其前一版本的行级 diff(同 VSCode Local History 语义)。
// 顶部工具栏:
//  - 左:版本时间 + diff 行数统计
//  - 右:「恢复」/「回退修改」+「关闭」(回到编辑器)
//
// 选中虚拟"未保存"条目(UNSAVED_ID)时显示「回退修改」按钮(回退到上一版本)。
// 选中 Git 条目时不显示「恢复」按钮(Git commit 不可直接恢复为编辑器内容)。
//
// Git 条目的 content 和前一版本 content 都可能需要异步加载(git show),
// 加载期间显示 loading spinner。
//
// 双模式(#diff-switch):
// - 源码 diff(sourceMode=true):行级列表,+/- 前缀,行背景色区分增删(原有实现)
// - 预览 diff(sourceMode=false):ProseMirror 只读渲染 + Decoration 增删标记(绿色背景=新增,红色背景=删除)
// 两种模式共用同一 diff 算法结果(Myers),切换不重算 diff。
// 模式切换复用底部状态栏的 sourceMode toggle(Eye/Code2 按钮)。

import { computed, ref, watch } from 'vue'
import { X, Loader2, Undo2 } from '@lucide/vue'
import { useVersionHistoryStore, UNSAVED_ID } from '@/stores/versionHistory'
import { useDocumentStore } from '@/stores/document'
import { useEditorStore } from '@/stores/editor'
import { diffLines, isPureCharRemoval, type DiffLine } from '@/utils/lineDiff'
import type { TimelineEntry } from '@/stores/versionHistory'
import WysiwygDiffView from '@/components/ProseMirrorEditor/WysiwygDiffView.vue'

const versionHistory = useVersionHistoryStore()
const documentStore = useDocumentStore()
const editorStore = useEditorStore()

const emit = defineEmits<{
  'restore': [snapshot: TimelineEntry]
  'revert': [filePath: string, content: string]
}>()

const selected = computed<TimelineEntry | null>(() => versionHistory.selectedEntry)
const isSelectedUnsaved = computed(() => versionHistory.selectedEntryId === UNSAVED_ID)
const isSelectedGit = computed(() => selected.value?.source === 'git')

// diff 模式复用 documentStore.sourceMode:
// false = WYSIWYG 预览 diff; true = 源码行级 diff
// 状态栏的 Eye/Code2 按钮控制切换,不在此组件内自建按钮
const isSourceMode = computed(() => documentStore.sourceMode)

// ========== diff 数据 ==========

/** diff 结果(异步加载 Git content 时有 loading 态) */
const diffResult = ref<DiffLine[]>([])
/** 新版本和旧版本的原始 markdown(供 WYSIWYG diff 使用) */
const newContent = ref('')
const oldContent = ref('')
const loading = ref(false)

/** diff 行数统计 */
const diffStats = computed(() => {
  let added = 0
  let removed = 0
  for (const line of diffResult.value) {
    if (line.type === 'added') added++
    else if (line.type === 'removed') removed++
  }
  return { added, removed }
})

/** 源码模式展示行:「修改」配对(removed+added)合并为单行渲染,
 * 跳过被合并的 removed 行(VSCode inline diff 风格:
 * 整行浅绿 + 新增字符深绿 + 删除字符红色删除线) */
const displayRows = computed(() => diffResult.value.filter(l => !l.mergedIntoNext))

interface RowVisual {
  bg: string
  prefix: string
  prefixClass: string
  textClass: string
  lineNo: string
}

/** 源码行视觉(收敛到函数,模板不再重复判断 isPureCharRemoval) */
function rowVisual(line: DiffLine): RowVisual {
  if (line.type === 'removed' || isPureCharRemoval(line)) {
    return {
      bg: 'bg-red-50 dark:bg-red-950/30',
      prefix: '-',
      prefixClass: 'text-red-600 dark:text-red-400',
      textClass: 'text-red-700 dark:text-red-300',
      lineNo: String(line.oldLineNumber || ''),
    }
  }
  if (line.type === 'added') {
    return {
      bg: 'bg-green-50 dark:bg-green-950/30',
      prefix: '+',
      prefixClass: 'text-green-600 dark:text-green-400',
      textClass: 'text-green-700 dark:text-green-300',
      lineNo: String(line.newLineNumber ?? ''),
    }
  }
  return {
    bg: '',
    prefix: ' ',
    prefixClass: 'text-gray-300 dark:text-gray-600',
    textClass: 'text-gray-600 dark:text-gray-300',
    lineNo: String(line.oldLineNumber || ''),
  }
}

/** 异步加载 diff:选中条目变化时触发
 *  - 本地快照:content 和前一版本 content 都在内存中,同步计算
 *  - Git 条目:content 可能需要 git show 懒加载,前一版本 content 也可能需要 */
async function loadDiff() {
  const entry = selected.value
  if (!entry) {
    diffResult.value = []
    newContent.value = ''
    oldContent.value = ''
    return
  }

  loading.value = true
  try {
    let newContentRaw: string
    if (entry.source === 'git') {
      newContentRaw = await versionHistory.loadGitContent(entry)
    } else {
      newContentRaw = entry.content ?? ''
    }

    const oldResult = await versionHistory.diffOldContentAsync(entry.id)
    const oldContentRaw = oldResult.content ?? ''

    // 两种模式共用同一 diff 结果
    diffResult.value = diffLines(oldContentRaw, newContentRaw)
    newContent.value = newContentRaw
    oldContent.value = oldContentRaw
  }
  catch (e) {
    console.error('loadDiff 失败', e)
    diffResult.value = []
    newContent.value = ''
    oldContent.value = ''
  }
  finally {
    loading.value = false
  }
}

// 选中条目变化时重新加载 diff
watch(() => versionHistory.selectedEntryId, () => {
  loadDiff()
}, { immediate: true })

// Git content 缓存变化时重新加载(gitContentCache 写入后 displayEntries 重算,
// selectedEntry 可能拿到新对象。但此时 loading 为 true 的会被跳过,
// 等 loadDiff 完成后 loading 变 false,如果 content 变了再触发一次)
watch(() => selected.value?.content, (newVal, oldVal) => {
  if (!loading.value && newVal !== oldVal) loadDiff()
})

function formatTime(ts: number): string {
  const date = new Date(ts)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${month}-${day} ${hh}:${mm}:${ss}`
}

function onRestore() {
  const entry = selected.value
  if (!entry) return
  emit('restore', entry)
  versionHistory.closeDiffView()
}

/** 回退未保存修改:把编辑器内容恢复到上一版本(已保存内容) */
async function onRevert() {
  const entry = selected.value
  if (!entry) return
  const oldResult = await versionHistory.diffOldContentAsync(entry.id)
  const oldContent = oldResult.content ?? ''
  emit('revert', entry.filePath, oldContent)
  versionHistory.closeDiffView()
}

function onClose() {
  versionHistory.closeDiffView()
}
</script>

<template>
  <!-- 根节点注入 --md-font-size:源码 diff 列表与 WYSIWYG diff(.velo-editor)
       都读这个变量,跟随设置面板的字号 -->
  <div
    class="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--surface-2)]"
    :style="{ '--md-font-size': editorStore.fontSize }"
  >
    <!-- 工具栏 -->
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--surface-border)] px-4 py-2">
      <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span v-if="selected" class="flex items-center gap-1.5">
          <!-- 未保存条目 -->
          <template v-if="isSelectedUnsaved">
            <span class="font-medium text-gray-700 dark:text-gray-200">未保存内容</span>
          </template>
          <!-- Git 条目 -->
          <template v-else-if="isSelectedGit">
            <span class="truncate font-medium text-gray-700 dark:text-gray-200">{{ selected.git?.subject }}</span>
            <span class="shrink-0 font-mono text-[11px] text-orange-600 dark:text-orange-400">{{ selected.git?.shortHash }}</span>
          </template>
          <!-- 本地快照 -->
          <template v-else>
            <span class="font-medium text-gray-700 dark:text-gray-200">{{ formatTime(selected.timestamp) }}</span>
          </template>
        </span>
        <span
          v-if="!loading && (diffStats.added > 0 || diffStats.removed > 0)"
          class="tabular-nums"
        >
          <span class="text-green-600 dark:text-green-400">+{{ diffStats.added }}</span>
          <span class="ml-1.5 text-red-600 dark:text-red-400">-{{ diffStats.removed }}</span>
        </span>
        <span v-else-if="!loading" class="text-gray-400">内容一致</span>
      </div>
      <div class="flex items-center gap-2">
        <!-- 本地快照:显示「恢复」 -->
        <button
          v-if="!isSelectedUnsaved && !isSelectedGit"
          class="rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          :disabled="!selected"
          @click="onRestore"
        >
          恢复此版本
        </button>
        <!-- 未保存条目:显示「回退修改」 -->
        <button
          v-else-if="isSelectedUnsaved"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-gray-500 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          :disabled="!selected"
          @click="onRevert"
        >
          <Undo2 class="h-3.5 w-3.5" />
          回退修改
        </button>
        <button
          class="rounded-md p-1 text-gray-400 transition-colors hover:bg-[var(--surface-hover)] hover:text-gray-600 dark:hover:text-gray-300"
          title="关闭 diff 视图"
          @click="onClose"
        >
          <X class="h-4 w-4" />
        </button>
      </div>
    </div>

    <!-- diff 内容 -->
    <div v-velo-scroll class="min-h-0 flex-1 overflow-y-auto">
      <!-- loading 态 -->
      <div
        v-if="loading"
        class="flex h-full items-center justify-center"
      >
        <Loader2 class="h-5 w-5 animate-spin text-gray-300 dark:text-gray-600" />
      </div>
      <!-- WYSIWYG diff 模式(sourceMode=false) -->
      <WysiwygDiffView
        v-else-if="!isSourceMode && newContent"
        :new-content="newContent"
        :old-content="oldContent"
      />
      <!-- 源码 diff 模式(sourceMode=true) -->
      <template v-else>
        <!-- 空结果 -->
        <div
          v-if="diffResult.length === 0"
          class="flex h-full items-center justify-center text-xs text-gray-400"
        >
          <span>无 diff 内容</span>
        </div>
        <!-- diff 结果:字号走 --md-font-size(跟随设置),不再是写死的 text-xs -->
        <div
          v-else
          class="font-mono leading-relaxed"
          style="font-size: var(--md-font-size, 14px)"
        >
          <div
            v-for="(line, idx) in displayRows"
            :key="idx"
            class="flex"
            :class="rowVisual(line).bg"
          >
            <span class="w-10 shrink-0 select-none border-r border-[var(--surface-border)] px-2 text-right text-gray-300 dark:text-gray-600">
              {{ rowVisual(line).lineNo }}
            </span>
            <span
              class="shrink-0 select-none px-2"
              :class="rowVisual(line).prefixClass"
            >
              {{ rowVisual(line).prefix }}
            </span>
            <span
              class="whitespace-pre-wrap px-1"
              :class="rowVisual(line).textClass"
            >
              <!-- 配对修改行优先用 mergedInlineDiff 单行渲染 -->
              <template v-if="line.mergedInlineDiff || line.inlineDiff">
                <span
                  v-for="(seg, si) in (line.mergedInlineDiff ?? line.inlineDiff)"
                  :key="si"
                  :class="{
                    'bg-green-200/60 dark:bg-green-800/40': seg.type === 'added',
                    'bg-red-200/60 text-red-700/80 dark:bg-red-800/40 dark:text-red-300/80': seg.type === 'removed',
                  }"
                >{{ seg.text }}</span>
              </template>
              <template v-else>{{ line.text || ' ' }}</template>
            </span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

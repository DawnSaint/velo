<script setup lang="ts">
// 工作区全文搜索面板(v0.5.2,v0.6.x 改为侧栏内嵌):
//
// 早期版本是 Teleport 到 body 的居中浮层;v0.6.x 迁入可折叠侧栏作为
// 第三个 tab(workspaceStore.sidebarTab === 'search'),与 FileTree /
// EditorOutline 互斥渲染 —— 关闭走 sidebar tab 切换,不再靠"点外部区域
// 关闭"。搜索逻辑在 utils/workspaceSearch.ts,本组件只负责输入 / 进度 /
// 结果分组 / 键盘导航。
//
// v0.6.0 增强:① 顶栏加折叠的替换行(chevron 触发),复用 FindReplace 的
// replaceInText;② 接 scopeDir prop,把搜索范围从工作区根收窄到子目录,
// scope chip 显示当前 scope + ✕ 清除。替换 IO + scope 重置走 emit 给 App.vue。
// v0.6.x 增强:③ 每个文件分组的 header 变成可点击折叠行(ChevronRight +
// rotate-90,沿用 FileTree / EditorOutline 同款 idiom),把命中行藏起来;
// 折叠态是组件本地 Set<fullPath>,不持久化 —— 与 showReplace 一致,
// 切 sidebar tab / 改 query / rerun 都不主动清空,只要文件仍在结果里就
// 保持折叠,行为符合用户直觉(像 FileTree 的 expandedDirs)。

import { ChevronDown, ChevronRight, Folder, X } from '@lucide/vue'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { buildPattern, type FindOptions } from '@/components/ProseMirrorEditor/findreplace/findMatches'
import {
  createWorkspaceSearchController,
  initialWorkspaceSearchProgress,
  searchWorkspaceMarkdown,
  type WorkspaceSearchController,
  type WorkspaceSearchGroup,
  type WorkspaceSearchHit,
  type WorkspaceSearchProgress,
} from '@/utils/workspaceSearch'

const props = defineProps<{
  root: string | null
  initialQuery?: string
  /** 搜索 scope:从文件树右键「在此文件夹中搜索」带过来,为 null 表示整个工作区根 */
  scopeDir?: string | null
  /** 替换完成后的一次性状态文案(App.vue 写入,显示后由 panel 自己的 status 接管) */
  replaceStatus?: string
  /** 替换 / scope 变化等"需要重跑搜索"信号 —— 每次自增触发 scheduleSearch */
  rerunToken?: number
}>()
const emit = defineEmits<{
  'update:open': [boolean]
  'open-result': [WorkspaceSearchHit]
  /** 用户点替换 / 全部替换按钮:携带当前结果 + replacement + scope,IO 由 App.vue 处理 */
  'apply-replace': [{ hits: WorkspaceSearchHit[], replacement: string, scope: 'one' | 'all' }]
  /** 用户点 scope chip 的 × 清除按钮 */
  'clear-scope': []
}>()

const query = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const regex = ref(false)
const showReplace = ref(false)
const replacement = ref('')
const groups = ref<WorkspaceSearchGroup[]>([])
const progress = ref<WorkspaceSearchProgress>(initialWorkspaceSearchProgress())
const inputRef = ref<HTMLInputElement | null>(null)
const replacementInputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const selectedFlatIndex = ref<number | null>(null)
// 鼠标 hover 位置与键盘选中位置独立 —— 上一轮把 hover 合并进 selectedFlatIndex
// 导致 hover 颜色被主色选中态盖掉(用户原意"hover 用菜单色,selected 用主色")。
// 拆成两个 state:selectedFlatIndex 由键盘 ArrowUp/Down + Click 共同控制,
// 主色底 inline style;hoveredFlatIndex 由 mouseenter/mouseleave 控制,
// 菜单色底走 .velo-ws-hovered class。selected 行的 inline style 优先级高于
// class,所以 selected + hover 同条时显示主色(selected 优先,符合"hover 是
// 预览、selected 是确认"的视觉语义)。Click 也改 selectedFlatIndex,因为
// v0.6.x 面板不自动关闭:连续点多个结果时需要保留"最后一次点的是哪条"的视觉
// 锚点,以及让紧随其后的 Enter 仍能打开这条。
const hoveredFlatIndex = ref<number | null>(null)
// v0.6.x:每个文件分组的折叠态,key = group.file.fullPath。本地 state,不复用
// showReplace / FileTree rootCollapsed 的同款语义 —— 切换 sidebar tab / 改
// query 都不主动清空,只要分组还在结果集里就保持折叠;只有当用户点 chevron
// 再次折叠才会移除。沿用 FileTree `expandedDirs` 的 Set<string> 形态。
const collapsedFiles = ref<Set<string>>(new Set())

interface HighlightSegment {
  text: string
  match: boolean
}

interface FlatRow {
  group: WorkspaceSearchGroup
  hit: WorkspaceSearchHit
  groupIndex: number
  hitIndex: number
}

const DEBOUNCE_MS = 250
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let activeController: WorkspaceSearchController | null = null
let runId = 0

const options = computed<FindOptions>(() => ({
  caseSensitive: caseSensitive.value,
  wholeWord: wholeWord.value,
  regex: regex.value,
}))

const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  groups.value.forEach((group, groupIndex) => {
    // v0.6.x:折叠中的文件不参与键盘导航 —— 直接跳过该组的所有 hit。
    // 视觉上 hit 行也跟着不渲染(header 保留,作为折叠触发的可点击区)。
    if (collapsedFiles.value.has(group.file.fullPath)) return
    group.hits.forEach((hit, hitIndex) => out.push({ group, hit, groupIndex, hitIndex }))
  })
  return out
})

const isSearching = computed(() => progress.value.phase === 'scanning' || progress.value.phase === 'searching')
const invalidRegex = computed(() => {
  const q = query.value.trim()
  return Boolean(q && regex.value && !buildPattern(q, options.value))
})
// v0.6.x:有结果判断用 groups 而不是 flatRows —— flatRows 会被折叠过滤,
// 但"是否有结果"是数据维度(用户能看到 header + 命中数),不能因为全部折叠就
// 让替换按钮 disable。groups 里每个 group 必有非空 hits(搜索阶段才添加),
// 所以 groups.length > 0 等价于"有命中"。
const hasResults = computed(() => groups.value.length > 0)
// scope chip 的显示名:scopeDir 是工作区根或 null → 显示"工作区"(不带 ✕);
// 否则显示相对工作区根的路径,带 ✕ 清除。
const scopeLabel = computed(() => {
  if (!props.scopeDir || !props.root) return null
  if (props.scopeDir === props.root) return null
  const sep = props.scopeDir.includes('\\') && !props.scopeDir.includes('/') ? '\\' : '/'
  let rel = props.scopeDir.startsWith(props.root)
    ? props.scopeDir.slice(props.root.length)
    : props.scopeDir
  if (rel.startsWith(sep)) rel = rel.slice(1)
  return rel || props.scopeDir
})
// 「替换」按钮:必须选中某条命中 + 有 replacement + 正则合法
const canReplaceOne = computed(() =>
  hasResults.value
  && replacement.value.length > 0
  && !invalidRegex.value,
)
// 「全部替换」按钮:只需有命中 + 正则合法(replacement 可空,空串 = 删)
const canReplaceAll = computed(() =>
  hasResults.value
  && !invalidRegex.value,
)
const statusText = computed(() => {
  const p = progress.value
  if (!props.root) return '请先打开一个工作区'
  if (!query.value.trim()) return ''
  if (invalidRegex.value) return '正则表达式无效'
  if (p.phase === 'scanning') return `正在扫描${scopeLabel.value ? `「${scopeLabel.value}」` : '工作区'}… 已发现 ${p.filesFound} 个 .md`
  if (p.phase === 'searching') return `正在搜索 ${p.filesSearched} / ${p.filesFound}… ${p.hits} 个结果`
  if (p.phase === 'canceled') return `已停止，显示当前 ${p.hits} 个结果`
  if (p.phase === 'error') return p.error ?? '搜索失败'
  if (p.phase === 'done') return p.hits ? `${p.hits} 个结果` : '无匹配项'
  return ''
})
// 替换反馈文案(v0.6.0):App.vue 调完 applyWorkspaceReplace 写入 replaceStatus,
// 在面板底部 status 区显示一次;下一次重跑搜索(rerunToken)时由 statusText
// 自然接管。设计取舍:不显示 3 秒后自动消失 —— 用户复制 / 阅读一次性文案
// 不该被定时器抢走;清空由"用户继续编辑"或"再次替换"自然触发。
const showReplaceStatus = computed(() => Boolean(props.replaceStatus))

function buildSegments(text: string, from: number, to: number): HighlightSegment[] {
  if (from < 0 || to <= from || from >= text.length) return [{ text, match: false }]
  const end = Math.min(to, text.length)
  const out: HighlightSegment[] = []
  if (from > 0) out.push({ text: text.slice(0, from), match: false })
  out.push({ text: text.slice(from, end), match: true })
  if (end < text.length) out.push({ text: text.slice(end), match: false })
  return out.filter(s => s.text.length > 0)
}

function cancelActive(markCanceled: boolean) {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  activeController?.cancel()
  activeController = null
  if (markCanceled && isSearching.value) {
    progress.value = { ...progress.value, phase: 'canceled' }
  }
}

function resetSearchState() {
  cancelActive(false)
  groups.value = []
  progress.value = initialWorkspaceSearchProgress()
  selectedFlatIndex.value = null
}

function scheduleSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  cancelActive(false)

  const q = query.value.trim()
  if (!props.root || !q || invalidRegex.value) {
    groups.value = []
    progress.value = initialWorkspaceSearchProgress()
    return
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSearch(q)
  }, DEBOUNCE_MS)
}

async function runSearch(q: string) {
  const root = props.root
  if (!root) return
  const controller = createWorkspaceSearchController()
  activeController = controller
  const id = ++runId
  groups.value = []
  progress.value = initialWorkspaceSearchProgress()
  selectedFlatIndex.value = null

  await searchWorkspaceMarkdown(root, q, options.value, controller, {
    onProgress(p) {
      if (id !== runId) return
      progress.value = p
    },
    onGroups(nextGroups) {
      if (id !== runId) return
      groups.value = nextGroups
      clampSelection()
    },
  }, props.scopeDir ?? null)

  if (id === runId && activeController === controller) activeController = null
}

function close() {
  cancelActive(false)
  emit('update:open', false)
}

function stopSearch() {
  cancelActive(true)
}

function clampSelection() {
  const n = flatRows.value.length
  if (!n) {
    selectedFlatIndex.value = null
    return
  }
  // v0.6.x:初始不自动选中 —— 如果 selectedFlatIndex 还是 null,保持 null,
  // 等用户 ArrowUp/Down / Click 才设置。折叠让 flatRows 缩短时,尽量保留
  // 原选中位置(像 "末位不变" 语义)而不是粗暴归零 —— 用户折叠中间某个组后,
  // 选区锚点跳到最近可见行,比从头开始体验更好。
  if (selectedFlatIndex.value === null) return
  if (selectedFlatIndex.value < 0) selectedFlatIndex.value = 0
  else if (selectedFlatIndex.value >= n) selectedFlatIndex.value = n - 1
}

watch(flatRows, clampSelection)
// scopeDir 变化 → 重新跑搜索(用户在文件树右键切 scope 时立即生效)
// rerunToken 变化 → App.vue 完成替换后主动触发重跑(不依赖 query / scope 变更)
watch([query, caseSensitive, wholeWord, regex, () => props.root, () => props.scopeDir], scheduleSearch)
watch(() => props.rerunToken, () => {
  // scheduleSearch 会先 cancel 旧的 run + 清结果,与 runSearch 一致
  scheduleSearch()
})

// 每次 initialQuery 变化(首次挂载 immediate + 后续 Ctrl+Shift+F 改写)→
// 重置选项 + 应用新 query + 重新搜索 + focus + select 输入框。
//
// 单一 watcher 替代旧的 onMounted 块:v0.6.x 侧栏内嵌后组件没有"open 切换"
// 这一态,挂载时机和 prop 变化的处理路径一致 —— App.vue 在 Ctrl+Shift+F 时
// 改写 workspaceSearchInitialQuery → Sidebar 透传 initialQuery → 这里 watch
// 触发,把新内容写进搜索框并 focus;App.vue 同时设了"不在 search tab 也显示"
// 语义,行为统一。
watch(() => props.initialQuery, async (newQuery) => {
  query.value = newQuery ?? ''
  caseSensitive.value = false
  wholeWord.value = false
  regex.value = false
  resetSearchState()
  if (query.value.trim()) scheduleSearch()
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
}, { immediate: true })

onBeforeUnmount(() => {
  cancelActive(false)
})

function moveSelection(delta: number) {
  const n = flatRows.value.length
  if (!n) return
  // v0.6.x:无选中态(null)时,ArrowDown 落到第一条、ArrowUp 落到最后一条,
  // 与"首次按键挑一个起点"的直觉对齐 —— 避免选中态从 null 直接 0+delta
  // 当成 0(模运算)时 ArrowUp 落到末尾这种反直觉行为。
  if (selectedFlatIndex.value === null) {
    selectedFlatIndex.value = delta > 0 ? 0 : n - 1
  }
  else {
    selectedFlatIndex.value = (selectedFlatIndex.value + delta + n) % n
  }
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-flat-idx="${selectedFlatIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function openSelected() {
  if (selectedFlatIndex.value === null) return
  const row = flatRows.value[selectedFlatIndex.value]
  if (!row) return
  emit('open-result', row.hit)
}

function onHitEnter(flatIndex: number) {
  hoveredFlatIndex.value = flatIndex
}

function onHitLeave() {
  hoveredFlatIndex.value = null
}

function onHitClick(flatIndex: number, hit: WorkspaceSearchHit) {
  // Click 同时把 selectedFlatIndex 推到被点击的条目:
  //   1. 用户能看到"我点中了这条"(主色高亮保留);
  //   2. v0.6.x 面板不自动关闭,下次 Enter 仍能打开刚点的条目(连续点多个
  //      结果的迭代体验);
  //   3. selectedFlatIndex 由键盘 ArrowUp/Down + Click 共同控制;hover
  //      仍走独立 hoveredFlatIndex,菜单色 hover 视觉反馈不动。
  selectedFlatIndex.value = flatIndex
  emit('open-result', hit)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1) }
  else if (e.key === 'Enter') { e.preventDefault(); openSelected() }
  else if (e.key === 'Escape') { e.preventDefault(); close() }
}

// ========== 替换(v0.6.0) ==========
//
// 「替换」= 替换当前选中条目所在文件的所有命中(语义对齐编辑器内 Ctrl+H 的"Replace";
// 用户预期是"把这条命中所在行 / 文件改掉",不是只改一个字符)。
// 「全部替换」= 替换当前所有结果命中文件中的全部匹配。
//
// IO 不在本组件:emit apply-replace 把 hits + replacement + scope 交给 App.vue,
// App.vue 拿 dirtyPaths snapshot 调 applyWorkspaceReplace,处理 tab 同步,
// 然后通过 prop watcher 触发本组件重跑搜索,刷新结果。
function toggleReplace() {
  showReplace.value = !showReplace.value
  if (showReplace.value) {
    // 展开时 focus 替换输入框,方便用户立刻键入
    nextTick(() => replacementInputRef.value?.focus())
  }
}

function applyReplace(scope: 'one' | 'all') {
  if (scope === 'one' && !canReplaceOne.value) return
  if (scope === 'all' && !canReplaceAll.value) return
  // v0.6.x:替换 IO 必须用 groups 而不是 flatRows —— flatRows 会被折叠过滤,
  // 但替换语义是"该文件/全部的所有命中",与折叠态无关(用户折叠只是不想看,
  // 不是想跳过)。'one' 通过 selectedFlatIndex 拿到选中 hit 的 fullPath,
  // 在 groups 里找到对应 group 取全文件命中;'all' 直接 flatMap groups。
  let hits: WorkspaceSearchHit[]
  if (scope === 'one') {
    // v0.6.x:selectedFlatIndex 可能是 null(无选中态),scope='one' 没目标可替换,
    // 直接 return —— 不再像旧版那样隐式落到 flatRows[0]
    if (selectedFlatIndex.value === null) return
    const row = flatRows.value[selectedFlatIndex.value]
    if (!row) return
    const filePath = row.hit.fullPath
    hits = groups.value.find(g => g.file.fullPath === filePath)?.hits ?? []
  }
  else {
    hits = groups.value.flatMap(g => g.hits)
  }
  emit('apply-replace', { hits, replacement: replacement.value, scope })
}

function clearScope() {
  emit('clear-scope')
}

// ========== 文件分组折叠(v0.6.x) ==========
//
// 语义与 FileTree 的 expandedDirs / EditorOutline 的 collapsedByPath 同款:
// key 是文件 fullPath,点 chevron 切换。Set 重新赋值(vs .add/.delete)
// 是因为 Vue 3 的 ref 对 Set 的 in-place mutation 不会自动 trigger
// reactivity —— 这是 Set 的已知局限,沿用项目里 outlineStore 的
// "把 keys 转 array 再写回 reactive 对象" 套路。
function toggleCollapsed(fullPath: string) {
  const next = new Set(collapsedFiles.value)
  if (next.has(fullPath)) next.delete(fullPath)
  else next.add(fullPath)
  collapsedFiles.value = next
}

function isCollapsed(fullPath: string): boolean {
  return collapsedFiles.value.has(fullPath)
}
</script>

<template>
  <!--
    v0.6.x 改为侧栏内嵌:不再 Teleport 到 body 也不再有遮罩背景。
    视觉节奏参考 EditorOutline —— 同样的内边距分配,顶栏与结果列表之间
    用 1px 边线分隔。data-workspace-search-panel 仍挂在根上,App.vue 的
    onKeydown 选择器靠它判断焦点是否在本面板内,避免重复触发全局快捷键。
    顶栏 / 输入框上下间距各 +4px(pt-3 / mb-3)以拉开呼吸感;Aa / W / .*
    三个开关自己成组(gap-0.5),与 input / 停止按钮的间距仍走外层 gap-2。
    关闭按钮去掉 —— 用户走 Esc / 再次点 ActivityBar 搜索图标收起。
    命中行 hover / selected 两套状态独立:selected 由键盘 ArrowUp/Down 与
    Click 共同改 selectedFlatIndex,inline style 主色底;hovered 由 mouseenter/
    leave 改 hoveredFlatIndex,`.velo-ws-hovered` class 走菜单色底。selected
    优先级高于 hover(selected + hover 同条时显示主色,"hover 是预览、
    selected 是确认")。Click 同时把 selectedFlatIndex 推到被点击条目,
    是因为 v0.6.x 面板不自动关闭:用户连续点多个结果时,需要保留"最后一次
    点的是哪条"的视觉锚点,以及让紧随其后的 Enter 仍打开这条。
    v0.6.0 替换行:chevron 切换可见性;展开后第二行放替换输入框 +
    「替换」/「全部替换」按钮,disabled 由 canReplaceOne/canReplaceAll 控制。
    scope chip:仅在 scopeDir 是工作区根的子目录时显示,显示相对路径 +
    × 按钮 → emit clear-scope;App.vue 把 scopeDir 重置为 null。
    v0.6.x 文件分组折叠:每条 file header 改成 <button>,内嵌 ChevronRight
    + rotate-90(沿用 FileTree / EditorOutline 同款 chevron idiom),点 row
    切折叠;命中行跟着不渲染,键盘 ArrowUp/Down 自动跳过 hidden 行
    (flatRows 计算属性过滤掉 collapsedFiles 命中的组)。折叠态是组件本地
    Set<fullPath>,与 showReplace 一致,不持久化 —— 切 sidebar tab /
    改 query / rerunToken 都不主动清空,只要分组还在结果集里就保持折叠,
    行为符合用户直觉(像 FileTree 的 expandedDirs)。
  -->
  <div
    class="flex h-full min-w-0 flex-col overflow-hidden"
    data-workspace-search-panel
    data-testid="workspace-search-panel"
  >
    <div class="my-3 shrink-0 px-2">
      <div class="flex items-center gap-1 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-2)] mx-2 pl-1 pr-2 h-8 transition-colors focus-within:border-[var(--md-primary-color)]">
        <div class="relative min-w-0 flex-1 flex items-center">
          <button
            class="absolute top-1/2 -translate-y-1/2 flex w-6 h-6 shrink-0 items-center justify-center rounded text-gray-500 transition-colors dark:text-gray-400"
            :title="showReplace ? '收起替换' : '展开替换'"
            data-testid="workspace-search-toggle-replace"
            @click="toggleReplace"
          >
            <ChevronDown v-if="showReplace" class="size-3" :stroke-width="2.5" />
            <ChevronRight v-else class="size-3" :stroke-width="2.5" />
          </button>
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            spellcheck="false"
            placeholder="查找"
            data-testid="workspace-search-input"
            class="min-w-0 w-full bg-transparent pl-7 text-xs leading-[1.2] text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
            @keydown="onInputKeydown"
          />
        </div>
        <div class="flex items-center gap-0.5">
          <button
            class="rounded px-1.5 py-0.5 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
            :class="{ 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100': caseSensitive }"
            title="区分大小写"
            data-testid="workspace-search-case"
            @click="caseSensitive = !caseSensitive"
          >
            Aa
          </button>
          <button
            class="rounded px-1.5 py-0.5 text-[11px] font-semibold text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
            :class="{ 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100': wholeWord }"
            title="全词匹配"
            data-testid="workspace-search-word"
            @click="wholeWord = !wholeWord"
          >
            W
          </button>
          <button
            class="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gray-500 transition-colors hover:bg-[var(--surface-hover)] dark:text-gray-400"
            :class="{ 'bg-[var(--surface-pressed)] text-gray-900 dark:text-gray-100': regex }"
            title="正则表达式"
            data-testid="workspace-search-regex"
            @click="regex = !regex"
          >
            .*
          </button>
        </div>
        <button
          v-if="isSearching"
          class="rounded px-2 py-0.5 text-[11px] text-gray-500 hover:bg-[var(--surface-hover)] dark:text-gray-400"
          data-testid="workspace-search-stop"
          @click="stopSearch"
        >
          停止
        </button>
      </div>
      <div
        v-if="showReplace"
        class="mx-2 mt-2 flex items-center gap-2 rounded-xl border border-[var(--surface-border)] bg-[var(--surface-2)] pl-3 pr-2 h-8"
      >
        <input
          ref="replacementInputRef"
          v-model="replacement"
          type="text"
          spellcheck="false"
          placeholder="替换为"
          data-testid="workspace-search-replacement"
          class="min-w-0 flex-1 bg-transparent text-xs text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500"
          @keydown.enter.prevent="applyReplace(canReplaceOne ? 'one' : 'all')"
        />
        <button
          class="shrink-0 rounded px-2 py-0.5 text-[11px] text-gray-500 hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400"
          :disabled="!canReplaceOne"
          title="替换当前选中条目所在文件的所有命中"
          data-testid="workspace-search-replace-one"
          @click="applyReplace('one')"
        >
          替换
        </button>
        <button
          class="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold text-gray-500 hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400"
          :disabled="!canReplaceAll"
          title="替换当前所有结果"
          data-testid="workspace-search-replace-all"
          @click="applyReplace('all')"
        >
          全部替换
        </button>
      </div>
      <!-- scope chip:仅当 scopeDir 是工作区根的子目录时显示 -->
      <div
        v-if="scopeLabel"
        class="mx-2 mt-2 inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-pressed)] px-2 py-0.5 text-[11px] text-gray-600 dark:text-gray-300"
        data-testid="workspace-search-scope-chip"
      >
        <Folder class="size-3 shrink-0" :stroke-width="2" />
        <span class="min-w-0 truncate" :title="props.scopeDir ?? ''">{{ scopeLabel }}</span>
        <button
          class="ml-0.5 inline-flex items-center justify-center rounded-full p-0.5 hover:bg-[var(--surface-pressed)]"
          title="清除 scope,回到工作区根"
          data-testid="workspace-search-scope-clear"
          @click="clearScope"
        >
          <X class="size-3" :stroke-width="2.5" />
        </button>
      </div>
      <div
        v-if="showReplaceStatus"
        class="mt-1 pr-1 text-[11px]"
        :class="progress.phase === 'error' || invalidRegex ? 'text-red-500' : 'text-gray-400'"
        data-testid="workspace-search-replace-status"
      >
        {{ props.replaceStatus }}
      </div>
      <div
        v-else-if="query.trim() || progress.phase === 'error'"
        class="mt-3 text-[11px]"
        :class="progress.phase === 'error' || invalidRegex ? 'text-red-500' : 'text-gray-400'"
        data-testid="workspace-search-status"
      >
        {{ statusText }}
      </div>
    </div>

    <div ref="listRef" v-velo-scroll class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="!props.root || invalidRegex || (!groups.length && !isSearching && (query.trim() || invalidRegex))" class="py-8 text-center text-xs text-gray-400">
        {{ statusText }}
      </div>
      <template v-else>
        <template v-for="(group, groupIdx) in groups" :key="group.file.fullPath">
          <button
            type="button"
            class="sticky top-0 z-10 flex w-full items-center gap-2 px-2 py-1 text-left text-xs bg-[var(--surface-1)] transition-colors hover:bg-[var(--surface-hover)]"
            :data-testid="`workspace-search-group-${groupIdx}`"
            :aria-expanded="!isCollapsed(group.file.fullPath)"
            :title="group.file.relPath"
            @click="toggleCollapsed(group.file.fullPath)"
          >
            <ChevronRight
              class="size-3 shrink-0 text-gray-400 transition-transform"
              :class="{ 'rotate-90': !isCollapsed(group.file.fullPath) }"
              :stroke-width="2.5"
            />
            <span class="min-w-0 flex-1 truncate font-medium text-gray-600 dark:text-gray-300">
              {{ group.file.relPath }}
            </span>
            <span class="shrink-0 text-gray-400">{{ group.hits.length }} 处</span>
          </button>
          <!--
            命中行也要根据折叠态决定是否渲染 —— 模板里走 `group.hits` 直接迭代
            而不是 flatRows,所以 flatRows 过滤对 DOM 不生效,必须用 v-if 显式
            跳过整个块。键盘导航 (selectedFlatIndex / hoveredFlatIndex) 已经
            在 flatRows 里被过滤掉了,这层 v-if 只负责 DOM 渲染。

            v0.6.x:每个分组用一个 `<div class="ml-[14px] border-l pl-3">` 把所有
            hit 包起来,一次解决两件事:
            ① border-l 是 1px 竖向细线 —— 视觉对齐 chevron 中心(14px = 8px
              pl-2 + 12px/2 chevron 宽),组内所有 hit 共用一条线,组与组之间
              线断(每个分组独立 wrapper),形成"chevron 是父节点、hit 是子节点"
              的树状隐喻;
            ② pl-3 (12px) 让 hit 文字起点落在 ~27px(pl-2=8 + chevron 12 + gap 8
              = 28px 处是 header 的 file name 文字起点),与 header 文字对齐。
            hit 行内不再带 px-2(只留 pr-2),把左边距让给 wrapper 的 border-l +
            pl-3 —— 否则会被自身 padding 二次偏移。
          -->
          <div
            v-if="!isCollapsed(group.file.fullPath)"
            class="ml-[14px] border-l border-[var(--surface-border)] pl-3"
          >
            <div
              v-for="(hit, hitIdx) in group.hits"
              :key="hit.id"
              :data-flat-idx="flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx)"
              :data-testid="`workspace-search-hit-${groupIdx}-${hitIdx}`"
              class="flex cursor-pointer gap-2 rounded pr-2 py-1.5 text-xs"
              :class="hoveredFlatIndex === flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx)
                ? 'velo-ws-hovered'
                : ''"
              :style="selectedFlatIndex === flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx) ? {
                backgroundColor: 'color-mix(in srgb, var(--md-primary-color, #1F71D9) 12%, transparent)',
              } : undefined"
              @mouseenter="onHitEnter(flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx))"
              @mouseleave="onHitLeave"
              @click="onHitClick(flatRows.findIndex(r => r.groupIndex === groupIdx && r.hitIndex === hitIdx), hit)"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-gray-700 dark:text-gray-200">
                <template v-for="(seg, segIdx) in buildSegments(hit.lineText, hit.matchStartInLine, hit.matchEndInLine)" :key="segIdx">
                  <!--
                    命中段高亮复用 .velo-find-match 样式 —— 与编辑器内 FindReplace
                    Decoration 视觉一致,金底 rgba(255,215,0,.35) 在浅 / 深主题下都
                    可见,不依赖 --md-primary-color(用户自定义主色过浅时会导致原
                    color-mix 22% 透明几乎不可见)。mark 默认有自己的 background,
                    改用 span 避免与 class 叠加冲突。
                  -->
                  <span
                    v-if="seg.match"
                    class="velo-find-match rounded px-0.5 font-semibold text-gray-900 dark:text-gray-50"
                  >{{ seg.text }}</span>
                  <span v-else>{{ seg.text }}</span>
                </template>
              </span>
            </div>
          </div>
        </template>
      </template>
      <div v-if="isSearching && groups.length" class="px-3 py-2 text-center text-[11px] text-gray-400">
        {{ statusText }}
      </div>
      <div v-if="progress.phase === 'canceled' && groups.length" class="px-3 py-2 text-center text-[11px] text-gray-400">
        {{ statusText }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 鼠标 hover 命中行的菜单色底。
 *
 * 用独立 class 而非 Tailwind `hover:bg-*`:Tailwind 的 `:hover` 伪类是声明
 * 在 utility 之前的 CSS 变体,被 selected 行的 inline style backgroundColor
 * 压住看不到;且 Tailwind hover 不能"锁定"鼠标离开后保留视觉。拆成两个
 * state(hoveredFlatIndex + selectedFlatIndex)后,hover 走 class、selected
 * 走 inline style —— 后者优先级最高,所以 selected + hover 同条时显示主色
 * (selected 优先,"hover 是预览、selected 是确认"语义)。
 */
.velo-ws-hovered {
  background-color: rgb(243 244 246);
}
.dark .velo-ws-hovered {
  background-color: var(--chrome-text-primary);
}
</style>
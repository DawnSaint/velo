<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { BUNDLED_THEMES, NO_THEME } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'
import { THEME_PALETTES } from '@/components/ProseMirrorEditor/nodes/themePalettes'
import { fontStacks } from '@/utils/fontStacks'
import { isMacOS } from '@/utils/platform'
import SettingsItem from '../SettingsItem.vue'
import VeloSelect, { type VeloSelectOption } from '../VeloSelect.vue'

const store = useEditorStore()

const themeModeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '始终浅色' },
  { value: 'dark', label: '始终暗色' },
]

/* ---------- 字体选配 ---------- */
// 三类字体独立选择：拉丁（西文正文）/ 中日韩 / 等宽（代码）。
// key 对应 fontStacks 映射表的键；label 为字体名（专有名词不翻译）。
// fontFamily 直接从映射表取 CSS font-family stack,在下拉选项中用该字体渲染 label,
// 让用户展开下拉即可预览各字体效果。
// 按平台过滤:只显示当前平台原生可用的字体(Apple 专有字体在 Windows 上隐藏,
// Windows 专有字体在 macOS 上隐藏),开源字体标记为 'all' 跨平台可见。
// 各平台默认字体 label 后标注「（默认）」,store 默认值也按平台设置。

const currentPlatform = isMacOS ? 'macos' : 'windows'

// 各平台三类字体的默认选项 key(对应 fontStacks 中的键)。
// store 默认值按平台设置(见 editor.ts),UI 下拉不显示 system 选项;
// 在平台默认对应的具体字体 label 后标注「（默认）」让用户一目了然。
const DEFAULT_FONT_KEYS = {
  latin: isMacOS ? 'charter' : 'cambria',
  cjk: isMacOS ? 'pingfang' : 'yahei',
  mono: isMacOS ? 'sfmono' : 'cascadiacode',
} as const

function isFontAvailable(platforms: 'all' | readonly string[]): boolean {
  if (platforms === 'all') return true
  return platforms.includes(currentPlatform)
}

function buildFontOptions(
  category: 'latin' | 'cjk' | 'mono',
  labels: Record<string, string>,
): VeloSelectOption[] {
  const stacks = fontStacks[category]
  const defaultKey = DEFAULT_FONT_KEYS[category]
  return Object.entries(stacks)
    .filter(([key, entry]) => key !== 'system' && isFontAvailable(entry.platforms))
    .map(([key, entry]) => ({
      value: key,
      label: labels[key] ?? key,
      fontFamily: entry.stack,
    }))
    .sort((a, b) => (a.value === defaultKey ? -1 : b.value === defaultKey ? 1 : 0))
}

const latinFontOptions = buildFontOptions('latin', {
  georgia: 'Georgia',
  palatino: 'Palatino',
  charter: 'Charter',
  cambria: 'Cambria',
  constantia: 'Constantia',
})

const cjkFontOptions = buildFontOptions('cjk', {
  pingfang: 'PingFang SC',
  songti: '宋体',
  kaiti: '楷体',
  yahei: '微软雅黑',
  sourcehans: '思源黑体',
})

const monoFontOptions = buildFontOptions('mono', {
  jetbrains: 'JetBrains Mono',
  consolas: 'Consolas',
  sfmono: 'SF Mono',
  menlo: 'Menlo',
  monaco: 'Monaco',
  cascadiacode: 'Cascadia Code',
  firacode: 'Fira Code',
  hack: 'Hack',
  ibmplexmono: 'IBM Plex Mono',
  inconsolata: 'Inconsolata',
  sourcecodepro: 'Source Code Pro',
  dejavu: 'DejaVu Sans Mono',
})

/* ---------- 代码块主题 ---------- */
// 从主题色板提取 4 个代表色(keyword / string / func / comment)作为色块预览;
// 过滤空值(部分主题缺某些 scope 的颜色定义)。
function themeSwatches(id: string): string[] {
  const p = THEME_PALETTES[id]
  if (!p) return []
  return [p.keyword, p.string, p.func, p.comment].filter(c => c)
}

// 「无主题」选项:不使用 shiki 渲染,代码块显示纯文本。
const NO_THEME_OPTION: VeloSelectOption = { value: NO_THEME, label: '无主题' }

const lightThemeOptions = computed<VeloSelectOption[]>(() => [
  NO_THEME_OPTION,
  ...BUNDLED_THEMES.filter(t => t.type === 'light').map(t => ({
    value: t.id,
    label: t.displayName || t.id,
    swatches: themeSwatches(t.id),
  })),
])
const darkThemeOptions = computed<VeloSelectOption[]>(() => [
  NO_THEME_OPTION,
  ...BUNDLED_THEMES.filter(t => t.type === 'dark').map(t => ({
    value: t.id,
    label: t.displayName || t.id,
    swatches: themeSwatches(t.id),
  })),
])
</script>

<template>
  <section class="space-y-4 pt-6">
    <!-- 主色 -->
    <SettingsItem label="主色" :keywords="['primary', 'color', '主题色', 'accent']">
      <span class="flex items-center gap-2">
        <span class="text-sm tabular-nums text-gray-600 dark:text-gray-300">{{ store.primaryColor }}</span>
        <input
          v-model="store.primaryColor"
          type="color"
          class="velo-color-circle h-6 w-6 cursor-pointer rounded-full p-0 dark:border-gray-700"
        />
      </span>
    </SettingsItem>

    <!-- 主题色影响文档颜色:默认关闭,文档内容(标题/加粗/列表/折叠/表格等)用各自默认色;
         开启后文档内容色跟随主色(旧行为)。UI  chrome(侧栏/设置/分割线)始终跟随主色。 -->
    <SettingsItem label="主题色影响文档颜色" :keywords="['primary', 'color', '文档', '主题色', '标题', '影响']" clickable>
      <input
        v-model="store.themeColorAffectsDoc"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>

    <SettingsItem label="主题模式" :keywords="['dark', 'mode', '夜间', '深色', 'theme', 'system', '系统', '跟随']">
      <VeloSelect
        v-model="store.themeMode"
        :options="themeModeOptions"
        aria-label="主题模式"
      />
    </SettingsItem>

    <!-- 中文字间距:给中文字符添加微量字间距,提升排版可读性。纯视觉装饰,不影响文档内容。 -->
    <SettingsItem label="中文字间距" :keywords="['中文', '字间距', 'letter', 'spacing', '汉字', '排版']" clickable>
      <input
        v-model="store.cjkLetterSpacing"
        type="checkbox"
        role="switch"
        class="velo-switch"
      >
    </SettingsItem>

    <!-- 字体选配:三类独立选择。西文字体负责西文正文,CJK 字体负责中日韩字形,
         等宽字体负责代码块/行内code/kbd。下拉选项中直接用对应字体渲染 label,展开即可预览。
         按平台过滤:macOS 专有字体(SF Mono/Menlo/Monaco/Charter/PingFang)在 Windows 上隐藏,
         Windows 专有字体(Consolas/Cascadia/Cambria/微软雅黑/宋体/楷体)在 macOS 上隐藏。
         默认字体后标注「（默认）」。 -->
    <SettingsItem label="西文字体" :keywords="['font', '字体', 'latin', '西文', '正文', 'serif', '衬线']">
      <VeloSelect
        v-model="store.latinFont"
        :options="latinFontOptions"
        aria-label="西文字体"
      />
    </SettingsItem>

    <SettingsItem label="中文字体" :keywords="['font', '字体', 'cjk', '中文', '汉字', '黑体', '宋体', '楷体', '雅黑']">
      <VeloSelect
        v-model="store.cjkFont"
        :options="cjkFontOptions"
        aria-label="中文字体"
      />
    </SettingsItem>

    <SettingsItem label="等宽字体" :keywords="['font', '字体', 'mono', '等宽', '代码', 'code', 'jetbrains', 'consolas', 'firacode', 'source', 'dejavu']">
      <VeloSelect
        v-model="store.monoFont"
        :options="monoFontOptions"
        aria-label="等宽字体"
      />
    </SettingsItem>

    <!-- 代码块主题:浅色 + 深色,各一个下拉(带过滤)。切换走
      lazy load(~100-300ms),由 App.vue watch store 触发 ensureTheme +
      dispatch rebuild。独立于 darkMode toggle(后者是纯 CSS 切色)。 -->
    <SettingsItem label="代码块主题(浅色)" :keywords="['code', 'theme', 'light', 'shiki', '代码', '主题']">
      <VeloSelect
        v-model="store.codeLightTheme"
        :options="lightThemeOptions"
        aria-label="代码块浅色主题"
      />
    </SettingsItem>
    <SettingsItem label="代码块主题(深色)" :keywords="['code', 'theme', 'dark', 'shiki', '代码', '主题']">
      <VeloSelect
        v-model="store.codeDarkTheme"
        :options="darkThemeOptions"
        aria-label="代码块深色主题"
      />
    </SettingsItem>
  </section>
</template>

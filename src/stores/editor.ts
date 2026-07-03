import { ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'

/** 启动时打开内容的选择。'last-file' = 打开上次打开的文件; 'new-doc' = 新建空白文档。 */
export type StartupMode = 'last-file' | 'new-doc'

export const useEditorStore = defineStore('editor', () => {
  const fontSize = ref('16px')
  const primaryColor = ref('#1F71D9')
  const fontFamily = ref('-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif')
  const isMacCodeBlock = ref(true)
  const darkMode = ref(false)
  /** 代码块浅色主题 id(sloth shiki bundledThemesInfo 的 id 字段)。 */
  const codeLightTheme = ref(DEFAULT_LIGHT_THEME)
  /** 代码块深色主题 id。 */
  const codeDarkTheme = ref(DEFAULT_DARK_THEME)
  /** 启动时打开内容的选择。默认 'last-file'。 */
  const startupMode = ref<StartupMode>('last-file')
  /** WYSIWYG 代码块行号(可选开关,默认关闭)。
   * 行号是纯视觉装饰,plugin `codeLineNumberPlugin` 读这个字段决定是否挂 widget,
   * 不进 schema / 不进 markdown 序列化。 */
  const showCodeLineNumbers = ref(false)

  return {
    fontSize,
    primaryColor,
    fontFamily,
    isMacCodeBlock,
    darkMode,
    codeLightTheme,
    codeDarkTheme,
    startupMode,
    showCodeLineNumbers,
  }
})

import { ref } from 'vue'
import { defineStore } from 'pinia'
import { DEFAULT_LIGHT_THEME, DEFAULT_DARK_THEME } from '@/components/ProseMirrorEditor/nodes/CodeBlockLangs'

export const useEditorStore = defineStore('editor', () => {
  const fontSize = ref('14px')
  const primaryColor = ref('#1F71D9')
  const fontFamily = ref('-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif')
  const isMacCodeBlock = ref(true)
  const darkMode = ref(false)
  /** 代码块浅色主题 id(sloth shiki bundledThemesInfo 的 id 字段)。 */
  const codeLightTheme = ref(DEFAULT_LIGHT_THEME)
  /** 代码块深色主题 id。 */
  const codeDarkTheme = ref(DEFAULT_DARK_THEME)

  return {
    fontSize,
    primaryColor,
    fontFamily,
    isMacCodeBlock,
    darkMode,
    codeLightTheme,
    codeDarkTheme,
  }
})

import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useEditorStore = defineStore('editor', () => {
  const fontSize = ref('14px')
  const primaryColor = ref('#1F71D9')
  const fontFamily = ref('-apple-system-font, BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB, Microsoft YaHei UI, Microsoft YaHei, Arial, sans-serif')
  const codeBlockTheme = ref('https://cdn-doocs.oss-cn-shenzhen.aliyuncs.com/npm/highlightjs/11.11.1/styles/github.min.css')
  const isMacCodeBlock = ref(true)
  const darkMode = ref(false)

  return {
    fontSize,
    primaryColor,
    fontFamily,
    codeBlockTheme,
    isMacCodeBlock,
    darkMode,
  }
})

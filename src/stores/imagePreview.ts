// 图片预览 lightbox 的全局状态 —— 文件树 / 资产面板共用一个预览浮层。
// UI 在 ImagePreviewLightbox.vue(App.vue 挂载,Teleport to body),
// 业务侧只调 open(list, index),不直接碰 DOM。

import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface PreviewImage {
  /** 展示 URL:本地走 convertFileSrc,外链原样 */
  url: string
  /** 展示名(basename 或截断 URL) */
  name: string
  /** 磁盘绝对路径;外链为 null(复制图片 / reveal / stat 据此显隐) */
  absPath: string | null
}

export const useImagePreviewStore = defineStore('imagePreview', () => {
  const images = ref<PreviewImage[]>([])
  const index = ref(0)
  const isOpen = ref(false)

  function open(list: PreviewImage[], startIndex = 0) {
    if (list.length === 0) return
    images.value = list
    index.value = Math.min(Math.max(0, startIndex), list.length - 1)
    isOpen.value = true
  }

  function close() {
    isOpen.value = false
  }

  /** 前后导航,循环 wrap */
  function step(delta: number) {
    const n = images.value.length
    if (n > 1) index.value = (index.value + delta + n) % n
  }

  return { images, index, isOpen, open, close, step }
})
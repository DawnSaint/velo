import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { zoomIn, zoomOut, zoomReset } from '../zoomCommands'
import { useEditorStore, ZOOM_LEVEL_MIN, ZOOM_LEVEL_MAX, ZOOM_LEVEL_DEFAULT, ZOOM_LEVEL_STEP } from '@/stores/editor'

// zoomCommands 的命令函数签名匹配 ShortcutCommand(state, dispatch?, view?),
// 但它们不使用 ProseMirror state —— 只操作 store。传 null/undefined 作占位。
const dummyState = null as unknown as Parameters<typeof zoomIn>[0]

describe('zoomCommands (v0.7.12)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  describe('zoomIn', () => {
    it('从默认 1.0 放大到 1.1', () => {
      const store = useEditorStore()
      const result = zoomIn(dummyState)
      expect(result).toBe(true)
      expect(store.zoomLevel).toBe(1.1)
    })

    it('连续放大递增', () => {
      const store = useEditorStore()
      zoomIn(dummyState)
      zoomIn(dummyState)
      zoomIn(dummyState)
      expect(store.zoomLevel).toBe(1.3)
    })

    it('到达 MAX 后不再放大但返回 true', () => {
      const store = useEditorStore()
      store.zoomLevel = ZOOM_LEVEL_MAX
      const result = zoomIn(dummyState)
      expect(result).toBe(true)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_MAX)
    })

    it('从边界附近放大 clamp 到 MAX', () => {
      const store = useEditorStore()
      store.zoomLevel = ZOOM_LEVEL_MAX - ZOOM_LEVEL_STEP / 2
      zoomIn(dummyState)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_MAX)
    })
  })

  describe('zoomOut', () => {
    it('从默认 1.0 缩小到 0.9', () => {
      const store = useEditorStore()
      const result = zoomOut(dummyState)
      expect(result).toBe(true)
      expect(store.zoomLevel).toBe(0.9)
    })

    it('连续缩小递减', () => {
      const store = useEditorStore()
      zoomOut(dummyState)
      zoomOut(dummyState)
      expect(store.zoomLevel).toBe(0.8)
    })

    it('到达 MIN 后不再缩小但返回 true', () => {
      const store = useEditorStore()
      store.zoomLevel = ZOOM_LEVEL_MIN
      const result = zoomOut(dummyState)
      expect(result).toBe(true)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_MIN)
    })

    it('从边界附近缩小 clamp 到 MIN', () => {
      const store = useEditorStore()
      store.zoomLevel = ZOOM_LEVEL_MIN + ZOOM_LEVEL_STEP / 2
      zoomOut(dummyState)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_MIN)
    })
  })

  describe('zoomReset', () => {
    it('从非默认值重置到 1.0', () => {
      const store = useEditorStore()
      store.zoomLevel = 1.8
      const result = zoomReset(dummyState)
      expect(result).toBe(true)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_DEFAULT)
    })

    it('已经是默认值时仍返回 true', () => {
      const store = useEditorStore()
      store.zoomLevel = ZOOM_LEVEL_DEFAULT
      const result = zoomReset(dummyState)
      expect(result).toBe(true)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_DEFAULT)
    })
  })

  describe('非 Tauri 环境', () => {
    it('isTauri=false 时 zoomIn 返回 false 不改 store', async () => {
      const { isTauri } = await import('@tauri-apps/api/core')
      vi.mocked(isTauri).mockReturnValueOnce(false)
      const store = useEditorStore()
      const result = zoomIn(dummyState)
      expect(result).toBe(false)
      expect(store.zoomLevel).toBe(ZOOM_LEVEL_DEFAULT)
    })

    it('isTauri=false 时 zoomOut 返回 false', async () => {
      const { isTauri } = await import('@tauri-apps/api/core')
      vi.mocked(isTauri).mockReturnValueOnce(false)
      const result = zoomOut(dummyState)
      expect(result).toBe(false)
    })

    it('isTauri=false 时 zoomReset 返回 false', async () => {
      const { isTauri } = await import('@tauri-apps/api/core')
      vi.mocked(isTauri).mockReturnValueOnce(false)
      const result = zoomReset(dummyState)
      expect(result).toBe(false)
    })
  })
})

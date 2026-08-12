import type { Plugin } from 'prosemirror-state'

/**
 * A ProseMirror plugin wrapped with metadata for the resolver.
 *
 * The `id` is a stable string that identifies the plugin in the canonical
 * order list (`order.ts`). The optional `requires` array declares explicit
 * ordering dependencies — every id listed must appear **before** this plugin
 * in the resolved order.
 */
export interface PluginEntry {
  id: string
  plugin: Plugin
  /** ids that must appear before this plugin in the resolved order */
  requires?: string[]
}

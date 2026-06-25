<script setup lang="ts">
import { computed, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'

const win = getCurrentWindow()
const isMaximized = ref(false)

async function refreshMaximized() {
  try {
    isMaximized.value = await win.isMaximized()
  }
  catch {
    isMaximized.value = false
  }
}

function minimizeWindow() {
  void win.minimize()
}

async function toggleMaximizeWindow() {
  try {
    await win.toggleMaximize()
    await refreshMaximized()
  }
  catch {
    // 权限 / 平台异常时保持按钮静默,不打断编辑器主流程。
  }
}

function closeWindow() {
  void win.close()
}

const maximizeTitle = computed(() => isMaximized.value ? '还原' : '最大化')

void refreshMaximized()
void win.onResized(() => { void refreshMaximized() })
</script>

<template>
  <div class="window-controls flex h-10 shrink-0 items-center overflow-hidden rounded-xl border border-gray-200/70 bg-white/55 text-gray-500 shadow-sm shadow-gray-900/5 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-gray-300 dark:shadow-black/20">
    <button
      class="window-control window-control--minimize"
      title="最小化"
      aria-label="最小化窗口"
      @click="minimizeWindow"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 8.5h8" />
      </svg>
    </button>
    <button
      class="window-control"
      :title="maximizeTitle"
      :aria-label="`${maximizeTitle}窗口`"
      @click="toggleMaximizeWindow"
    >
      <svg v-if="!isMaximized" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.25" />
      </svg>
      <svg v-else viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6.25 4.25h5.5v5.5" />
        <path d="M4.25 6.25h5.5v5.5h-5.5z" />
      </svg>
    </button>
    <button
      class="window-control window-control--close"
      title="关闭"
      aria-label="关闭窗口"
      @click="closeWindow"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 5l6 6M11 5l-6 6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.window-control {
  display: inline-flex;
  width: 46px;
  height: 40px;
  align-items: center;
  justify-content: center;
  color: inherit;
  transition:
    color 140ms ease,
    background-color 140ms ease;
}

.window-control svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.7;
}

.window-control:hover {
  background: rgba(148, 163, 184, 0.16);
  color: #334155;
}

:global(.dark) .window-control:hover {
  background: rgba(255, 255, 255, 0.10);
  color: #f8fafc;
}

.window-control:focus-visible {
  outline: 2px solid var(--md-primary-color);
  outline-offset: -3px;
}

.window-control--close:hover {
  background: #e5484d;
  color: white;
}

:global(.dark) .window-control--close:hover {
  background: #ff5c63;
  color: #140406;
}
</style>

import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'

import './styles/index.scss'
import './styles/tailwind.css'
import { mark } from '@/utils/perf'

// 入口脚本第一行 —— 整条首屏指标链路的起点
mark('script-start')

const app = createApp(App)
app.use(createPinia())
app.mount('#app')

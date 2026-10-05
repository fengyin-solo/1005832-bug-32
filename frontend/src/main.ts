import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initializeSeedData, SeedConflictError } from './data/local-store'
import './styles/global.css'

// 本地开发初始化路径：每次启动都走一遍幂等初始化。
// 已是同一版示例数据会直接跳过；旧数据先备份再覆盖；编号冲突会挡回；失败可在概览页重试。
try {
  initializeSeedData()
} catch (error) {
  if (error instanceof SeedConflictError) {
    console.error('[初始化] 示例数据存在重复编号，已挡回，未覆盖本地数据：\n', error.conflicts)
  } else {
    console.error('[初始化] 示例数据灌入失败，原有数据已保留，可在概览页重试：', error)
  }
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

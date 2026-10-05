import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initializeDemoData } from './api/local-service'
import './styles/global.css'

// 启动先跑本地示例数据初始化：幂等，已初始化则直接跳过；被挡回也不阻塞页面，概览页可重试。
try {
  initializeDemoData()
} catch (error) {
  console.error('[初始化] 示例数据初始化失败，可在「运营概览」页修正后重试：', error)
}

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

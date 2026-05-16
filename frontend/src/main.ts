import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import './style.css'
import App from './App.vue'
import { useThemeStore } from './stores/theme'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)

// テーマストアを起動時に初期化(localStorageから復元 + data-theme属性付与)
useThemeStore()

app.mount('#app')

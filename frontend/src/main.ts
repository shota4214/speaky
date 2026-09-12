import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
// 丸ゴシック系フォント (オフライン動作のため npm パッケージでバンドル)
// Latin は Quicksand、日本語は M PLUS Rounded 1c が当たる
import '@fontsource/quicksand/400.css'
import '@fontsource/quicksand/500.css'
import '@fontsource/quicksand/700.css'
import '@fontsource/m-plus-rounded-1c/400.css'
import '@fontsource/m-plus-rounded-1c/500.css'
import '@fontsource/m-plus-rounded-1c/700.css'
import './style.css'
import App from './App.vue'
import { useThemeStore } from './stores/theme'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)

// テーマストアを起動時に初期化:
// - localStorage からテーマ復元 + data-theme 属性付与
// - settings.darkMode (system/light/dark) を読んで html.dark を mount 前に同期適用
//   (ちらつき防止のため app.mount より前に呼ぶ)
useThemeStore()

app.mount('#app')

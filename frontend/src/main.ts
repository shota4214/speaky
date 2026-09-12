import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
// 丸ゴシック系フォント (オフライン動作のため npm パッケージでバンドル)
// Latin は Quicksand、日本語は M PLUS Rounded 1c が当たる。
//
// 読み込む weight は UI で実際に使っているものだけに絞る:
// - Tailwind クラスとして使われているのは font-normal(400) / font-medium(500) /
//   font-semibold(600) / font-bold(700) の 4 つ。600 は実ファイルが無いので
//   CSS のフォントマッチングで 700 に解決される(従来から同じ挙動)。
// - Quicksand は latin のみのサブセットで全 weight 合わせても ~450KB なので 3 つ残す。
// - M PLUS Rounded 1c は CJK を含み 1 weight あたり dist で ~3.9MB / @font-face
//   126 個。500 は font-medium (サイドバーのナビ、フォームのラベル、バッジ) 用だが
//   日本語では 400 との差が小さいため落とし、400 にフォールバックさせる。
//   起動時に parse する CSS が ~120KB、DMG が ~3.9MB 軽くなる。
import '@fontsource/quicksand/400.css'
import '@fontsource/quicksand/500.css'
import '@fontsource/quicksand/700.css'
import '@fontsource/m-plus-rounded-1c/400.css'
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

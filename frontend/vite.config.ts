import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // base はデフォルト `/`。Electron でも backend が HTTP で serve するため
  // 絶対パス (/assets/...) の方が SPA fallback + ネスト route で正しく解決される。
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})

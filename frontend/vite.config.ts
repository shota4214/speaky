import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// root package.json の version を frontend に埋め込んでアプリ内バージョン通知から
// 参照する。電子側 (electron/package.json) と root は同じ version を維持する運用
// (CLAUDE.md の リリース手順を参照)。
const rootPkgPath = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'package.json')
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as { version: string }

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  // base はデフォルト `/`。Electron でも backend が HTTP で serve するため
  // 絶対パス (/assets/...) の方が SPA fallback + ネスト route で正しく解決される。
  server: {
    port: 5173,
    fs: {
      // `src/storage/settings.ts` は LLM カタログを
      // `backend/src/shared/llm-models.ts` から直接 import している
      // (backend と frontend の allowlist 二重化を消すため)。
      // npm workspaces のルートは Vite が自動検出するはずだが、
      // 検出に失敗すると dev server だけが 403 で落ちて build は通る、という
      // 気づきにくい壊れ方をするので明示しておく。
      allow: [path.resolve(fileURLToPath(import.meta.url), '..', '..')],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})

import { defineConfig } from 'vitest/config'

/**
 * backend のテスト設定。frontend/vitest.config.ts と意図的に同じ形にしてある
 * (環境は node、対象は src 配下の *.test.ts)。frontend と違い、
 * IndexedDB などのブラウザ API を差し替える setupFiles は要らない。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})

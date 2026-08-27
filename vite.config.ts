import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 既定は「コア数 - 1」だが、テストはどれも CPU を使い切る計算なので、
    // 空けておいた 1 コアはただ遊んでいる。コア数ぶん動かすと全体で 1 割
    // 短くなる (それ以上に増やしても縮まない)。
    maxWorkers: '100%',
  },
});

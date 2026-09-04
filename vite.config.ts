import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 線路を敷くテストだけだったころは、どれも短い計算なので全コアを使い切って
    // いた。運転シミュレータを移植して 1 kHz の物理が入ってからは事情が変わる。
    // 走らせる検定は 1 本が数十秒 CPU を握り続けるので、コアを埋め切ると本体
    // スレッドが飢え、進捗を報せる RPC (`onTaskUpdate`) が時間切れになる。
    // 検定はすべて通っているのに終了コードが 1 になり、しかも混み具合で出たり
    // 出なかったりする。空けておくコアは、もう遊んでいるのではなく本体の取り分。
    maxWorkers: 2,
    // 移植した物理の検定は 1 本で数分の走行を模すため、既定の 5 秒では足りない。
    testTimeout: 30_000,
  },
});

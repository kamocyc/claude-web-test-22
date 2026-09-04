import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 既定の「コア数 - 1」に戻してある。線路を敷くテストだけだったころは、
    // どれも短い計算なので 1 コア空けておくのは遊ばせるだけだった。運転
    // シミュレータを移植して 1 kHz の物理が入ってからは事情が変わり、全コアを
    // 計算で埋めると本体スレッドが飢えて、進捗を報せる RPC (`onTaskUpdate`) が
    // 時間切れになる。検定はすべて通っているのに終了コードが 1 になるので、
    // 空けた 1 コアはもう遊んではいない。
    //
    // 移植した物理の検定は 1 本で数分の走行を模すため、既定の 5 秒では足りない。
    testTimeout: 30_000,
  },
});

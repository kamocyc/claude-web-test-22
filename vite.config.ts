import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

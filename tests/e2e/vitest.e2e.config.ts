import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

export default defineConfig({
  root: repoRoot,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'https://zhuanlan.zhihu.com/write',
      },
    },
    include: ['tests/e2e/**/*.e2e.spec.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['tests/e2e/setup.ts'],
    globals: false,
    css: false,
    pool: 'forks',
    passWithNoTests: false,
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    hookTimeout: 10_000,
  },
});

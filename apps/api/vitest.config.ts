import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace libraries resolve to source under the test runner, so `pnpm test`
    // works on a clean checkout with no build step. The deployed artifact loads
    // the compiled JS declared in each package's `exports`.
    alias: {
      '@socialhub/kernel': fileURLToPath(
        new URL('../../libs/shared/kernel/src/index.ts', import.meta.url),
      ),
      '@socialhub/contracts': fileURLToPath(
        new URL('../../libs/shared/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  // NestJS dependency injection needs design:paramtypes metadata. Vite's esbuild
  // transform does not read `emitDecoratorMetadata` from tsconfig reliably across
  // workspace layouts, so it is declared explicitly here. Without it, class-typed
  // constructor parameters inject as `undefined` — a failure that is silent at
  // build time and fatal at runtime.
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        target: 'es2023',
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    // Schema and e2e suites share one database, so they must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});

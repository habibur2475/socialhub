import { defineConfig } from 'vitest/config';

export default defineConfig({
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

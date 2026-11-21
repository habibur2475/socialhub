import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@socialhub/kernel': fileURLToPath(new URL('../kernel/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    fileParallelism: false,
  },
});

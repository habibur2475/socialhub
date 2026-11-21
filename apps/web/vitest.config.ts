import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Workspace libraries resolve to source, so tests need no build step.
      '@socialhub/contracts': fileURLToPath(
        new URL('../../libs/shared/contracts/src/index.ts', import.meta.url),
      ),
      '@socialhub/config': fileURLToPath(
        new URL('../../libs/shared/config/src/index.ts', import.meta.url),
      ),
      // Most-specific first: aliases are matched in order, so the browser entry
      // must precede the server barrel or the subpath resolves to the wrong file.
      '@socialhub/kernel/browser': fileURLToPath(
        new URL('../../libs/shared/kernel/src/browser.ts', import.meta.url),
      ),
      '@socialhub/kernel': fileURLToPath(
        new URL('../../libs/shared/kernel/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    // A secure origin, because jsdom enforces the `__Host-` cookie prefix rules
    // exactly as a browser does: the prefix requires Secure and Path=/, and a
    // Secure cookie is only stored on an https origin. Testing the CSRF flow
    // against plain http would silently drop the cookie and prove nothing.
    environmentOptions: { jsdom: { url: 'https://localhost:3000' } },
    include: ['src/**/*.spec.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    restoreMocks: true,
  },
});

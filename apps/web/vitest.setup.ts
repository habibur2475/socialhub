import '@testing-library/dom';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * jsdom implements neither of these, and both are used by the shell:
 * `matchMedia` by the theme system, `ResizeObserver` by any component that
 * needs a measured size. Stubbing them here keeps each test about behaviour
 * rather than about environment gaps.
 */
if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * Next's router hooks throw outside a mounted app router. A component that calls
 * `useRouter` is not wrong for doing so, so the test environment supplies the
 * router rather than the component being refactored around the test.
 *
 * Only the navigation surface is mocked — not the component's own logic.
 */
const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

export { router as mockRouter };

/**
 * Explicit unmount after every test.
 *
 * Without it each render appends to a shared document, so the second test finds
 * two of every control. `globals: false` means Testing Library's automatic
 * cleanup is not registered, and a leaked document is exactly what produces the
 * confusing "found multiple elements" failure.
 */
afterEach(() => {
  cleanup();
});

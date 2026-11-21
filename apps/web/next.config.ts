import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Next.js configuration.
 *
 * Security headers are set here rather than in a reverse proxy so they hold in
 * every environment, including `next dev` and a static preview. NGINX will layer
 * its own policy on top in production, but it must not be the only place these
 * exist.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The workspace libraries ship TypeScript sources; Next compiles them as part
  // of the app rather than requiring a separate build step in development.
  transpilePackages: ['@socialhub/config', '@socialhub/contracts', '@socialhub/kernel'],

  /**
   * The libraries' `exports` map points `import` at compiled JS, which is what the
   * API's Node runtime executes. The browser bundle must use the TypeScript
   * sources instead: bundling prebuilt `.js` would mean the web app silently runs
   * a stale copy whenever a library is edited without a rebuild.
   *
   * These aliases are exact, so a subpath import is unaffected.
   */
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@socialhub/config': path.resolve(__dirname, '../../libs/shared/config/src/index.ts'),
      '@socialhub/contracts': path.resolve(__dirname, '../../libs/shared/contracts/src/index.ts'),
      // Exact-match aliases (`$`), not prefix aliases: a prefix alias for
      // `@socialhub/kernel` would also capture `@socialhub/kernel/browser` and
      // resolve it to the server-only barrel — which is the Node built-in leak
      // this pair exists to prevent.
      '@socialhub/kernel/browser$': path.resolve(
        __dirname,
        '../../libs/shared/kernel/src/browser.ts',
      ),
      '@socialhub/kernel$': path.resolve(__dirname, '../../libs/shared/kernel/src/index.ts'),
    };

    // The libraries use NodeNext resolution, so their internal imports carry a
    // `.js` extension even though the file on disk is `.ts` — that is what lets the
    // same source compile to ESM for Node and bundle for the browser. Webpack does
    // not assume it, so the mapping is stated explicitly.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };

    return config;
  },

  experimental: {
    // Tree-shake barrel files: importing one icon must not pull in the whole set.
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  /**
   * Same-origin API proxy.
   *
   * This is a correctness requirement, not a convenience. The refresh cookie is
   * `__Host-` prefixed and `SameSite=Strict`, and both only work as intended when
   * the browser sees one origin. Proxying `/api/*` to the API service means the
   * browser never makes a cross-site request, so no CORS preflight, no third-party
   * cookie policy, and no chance of a subtle same-site misclassification.
   */
  async rewrites() {
    const target = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

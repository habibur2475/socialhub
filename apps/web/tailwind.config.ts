/**
 * Tailwind configuration.
 *
 * The theme is not defined here — it is imported from `@socialhub/config`. That
 * keeps a single source of truth: the CSS custom properties in `globals.css`, the
 * TypeScript token values, and the utility classes Tailwind generates all derive
 * from the same objects, so a spacing change cannot leave one of them stale.
 *
 * Utilities reference CSS variables rather than literal colours. That is what
 * makes dark mode a variable swap instead of a `dark:` variant on every element —
 * twice the classes, twice the chance of forgetting one.
 */

import defaultTheme from 'tailwindcss/defaultTheme';
import type { Config } from 'tailwindcss';
import { breakpoints, layout, radius, spacing, typography } from '@socialhub/config';

/** Maps a token role to `rgb(var(--role) / <alpha-value>)` so opacity modifiers work. */
const semantic = (role: string): string => `rgb(var(--${role}) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    // Replacing rather than extending the default palette: an unlisted colour
    // cannot be used, which is how a design system actually stays consistent.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      canvas: semantic('canvas'),
      surface: semantic('surface'),
      raised: semantic('surface-raised'),
      border: semantic('border'),
      'border-strong': semantic('border-strong'),
      text: semantic('text'),
      muted: semantic('text-muted'),
      inverted: semantic('text-inverted'),
      primary: semantic('primary'),
      'primary-hover': semantic('primary-hover'),
      'primary-contrast': semantic('primary-contrast'),
      accent: semantic('accent'),
      success: semantic('success'),
      'success-surface': semantic('success-surface'),
      warning: semantic('warning'),
      'warning-surface': semantic('warning-surface'),
      danger: semantic('danger'),
      'danger-surface': semantic('danger-surface'),
      ring: semantic('focus-ring'),
    },
    /**
     * The named tokens are *added* to Tailwind's numeric scale, not substituted for it.
     *
     * Substitution looks tidy and is a trap: `spacing` is the base for `w`, `h`, `size`,
     * `gap`, `padding`, `margin` and `inset`, and replacing it means `size-4`, `h-11` and
     * `gap-1` stop existing. Tailwind does not warn — an unknown class is simply not
     * emitted — so every icon, avatar and button silently lost its dimensions and the only
     * symptom was a slightly wrong-looking page. `tools/class-check.mjs` now fails the
     * build if a utility is used but never defined.
     *
     * Numeric steps stay available for the small, mechanical sizes; the named tokens are
     * what component code should reach for, because they carry design intent.
     */
    spacing: { ...defaultTheme.spacing, ...spacing, auto: 'auto' },
    borderRadius: { ...defaultTheme.borderRadius, ...radius },
    screens: breakpoints,
    fontFamily: {
      sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
    },
    fontSize: Object.fromEntries(
      Object.entries(typography).map(([role, value]) => [
        role,
        [
          value.size,
          {
            lineHeight: value.lineHeight,
            letterSpacing: value.letterSpacing,
            fontWeight: value.weight,
          },
        ],
      ]),
    ),
    extend: {
      maxWidth: { content: layout.contentMax, shell: layout.shellMax },
      height: { header: layout.headerHeight, bottomNav: layout.bottomNavHeight },
      // `top-header` positions the sticky thead and the mobile drawer under the header.
      // It is an `extend` entry rather than a spacing token because it is a layout
      // measurement, not a step on the spacing scale.
      inset: { header: layout.headerHeight },
      minHeight: { touch: layout.touchTarget },
      minWidth: { touch: layout.touchTarget },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      transitionDuration: {
        instant: '100ms',
        fast: '150ms',
        base: '200ms',
        slow: '300ms',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0, 0.2, 1)',
      },
      keyframes: {
        // Skeletons shimmer; content never does. A pulsing layout would be
        // motion for its own sake, and it competes with reading.
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;

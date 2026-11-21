/**
 * Design tokens.
 *
 * Tokens are consumed as CSS custom properties, never as JavaScript objects, for
 * one reason above all others: a token change must not require a component
 * re-render or a bundle rebuild. The stylesheet owns the values; components only
 * reference them by name.
 *
 * The scale is fixed and deliberately small. A token system with forty spacing
 * values is a system nobody follows — the constraint is what produces visual
 * consistency, not the abundance.
 *
 * Spacing: 0, then 4 8 12 16 24 32 48 64. Every gap, pad and margin in the product
 * is one of these, so vertical rhythm holds across independently built screens.
 * The zero step is present because the CSS resets need it, and a scale that
 * cannot express "no spacing" is not a complete scale.
 *
 * Typography is a 16px root with a 1.25 modular ratio, rounded to whole pixels.
 * Body text is 16px, never smaller: anything below that is unreadable on a phone
 * held at arm's length, which is the device most of this product is used on.
 */

export const spacing = {
  /** Named `0` so it produces Tailwind's `p-0`, `m-0`, `gap-0` utilities. */
  '0': '0',
  xxs: '4px',
  xs: '8px',
  sm: '12px',
  md: '16px',
  lg: '24px',
  xl: '32px',
  xxl: '48px',
  xxxl: '64px',
} as const;

/**
 * Type scale, mobile-first. Names describe *role*, not size, so a component asks
 * for "a heading" and the stylesheet decides how large that is per breakpoint.
 */
export const typography = {
  display: { size: '2.5rem', lineHeight: '1.1', letterSpacing: '-0.02em', weight: '700' },
  heading: { size: '1.75rem', lineHeight: '1.2', letterSpacing: '-0.01em', weight: '700' },
  subheading: { size: '1.25rem', lineHeight: '1.3', letterSpacing: '-0.005em', weight: '600' },
  body: { size: '1rem', lineHeight: '1.6', letterSpacing: '0', weight: '400' },
  small: { size: '0.875rem', lineHeight: '1.5', letterSpacing: '0', weight: '400' },
  caption: { size: '0.75rem', lineHeight: '1.4', letterSpacing: '0.01em', weight: '500' },
} as const;

/** Radii stay in the 8–16px band: soft enough to feel modern, never pill-shaped. */
export const radius = {
  sm: '8px',
  md: '12px',
  lg: '16px',
  full: '9999px',
} as const;

/**
 * Motion is capped at 300ms. Longer than that and an interface feels broken;
 * shorter and the user's eye cannot follow what moved where.
 *
 * The reduced-motion override in the stylesheet collapses every transition to
 * ~0ms rather than removing it, because `transition: none` breaks properties that
 * depend on a transition to settle (e.g. sticky headers mid-scroll).
 */
export const motion = {
  instant: '100ms',
  fast: '150ms',
  base: '200ms',
  slow: '300ms',
  easing: 'cubic-bezier(0.2, 0, 0.2, 1)',
} as const;

/**
 * Breakpoints. Named for the device class actually being designed for, and
 * mobile-first: every base style is the phone, and each breakpoint adds.
 *
 * The large breakpoint exists because the desktop layout stops widening past
 * 1440px — an unbounded content column is unreadable at 2560px.
 */
export const breakpoints = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  xxl: '1536px',
} as const;

/** Layout limits. `content` is the reading measure; `shell` is the app chrome. */
export const layout = {
  contentMax: '720px',
  shellMax: '1440px',
  sidebarWidth: '260px',
  sidebarCollapsedWidth: '72px',
  headerHeight: '64px',
  bottomNavHeight: '64px',
  /** Every interactive target is at least this large, per WCAG 2.5.5. */
  touchTarget: '44px',
} as const;

/**
 * Elevation. Soft, low-opacity shadows in the 8–16px radius band; the point is
 * separation, not decoration. Dark mode uses light-on-dark shadows at lower
 * alpha, because a black shadow on a dark surface reads as a hole.
 */
export const elevation = {
  none: 'none',
  sm: '0 1px 2px rgb(16 24 40 / 0.06)',
  md: '0 2px 8px rgb(16 24 40 / 0.08)',
  lg: '0 8px 24px rgb(16 24 40 / 0.10)',
} as const;

/**
 * Z-index layers, named. Every stacking context in the product draws from this
 * list; an arbitrary `z-index: 9999` is how a tooltip ends up behind a toast.
 */
export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 100,
  header: 200,
  sidebar: 300,
  overlay: 400,
  modal: 500,
  popover: 600,
  toast: 700,
} as const;

export const tokens = {
  spacing,
  typography,
  radius,
  motion,
  breakpoints,
  layout,
  elevation,
  zIndex,
} as const;

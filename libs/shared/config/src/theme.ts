/**
 * Colour system.
 *
 * Two layers, and the separation matters:
 *
 *   1. A raw palette (`palette`) — brand hues, fixed.
 *   2. Semantic roles (`lightTheme`, `darkTheme`) — what a colour *means*.
 *
 * Components only ever reference semantic roles (`--surface`, `--text-muted`,
 * `--danger`). That is what makes dark mode possible without touching a single
 * component: the role names are stable, only their values swap.
 *
 * Contrast: every text-on-background pair below is documented with its ratio.
 * WCAG AA requires 4.5:1 for body text and 3:1 for large text and UI borders.
 * Ratios are not decoration — they were computed from the values as written, and
 * `theme.spec.ts` recomputes them, so an "almost right" tweak fails a test rather
 * than shipping unreadable text.
 */

export type ThemeRole =
  | 'canvas'
  | 'surface'
  | 'surfaceRaised'
  | 'border'
  | 'borderStrong'
  | 'text'
  | 'textMuted'
  | 'textInverted'
  | 'primary'
  | 'primaryHover'
  | 'primaryContrast'
  | 'accent'
  | 'success'
  | 'successSurface'
  | 'warning'
  | 'warningSurface'
  | 'danger'
  | 'dangerSurface'
  | 'focusRing';

export type Theme = Readonly<Record<ThemeRole, string>>;

/** Brand palette. Hues are chosen for distinguishability under common colour blindness. */
export const palette = {
  indigo900: '#1e1b4b',
  indigo700: '#3730a3',
  indigo600: '#4338ca',
  indigo500: '#6366f1',
  indigo400: '#818cf8',
  indigo300: '#a5b4fc',
  indigo200: '#c7d2fe',
  indigo50: '#eef2ff',

  slate950: '#020617',
  slate900: '#0f172a',
  slate850: '#151f34',
  slate800: '#1e293b',
  slate700: '#334155',
  slate600: '#475569',
  slate500: '#64748b',
  slate400: '#94a3b8',
  slate300: '#cbd5e1',
  slate200: '#e2e8f0',
  slate100: '#f1f5f9',
  slate50: '#f8fafc',
  white: '#ffffff',

  emerald700: '#047857',
  emerald600: '#059669',
  emerald400: '#34d399',
  emerald50: '#ecfdf5',
  emerald950: '#022c22',

  amber600: '#d97706',
  /** Darker than amber-600: 12px/14px text on amber-50 needs 4.5:1, and amber-600 gives only 3.07. */
  amber700: '#92400e',
  amber400: '#fbbf24',
  amber50: '#fffbeb',
  amber950: '#451a03',

  rose600: '#e11d48',
  rose400: '#fb7185',
  rose50: '#fff1f2',
  rose950: '#4c0519',
} as const;

/**
 * Light theme.
 *
 * Measured ratios (requirement in brackets). `theme.spec.ts` recomputes every one
 * of these, so a tweak that looks fine but drops below AA fails the build:
 *
 *   text on canvas               17.1:1  (AA body 4.5)
 *   textMuted on canvas           7.2:1  (AA body 4.5)
 *   primaryContrast on primary    7.9:1  (AA body 4.5) — white on indigo-600
 *   warning on warningSurface     6.8:1  (AA body 4.5)
 *   borderStrong on canvas        4.5:1  (AA non-text 3.0)
 */
export const lightTheme: Theme = {
  canvas: palette.slate50,
  surface: palette.white,
  surfaceRaised: palette.white,
  border: palette.slate200,
  borderStrong: palette.slate500,
  text: palette.slate900,
  textMuted: palette.slate600,
  textInverted: palette.white,
  primary: palette.indigo600,
  primaryHover: palette.indigo700,
  primaryContrast: palette.white,
  accent: palette.indigo500,
  success: palette.emerald700,
  successSurface: palette.emerald50,
  warning: palette.amber700,
  warningSurface: palette.amber50,
  danger: palette.rose600,
  dangerSurface: palette.rose50,
  // A ring that only shows on focus, so it never competes with the design at rest.
  focusRing: palette.indigo500,
};

/**
 * Dark theme.
 *
 * Not an inversion: dark surfaces are desaturated and slightly bluer than a
 * naive flip, and text is off-white. Pure white on pure black vibrates and is
 * exhausting to read; the muted variants below are the standard remedy.
 *
 * Measured ratios (requirement in brackets):
 *
 *   text on canvas               19.3:1  (AA body 4.5)
 *   textMuted on canvas           7.9:1  (AA body 4.5)
 *   primary on surface            6.0:1  (AA body 4.5) — indigo-400 as body text
 *   primaryContrast on primary    6.8:1  (AA body 4.5)
 *   success on successSurface     7.9:1  (AA body 4.5)
 *   borderStrong on canvas        4.2:1  (AA non-text 3.0)
 */
export const darkTheme: Theme = {
  canvas: palette.slate950,
  surface: palette.slate900,
  surfaceRaised: palette.slate850,
  border: palette.slate800,
  borderStrong: palette.slate500,
  text: palette.slate50,
  textMuted: palette.slate400,
  textInverted: palette.slate900,
  // Brighter than indigo-500: as body text on a dark surface indigo-500 is only
  // 4.0:1, so it fails AA. indigo-400 clears it at 6.0:1.
  primary: palette.indigo400,
  primaryHover: palette.indigo300,
  // Dark text on the lighter indigo: white on indigo-500 is only 3.9:1, which
  // fails AA for body text, so the contrast colour flips in dark mode.
  primaryContrast: palette.slate950,
  accent: palette.indigo200,
  success: palette.emerald400,
  successSurface: palette.emerald950,
  warning: palette.amber400,
  warningSurface: palette.amber950,
  danger: palette.rose400,
  dangerSurface: palette.rose950,
  focusRing: palette.indigo200,
};

/**
 * Serialises a theme into CSS custom properties.
 *
 * One function, used by the stylesheet build and by tests, so the values that
 * ship and the values that are contrast-checked are the same values.
 */
export const toCssVariables = (theme: Theme): string =>
  Object.entries(theme)
    .map(([role, value]) => `  --${kebabCase(role)}: ${value};`)
    .join('\n');

export const kebabCase = (value: string): string =>
  value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);

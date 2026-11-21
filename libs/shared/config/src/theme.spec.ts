import { describe, expect, it } from 'vitest';

import { WCAG, contrastRatio, meetsContrast, parseHex } from './contrast.js';
import { darkTheme, lightTheme, toCssVariables, type Theme } from './theme.js';
import { spacing, typography } from './tokens.js';

/**
 * Every pair a user actually reads. If a value in `theme.ts` is edited without
 * checking contrast, this fails — which is the entire point of computing rather
 * than asserting the ratios in a comment.
 */
const contrastPairs = (
  theme: Theme,
): ReadonlyArray<{ name: string; fg: string; bg: string; min: number }> => [
  { name: 'text / canvas', fg: theme.text, bg: theme.canvas, min: WCAG.bodyText },
  { name: 'text / surface', fg: theme.text, bg: theme.surface, min: WCAG.bodyText },
  { name: 'textMuted / canvas', fg: theme.textMuted, bg: theme.canvas, min: WCAG.bodyText },
  { name: 'textMuted / surface', fg: theme.textMuted, bg: theme.surface, min: WCAG.bodyText },
  {
    name: 'primaryContrast / primary',
    fg: theme.primaryContrast,
    bg: theme.primary,
    min: WCAG.bodyText,
  },
  { name: 'primary / surface', fg: theme.primary, bg: theme.surface, min: WCAG.bodyText },
  { name: 'danger / surface', fg: theme.danger, bg: theme.surface, min: WCAG.bodyText },
  {
    name: 'success / successSurface',
    fg: theme.success,
    bg: theme.successSurface,
    min: WCAG.bodyText,
  },
  {
    name: 'warning / warningSurface',
    fg: theme.warning,
    bg: theme.warningSurface,
    min: WCAG.bodyText,
  },
  {
    name: 'borderStrong / canvas',
    fg: theme.borderStrong,
    bg: theme.canvas,
    min: WCAG.largeTextAndUi,
  },
  { name: 'focusRing / surface', fg: theme.focusRing, bg: theme.surface, min: WCAG.largeTextAndUi },
];

describe.each([
  ['light', lightTheme],
  ['dark', darkTheme],
] as const)('%s theme contrast', (_name, theme) => {
  it.each(contrastPairs(theme))('$name meets $min:1', ({ fg, bg, min }) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});

describe('contrast maths', () => {
  it('gives 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#4338ca', '#4338ca')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#0f172a', '#f8fafc')).toBeCloseTo(
      contrastRatio('#f8fafc', '#0f172a'),
      10,
    );
  });

  it('expands three-digit hex identically to six-digit', () => {
    expect(parseHex('#fff')).toEqual(parseHex('#ffffff'));
    expect(parseHex('#08f')).toEqual({ r: 0x00, g: 0x88, b: 0xff });
  });

  it('refuses to guess at malformed input', () => {
    expect(() => parseHex('#12345')).toThrow(/Invalid hex/);
    expect(() => parseHex('rebeccapurple')).toThrow(/Invalid hex/);
    expect(() => parseHex('#gggggg')).toThrow(/Invalid hex/);
  });

  it('knows when a pair fails', () => {
    // White on indigo-500 is the classic near-miss: 3.9:1, fine for a border,
    // not fine for body text. This is why dark mode flips primaryContrast.
    expect(meetsContrast('#ffffff', '#6366f1', WCAG.bodyText)).toBe(false);
    expect(meetsContrast('#ffffff', '#6366f1', WCAG.largeTextAndUi)).toBe(true);
  });
});

describe('design tokens', () => {
  it('serialises a theme into kebab-case custom properties', () => {
    const css = toCssVariables(lightTheme);
    expect(css).toContain('--surface-raised:');
    expect(css).toContain('--text-muted:');
    expect(css).toContain('--focus-ring:');
    // Camel-case must never survive into CSS, where it would silently not apply.
    expect(css).not.toMatch(/--[a-z-]*[A-Z]/);
  });

  it('keeps the spacing scale to the eight agreed steps', () => {
    expect(Object.keys(spacing)).toHaveLength(9);
    expect(Object.values(spacing).slice(1)).toEqual([
      '4px',
      '8px',
      '12px',
      '16px',
      '24px',
      '32px',
      '48px',
      '64px',
    ]);
  });

  it('never sets body text below 16px', () => {
    const bodySize = Number.parseFloat(typography.body.size);
    expect(bodySize).toBeGreaterThanOrEqual(1);
    // Root is 16px, so 1rem is the floor for reading text.
    expect(Number.parseFloat(typography.small.size)).toBeGreaterThanOrEqual(0.875);
  });
});

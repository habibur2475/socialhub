/**
 * WCAG contrast maths.
 *
 * This exists as production code rather than a test helper because the theme
 * documentation quotes ratios, and a quoted ratio that nobody can recompute is a
 * claim rather than a fact. The same function backs the tests, so every number in
 * `theme.ts` is verifiable by running one command.
 *
 * Reference: WCAG 2.2, "Relative luminance" and "Contrast ratio".
 */

export type Rgb = { readonly r: number; readonly g: number; readonly b: number };

/** Parses `#rgb` and `#rrggbb`. Throws on anything else rather than guessing. */
export const parseHex = (hex: string): Rgb => {
  const value = hex.trim().replace(/^#/, '');

  const expand = (character: string): number => {
    const nibble = Number.parseInt(character + character, 16);
    return Number.isNaN(nibble) ? Number.NaN : nibble;
  };

  if (value.length === 3) {
    const r = expand(value.charAt(0));
    const g = expand(value.charAt(1));
    const b = expand(value.charAt(2));
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      throw new Error(`Invalid hex colour: ${hex}`);
    }
    return { r, g, b };
  }

  if (value.length === 6) {
    const r = Number.parseInt(value.slice(0, 2), 16);
    const g = Number.parseInt(value.slice(2, 4), 16);
    const b = Number.parseInt(value.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      throw new Error(`Invalid hex colour: ${hex}`);
    }
    return { r, g, b };
  }

  throw new Error(`Invalid hex colour: ${hex}`);
};

/**
 * sRGB relative luminance. The 0.03928 breakpoint is the linearisation knee, and
 * the coefficients are the CIE 1931 values WCAG specifies — not the approximations
 * some snippets use, which shift ratios by a few tenths.
 */
export const relativeLuminance = (colour: Rgb): number => {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
};

/** Contrast ratio in the range 1–21. Order-independent. */
export const contrastRatio = (foreground: string, background: string): number => {
  const a = relativeLuminance(parseHex(foreground));
  const b = relativeLuminance(parseHex(background));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
};

export const WCAG = {
  /** Body text under 18.66px (24px) normal weight, or 14px bold. */
  bodyText: 4.5,
  /** Text at 18.66px+ normal, 14px+ bold, and all non-text UI boundaries. */
  largeTextAndUi: 3,
} as const;

export const meetsContrast = (
  foreground: string,
  background: string,
  minimum: number = WCAG.bodyText,
): boolean => contrastRatio(foreground, background) >= minimum;

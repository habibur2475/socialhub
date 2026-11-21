# Design system

Everything visual is derived from three files. Nothing else defines a colour, a
spacing value, or a type size.

| File                               | Owns                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `libs/shared/config/src/tokens.ts` | spacing, type scale, radii, motion, breakpoints, layout, elevation, z-index |
| `libs/shared/config/src/theme.ts`  | the light and dark palettes, as semantic roles                              |
| `apps/web/src/app/globals.css`     | those values as CSS custom properties, plus base styles                     |

## Why tokens are CSS variables, not JavaScript

A token change must repaint without a React render. If `--primary` lives in a
stylesheet, changing the theme swaps one attribute on `<html>` and the browser
repaints; components do not re-render, and no bundle is rebuilt. Dark mode here is
therefore a variable swap, not a `dark:` variant on every element — which would
double the class strings and guarantee that one of them is eventually forgotten.

Tailwind is configured _from_ these objects, so it cannot drift from them. A
colour that is not in the theme does not exist as a utility; a spacing value that
is not on the scale cannot be used. That constraint is the point: consistency
comes from the palette being closed.

## The scale

**Spacing:** `0, 4, 8, 12, 16, 24, 32, 48, 64` px. The zero step exists because the
CSS resets need `m-0`. Hairlines (`1px` borders) and `2px` optical nudges are
written as arbitrary values (`h-[1px]`) precisely because they are _not_ layout
rhythm — if they were named tokens, the scale would stop meaning anything.

**Type:** a 16px root and a 1.25 ratio, named by role rather than size —
`display`, `heading`, `subheading`, `body`, `small`, `caption`. A component asks
for "a heading" and the stylesheet decides how large that is per breakpoint.
Body text is 16px and is never smaller: below that, a phone at arm's length
becomes unreadable, and 16px is also the threshold under which iOS Safari zooms
the viewport on focus.

**Radii:** 8–16px. **Motion:** 100/150/200/300 ms, capped at 300 — longer feels
broken, shorter cannot be followed. **Elevation:** three soft, low-alpha shadows.
**Z-index:** eight named layers; an arbitrary `9999` is how a tooltip ends up
behind a toast.

## Contrast is computed, not claimed

`libs/shared/config/src/contrast.ts` implements the WCAG 2.2 relative-luminance
and contrast-ratio formulas as **production code**, and `theme.spec.ts` runs every
text/background pair a user actually reads through it.

This is not ceremony. Writing the checker found four failures in the first draft
of the dark theme:

| Pair                              | Requirement | Before | After            |
| --------------------------------- | ----------- | ------ | ---------------- |
| light: warning on warning surface | 4.5         | 3.07   | 6.8 (amber-700)  |
| light: strong border on canvas    | 3.0         | 2.45   | 4.5 (slate-500)  |
| dark: primary as body text        | 4.5         | 4.00   | 6.0 (indigo-400) |
| dark: strong border on canvas     | 3.0         | 2.66   | 4.2 (slate-500)  |

Each of those would have shipped as unreadable text or an invisible boundary,
and each was invisible to the eye on a well-calibrated monitor. The documented
ratios in `theme.ts` are the measured values, and the same test recomputes them.

## Layout rules

- **One responsive codebase.** Base styles are the phone; breakpoints add.
- **Sidebar from `lg` up only.** A permanent 260px rail on a 390px screen leaves
  130px of content.
- **Bottom navigation caps at five items** — enforced by the `NavItem` type — so
  each target keeps its 44px minimum width on a 320px screen.
- **One scroll container** (`<main>`), so scroll restoration and pull-to-refresh
  behave predictably.
- **Desktop content is capped** (`max-width: 720px` for reading, `1440px` for the
  shell). Unbounded text columns are unreadable at 2560px.

## Accessibility, structurally

| Requirement | How it is met                                                                     |
| ----------- | --------------------------------------------------------------------------------- |
| Labels      | Real `<label for>` on every input. Placeholders are never used as labels.         |
| Errors      | `aria-describedby` + `aria-invalid`, announced once via `role="alert"`.           |
| Focus       | `:focus-visible` ring on everything interactive, from the token theme.            |
| Keyboard    | Skip link first in the document; menus close on Escape and outside click.         |
| Touch       | Every target is at least 44×44px (`layout.touchTarget`).                          |
| Zoom        | `maximumScale: 5` and no `user-scalable=no`, per WCAG 1.4.4.                      |
| Motion      | `prefers-reduced-motion` collapses transitions to ~0ms rather than removing them. |
| Language    | `<html lang>` set; required fields marked with the word, not only an asterisk.    |

## Loading states

The hierarchy is **skeleton → spinner → progress**, and the order is deliberate:

1. **Skeleton** is the default. It preserves layout, so nothing jumps when data
   arrives. A centred spinner on a page that becomes a list guarantees a reflow.
2. **Spinner** is for an action with no known shape — a submit, a mutation.
3. **Progress** is for something measurable — uploads, multi-step imports.

## The JavaScript budget

`pnpm check:budget` reads Next's `app-build-manifest.json`, gzips the chunks each
route actually loads on entry, and fails if any route exceeds 250 kB. It measures
per-route initial load rather than the whole build, because a total that grows
with every new page punishes the wrong thing.

Current: 100.2 kB (`/_not-found`) to 129.5 kB (`/register`).

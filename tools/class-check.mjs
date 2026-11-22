/**
 * Reports utility classes used in the web app that the stylesheet never defines.
 *
 * Tailwind is silent about a class it does not recognise: the class is simply absent from
 * the CSS, the element falls back to its default size, and the only symptom is something
 * looking subtly wrong in a screenshot. That is how `size-11` on every avatar produced a
 * squashed circle that no test noticed.
 *
 * The check is deliberately narrow rather than clever: it looks for utility shapes it can
 * reason about (layout, spacing, sizing, typography) and ignores anything else. A false
 * negative is fine; a false positive would train people to ignore the output.
 *
 * Usage: `node tools/class-check.mjs` after `next build`, with the compiled CSS on disk.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'apps/web/src';
const CSS_DIR = 'apps/web/.next/static/css';

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.tsx')) files.push(full);
  }
};
walk(SRC);

const css = readdirSync(CSS_DIR)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(join(CSS_DIR, name), 'utf8'))
  .join('\n');

/**
 * Every class selector the stylesheet defines, unescaped.
 *
 * Declaration bodies are blanked first. Otherwise a decimal like `line-height:1.625` reads as
 * a selector starting at the dot, which silently swallows the following rule's name and
 * makes the check report classes that do exist.
 */
const selectorsOnly = css.replace(/\{[^}]*\}/g, '{}');
const defined = new Set();
for (const match of selectorsOnly.matchAll(/\.((?:\\.|[^\s,{:>~+()[\]])+)/g)) {
  defined.add(match[1].replaceAll('\\', ''));
}

/**
 * Only families that a design-token override can break by accident. Colours, states
 * (`hover:`), and one-off arbitrary values are left out: they cannot be checked this way
 * without guessing.
 */
const CHECKED =
  /^(?:[a-z-]+:)*(?:size|w|h|min-w|min-h|max-w|max-h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|bottom|left|right|text|rounded|border|leading|tracking)-[a-z0-9.[\]/%-]+$/;

const used = new Map();
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const value = match[1] ?? match[2] ?? '';
    for (const token of value.split(/[\s${}]+/)) {
      const clean = token.trim();
      if (clean.length === 0 || !/^[a-z]/.test(clean)) continue;
      if (!CHECKED.test(clean)) continue;
      if (!used.has(clean)) used.set(clean, new Set());
      used.get(clean).add(file);
    }
  }
}

const missing = [...used].filter(([token]) => !defined.has(token));

if (missing.length === 0) {
  console.log(`class-check: all ${used.size} checked utilities are defined`);
  process.exit(0);
}

console.error(`class-check: ${missing.length} utilities are used but never defined:\n`);
for (const [token, where] of missing.sort((a, b) => b[1].size - a[1].size)) {
  console.error(`  ${token}  (${where.size} file(s), e.g. ${[...where][0]})`);
}
process.exit(1);

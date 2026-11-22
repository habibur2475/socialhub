/**
 * The tools kernel, one folder per tool.
 *
 * Each subfolder is a self-contained module with its own barrel, so a page imports the
 * arithmetic it needs and nothing else. The shared `calendar.ts` is the one deliberate
 * dependency between tools: an age calculator, a budget month and a period prediction all
 * ask the same question about days, and three private implementations of "how many days
 * between these two dates" is three chances to disagree.
 *
 * A tool's folder here is its **policy**; the UI lives in `apps/web/src/components/tools/<tool>/`
 * under the same name. The two lists are meant to stay the same list.
 */

export * from './calendar.js';

export * from './pdf-editor/index.js';
export * from './qr-code/index.js';
export * from './notes/index.js';
export * from './calculator/index.js';
export * from './age-calculator/index.js';
export * from './budget/index.js';
export * from './period/index.js';

/**
 * Bundle budget check.
 *
 * The performance target is an initial JS budget of 200–250 kB compressed. A budget
 * that lives only in a document is a wish; the first component-library import
 * quietly doubles it. This enforces it.
 *
 * What it measures matters. Summing the whole build would count chunks that are
 * only fetched by routes the user never opens, and would grow with every new page —
 * a number that punishes the wrong thing. Instead this reads Next's own
 * `app-build-manifest.json`, which lists exactly the chunks a route loads on entry,
 * and checks each route against the budget.
 */

import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const BUDGET_BYTES = 250 * 1024;
const WEB_ROOT = path.join('apps', 'web');
const MANIFEST = path.join(WEB_ROOT, '.next', 'app-build-manifest.json');

/** Gzip size of one file, measured rather than estimated. */
const gzipSize = async (file) => {
  let total = 0;
  const counter = new Writable({
    write(chunk, _encoding, callback) {
      total += chunk.length;
      callback();
    },
  });

  await pipeline(createReadStream(file), createGzip({ level: 9 }), counter);
  return total;
};

/** Shares one measurement across routes, since most chunks appear in many of them. */
const sizeCache = new Map();
const sizeOf = async (relative) => {
  const cached = sizeCache.get(relative);
  if (cached !== undefined) return cached;

  const absolute = path.join(WEB_ROOT, '.next', relative);
  const size = existsSync(absolute) ? await gzipSize(absolute) : 0;
  sizeCache.set(relative, size);
  return size;
};

if (!existsSync(MANIFEST)) {
  console.error(`No web build found at ${MANIFEST} — run the web build first.`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
const routes = Object.entries(manifest.pages).filter(([route]) => route.endsWith('/page'));

if (routes.length === 0) {
  console.error('The build manifest contains no pages.');
  process.exit(1);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
const results = [];

for (const [route, files] of routes) {
  let total = 0;
  for (const file of files) total += await sizeOf(file);
  results.push({ route: route.replace(/\/page$/, '') || '/', total });
}

results.sort((a, b) => b.total - a.total);

console.log(`budget: ${kb(BUDGET_BYTES)} compressed initial JS per route\n`);
for (const { route, total } of results) {
  const mark = total > BUDGET_BYTES ? 'OVER' : 'ok  ';
  console.log(`  ${mark}  ${kb(total).padStart(8)}  ${route}`);
}

const over = results.filter(({ total }) => total > BUDGET_BYTES);
if (over.length > 0) {
  console.error(
    `\n${over.length} route(s) exceed the budget by up to ${kb(
      Math.max(...over.map(({ total }) => total)) - BUDGET_BYTES,
    )}.`,
  );
  process.exit(1);
}

console.log('\nEvery route is within budget.');

/**
 * Screenshot tour.
 *
 * What this is for: a person who cannot easily run the stack should be able to *see* it. It
 * walks the real application — a real Postgres, a real API, a real `next start` — and writes
 * one PNG per screen into `docs/screenshots/`.
 *
 * Two decisions:
 *
 * * **The signed-in screens really are signed in.** The script fills the login form like a
 *   person, rather than injecting a token, so a broken session flow fails the tour instead
 *   of being papered over.
 * * **It asserts as it goes.** A screenshot of an error page is worthless, so each step
 *   checks for something that only renders once the data has loaded.
 *
 * Usage: `node tools/screenshot-tour.mjs` with `WEB_URL` pointing at a running app and
 * `DATABASE_URL` pointing at the seeded database.
 */

import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const WEB = process.env['WEB_URL'] ?? 'http://localhost:3000';
const OUT = process.env['SHOT_DIR'] ?? 'docs/screenshots';
const EMAIL = 'ada@socialhub.test';
const PASSWORD = 'SocialHub-demo-2026';

const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const failures = [];
let shot = 0;

/**
 * Photographs one route.
 *
 * `expect` is a text or selector that must appear before the picture is taken. Capturing
 * whatever is on screen would happily record a spinner or an error banner.
 */
const capture = async (page, name, path, expect) => {
  await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });

  if (expect !== undefined) {
    const found = await page
      .locator(expect)
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!found) {
      failures.push(`${name} (${path}): expected ${expect}`);
      console.warn(`  ! ${name}: ${expect} never appeared`);
    }
  }

  // Let fonts settle and the last of the layout shift finish before the shutter.
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `${OUT}/${String(++shot).padStart(2, '0')}-${name}.png`,
    fullPage: true,
  });
  console.log(`  ok ${name}`);
};

const phone = await browser.newContext({ viewport: MOBILE, deviceScaleFactor: 2 });
const desktop = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });

// ---------------------------------------------------------------- signed out
const anon = await desktop.newPage();
await capture(anon, 'marketing', '/', 'text=SocialHub');
await capture(anon, 'login', '/login', 'text=Sign in');
await capture(anon, 'register', '/register', 'text=Create');

// ----------------------------------------------------------------- signed in
const page = await desktop.newPage();
await page.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
await page.getByLabel(/email/i).fill(EMAIL);
await page.getByLabel(/password/i).fill(PASSWORD);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
console.log('  ok signed in as ada');

await capture(page, 'feed', '/', 'text=Ada Lovelace');
await capture(page, 'dashboard', '/dashboard', 'text=Ada Lovelace');
await capture(page, 'profile', '/u/ada', 'text=Ada Lovelace');
await capture(page, 'notifications', '/notifications', 'main');
await capture(page, 'quiz-library', '/quiz', 'text=Engines and algorithms');
await capture(page, 'forum', '/forum', 'text=How do you test a scheduler');
await capture(page, 'messages', '/messages', 'main');
await capture(page, 'blog', '/blog', 'text=Why the market holds stock');
await capture(page, 'article', '/blog/why-the-market-holds-stock-instead-of-counting-it', 'main');
await capture(page, 'tools', '/tools', 'text=Notes');
await capture(page, 'tool-budget', '/tools/budget', 'main');
await capture(page, 'tool-age', '/tools/age-calculator', 'main');
await capture(page, 'notes', '/tools/notes', 'text=Shopping');
await capture(page, 'market', '/market', 'text=Hand-thrown clay kettle');
await capture(
  page,
  'market-listing',
  '/market/hand-thrown-clay-kettle',
  'text=Hand-thrown clay kettle',
);
await capture(page, 'market-new', '/market/new', 'text=Put on sale');
await capture(page, 'market-cart', '/market/cart', 'main');
await capture(page, 'orders', '/market/orders', 'text=Hand-thrown clay kettle');
await capture(page, 'settings', '/settings/profile', 'text=Display name');

// -------------------------------------------------------------------- mobile
const mobilePage = await phone.newPage();
await mobilePage.goto(`${WEB}/login`, { waitUntil: 'networkidle' });
await mobilePage.getByLabel(/email/i).fill(EMAIL);
await mobilePage.getByLabel(/password/i).fill(PASSWORD);
await mobilePage.getByRole('button', { name: /sign in/i }).click();
await mobilePage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });

await mobilePage.locator('nav[aria-label="Primary"]').first().waitFor({ timeout: 20_000 });

await capture(mobilePage, 'mobile-feed', '/', 'main');
await capture(mobilePage, 'mobile-market', '/market', 'main');
await capture(mobilePage, 'mobile-tools', '/tools', 'text=Notes');

await browser.close();

console.log(`\n${shot} screenshots written to ${OUT}`);
if (failures.length > 0) {
  console.error(`${failures.length} screen(s) did not render what was expected:\n`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

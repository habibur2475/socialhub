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
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { chromium } from 'playwright';

const WEB = process.env['WEB_URL'] ?? 'http://localhost:3000';
const OUT = process.env['SHOT_DIR'] ?? 'docs/screenshots';
const EMAIL = 'ada@socialhub.test';
const PASSWORD = 'SocialHub-demo-2026';

const DESKTOP = { width: 1440, height: 1000 };
const MOBILE = { width: 390, height: 844 };

await mkdir(OUT, { recursive: true });

// Start from nothing. Numbering shifts whenever a screen is added, so leaving the old files
// behind would commit a mix of runs — indistinguishable in a diff from a screen that was
// renamed, and quietly stale.
for (const file of readdirSync(OUT)) {
  if (file.endsWith('.png')) rmSync(`${OUT}/${file}`);
}

/**
 * Ids written by `tools/seed-demo.mjs`.
 *
 * Screens like a single thread or a single order need a real row. Addressing them by UUID
 * from here would make the tour depend on a particular database; reading the ids the seed
 * just produced keeps the tour honest about the data it is photographing.
 */
const demo = JSON.parse(readFileSync(`${OUT}/demo-ids.json`, 'utf8'));

// `--host-resolver-rules` points the tour's hostname at the machine: the certificate is
// issued for `socialhub.localhost`, and Chromium does not resolve `*.localhost` on its own in
// every environment.
const browser = await chromium.launch({
  args: ['--host-resolver-rules=MAP socialhub.localhost 127.0.0.1', '--ignore-certificate-errors'],
});

/**
 * Waits for a page to be usable rather than for the network to fall idle.
 *
 * `networkidle` is the obvious choice and it is wrong here: the notification stream is a
 * long-lived `text/event-stream` response, so the network is *never* idle on a signed-in
 * page. Waiting for it means waiting forever — which is exactly what happened, as a 30s
 * timeout on the first reload after signing in.
 *
 * `domcontentloaded` plus a short settle is the honest signal: the HTML is parsed, React
 * has started, and the per-screen assertion that follows is what actually decides whether
 * the content rendered.
 */
const open = async (page, url) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
};

const failures = [];
let shot = 0;

/**
 * Photographs one route.
 *
 * `expect` is a text or selector that must appear before the picture is taken. Capturing
 * whatever is on screen would happily record a spinner or an error banner.
 */
const capture = async (page, name, path, expect) => {
  await open(page, `${WEB}${path}`);

  let problem = null;

  if (expect !== undefined) {
    const found = await page
      .locator(expect)
      .first()
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!found) problem = `expected ${expect}`;
  }

  // A screenshot is worth keeping only if it is the page we asked for. A redirect to the
  // login form renders as a perfectly good picture of the login form, which is exactly how a
  // broken session went unnoticed the first time this ran.
  const landed = new URL(page.url());
  if (problem === null && landed.pathname !== path.split('?')[0]) {
    problem = `redirected to ${landed.pathname}`;
  }

  if (problem !== null) {
    failures.push(`${name} (${path}): ${problem}`);
    console.warn(`  ! ${name}: ${problem}`);
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
await open(page, `${WEB}/login`);
await page.getByLabel(/email/i).fill(EMAIL);
await page.getByLabel(/password/i).fill(PASSWORD);
await page.getByRole('button', { name: /sign in/i }).click();
await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });

/**
 * Signing in is not enough: every screenshot below is a fresh navigation, and a fresh
 * navigation can only keep the session if the HttpOnly refresh cookie was actually
 * stored. That is where a `__Host-` cookie goes wrong silently — a wrong `Path` or a
 * missing `Secure` flag makes the browser drop it, the in-memory access token survives
 * the current page anyway, and the first reload looks like "my login did not stick".
 */
const sessionCookies = await page.context().cookies();
const stored = new Set(sessionCookies.map((cookie) => cookie.name));
for (const name of ['__Host-sh_rt', '__Host-sh_csrf']) {
  if (!stored.has(name)) failures.push(`session: the browser refused the ${name} cookie`);
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
if (new URL(page.url()).pathname.startsWith('/login')) {
  failures.push('session: a reload after signing in fell back to the login form');
}
console.log(`  ok signed in as ada (${stored.size} cookies stored)`);

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

// ------------------------------------------------- the screens behind a single row
//
// Each of these needs an id, which is why they were missing from the first tour even though
// they are ordinary pages a person reaches by clicking a list item.
await capture(page, 'post', `/posts/${demo.post}`, 'main');
await capture(page, 'forum-thread', `/forum/threads/${demo.thread}`, 'main');
await capture(page, 'forum-new', '/forum/new', 'main');
await capture(page, 'quiz', `/quiz/${demo.quiz}`, 'main');
await capture(page, 'quiz-new', '/quiz/new', 'main');
await capture(page, 'conversation', `/messages/${demo.conversation}`, 'main');
await capture(page, 'message-new', '/messages/new', 'main');
await capture(page, 'blog-new', '/blog/new', 'main');
await capture(page, 'order', `/market/orders/${demo.order}`, 'main');
await capture(page, 'listing-edit', '/market/hand-thrown-clay-kettle/edit', 'main');
await capture(page, 'calculator', '/tools/calculator', 'main');
await capture(page, 'pdf-editor', '/tools/pdf-editor', 'main');
await capture(page, 'period', '/tools/period', 'main');
await capture(page, 'qr-code', '/tools/qr-code', 'main');
await capture(page, 'note', '/tools/notes', 'text=Shopping');

// The recovery screens live in the signed-out area. They are photographed with a fresh,
// cookie-free context so the app does not bounce an authenticated visitor back to the feed,
// which is what these pages do by design.
await capture(anon, 'forgot-password', '/forgot-password', 'text=Reset');
await capture(anon, 'reset-password', '/reset-password?email=ada@socialhub.test', 'text=password');
await capture(anon, 'verify-email', '/verify-email', 'main');
await capture(anon, 'offline', '/offline', 'main');

// -------------------------------------------------------------------- mobile
const mobilePage = await phone.newPage();
await open(mobilePage, `${WEB}/login`);
await mobilePage.getByLabel(/email/i).fill(EMAIL);
await mobilePage.getByLabel(/password/i).fill(PASSWORD);
await mobilePage.getByRole('button', { name: /sign in/i }).click();
await mobilePage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
await mobilePage.reload({ waitUntil: 'domcontentloaded' });
await mobilePage.waitForTimeout(1500);
if (new URL(mobilePage.url()).pathname.startsWith('/login')) {
  failures.push('session (mobile): a reload after signing in fell back to the login form');
}

// `nav[aria-label="Primary"]` matches three elements — the desktop sidebar, the drawer and
// the bottom bar — and `.first()` picks the *hidden* sidebar at phone width. The bottom bar
// is the one that proves the mobile shell is up.
await mobilePage.locator('nav[aria-label="Primary"]:visible').first().waitFor({ timeout: 20_000 });

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

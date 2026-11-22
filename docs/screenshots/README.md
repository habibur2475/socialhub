# Screenshots

One PNG per screen, written by `tools/screenshot-tour.mjs` in the `Screenshots`
GitHub Actions workflow — a real Chromium against a real Postgres, a real API and
a real `next start`. Nothing here is a mock-up.

Each file is named `<order>-<screen>.png`; the order is the order a new visitor
meets the product. The tour asserts as it goes, so a picture only exists if the
screen actually rendered its data.

To refresh them locally:

```bash
pnpm --filter @socialhub/db run setup          # once
pnpm -r build
node apps/api/dist/main.js &                   # port 4000
pnpm --filter @socialhub/web start &           # port 3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/socialhub \
  API_BASE=http://localhost:4000 pnpm seed:demo
pnpm exec playwright install chromium          # once
pnpm shots
```

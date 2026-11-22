# Screenshots

One PNG per screen, written by `tools/screenshot-tour.mjs` in the `Screenshots`
GitHub Actions workflow — a real Chromium against a real Postgres, a real API and
a real `next start`. Nothing here is a mock-up.

Each file is named `<order>-<screen>.png`; the order is the order a new visitor
meets the product. The tour asserts as it goes, so a picture only exists if the
screen actually rendered its data. The 43 captures below are every page the app
has, plus three at phone width.

## Signed out

| File                     | Screen                      |
| ------------------------ | --------------------------- |
| `01-marketing.png`       | Marketing home              |
| `02-login.png`           | Sign in                     |
| `03-register.png`        | Create an account           |
| `37-forgot-password.png` | Request a reset code        |
| `38-reset-password.png`  | Choose a new password       |
| `39-verify-email.png`    | Enter the verification code |
| `40-offline.png`         | Offline fallback            |

## Social, learning, writing

| File                   | Screen                                         |
| ---------------------- | ---------------------------------------------- |
| `04-feed.png`          | Home feed (`/feed`) with composer and timeline |
| `05-profile.png`       | Public profile `/u/ada`                        |
| `06-notifications.png` | Notification inbox                             |
| `07-quiz-library.png`  | Quiz library                                   |
| `25-quiz.png`          | One quiz set                                   |
| `26-quiz-new.png`      | Build a quiz set                               |
| `08-forum.png`         | Forum index                                    |
| `23-forum-thread.png`  | A thread with its accepted answer              |
| `24-forum-new.png`     | Start a thread                                 |
| `09-messages.png`      | Conversation list                              |
| `27-conversation.png`  | One conversation                               |
| `28-message-new.png`   | Start a conversation                           |
| `10-blog.png`          | Article list                                   |
| `11-article.png`       | A published article                            |
| `29-blog-new.png`      | Write an article                               |
| `22-post.png`          | A single post                                  |

## Tools

| File                 | Screen         |
| -------------------- | -------------- |
| `12-tools.png`       | Tool index     |
| `13-tool-budget.png` | Budget         |
| `14-tool-age.png`    | Age calculator |
| `15-notes.png`       | Notes          |
| `32-calculator.png`  | Calculator     |
| `33-pdf-editor.png`  | PDF editor     |
| `34-period.png`      | Period tracker |
| `35-qr-code.png`     | QR code        |
| `36-note.png`        | Notes (single) |

## Market

| File                    | Screen                    |
| ----------------------- | ------------------------- |
| `16-market.png`         | Listings                  |
| `17-market-listing.png` | One listing               |
| `18-market-new.png`     | Put something on sale     |
| `19-market-cart.png`    | Cart                      |
| `20-orders.png`         | Orders, as a seller       |
| `30-order.png`          | One order and its history |
| `31-listing-edit.png`   | Edit a listing            |

## Account

| File              | Screen           |
| ----------------- | ---------------- |
| `21-settings.png` | Profile settings |

## Phone width (390 × 844)

| File                   | Screen     |
| ---------------------- | ---------- |
| `41-mobile-feed.png`   | Home feed  |
| `42-mobile-market.png` | Market     |
| `43-mobile-tools.png`  | Tool index |

Phone captures are viewport height on purpose: the bottom navigation is
`position: fixed`, and a full-page capture would paint it across the middle of
the image.

## Refreshing them

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

`docs/screenshots/tour-report.txt` is the tour's own log: it says which screen
failed and why, and it is committed because runner logs are not always readable
from every network. `demo-ids.json` holds the row ids the seed produced, so the
tour can photograph a real thread, quiz, conversation and order.

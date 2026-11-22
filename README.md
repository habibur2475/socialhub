# SocialHub

Enterprise-grade social platform: social feed, messaging, quizzes, forum, blog, tools,
a marketplace with real stock holds and an order state machine, freelance/job marketplace,
digital assets, advertising, and a double-entry finance core —
built as a **strict-TypeScript monorepo** that is a modular monolith today and
microservice-ready tomorrow.

This repository currently contains the **foundation, the authentication system, and
the web shell it runs in**. Everything else is built on top of it; see
[Roadmap](#roadmap).

---

## What is implemented and verified

| Area                                                                                            | Status | Verification                               |
| ----------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| Domain kernel (money, permissions, policy, feed, notifications, messaging, blog, tools, market) | Done   | 291 unit tests                             |
| Notifications policy (blocks, self-actions, mentions, badge cap)                                | Done   | 15 of the 291 kernel tests                 |
| Quiz grading rules (pure, deterministic, unanswered counted)                                    | Done   | 16 of the 291 kernel tests                 |
| Article policy (status machine, due-ness, slug, excerpt, reading time)                          | Done   | 37 of the 291 kernel tests                 |
| Tools arithmetic (PDF plan, QR payloads, calendar, ledger, cycles)                              | Done   | 49 of the 291 kernel tests                 |
| Market rules (stock holds, cart pricing, order state machine, refunds)                          | Done   | 32 of the 291 kernel tests                 |
| Identity / RBAC / scope / audit schema                                                          | Done   | 58 invariant tests against real PostgreSQL |
| Authentication (register, verify, login, refresh, logout, reset)                                | Done   | 26 end-to-end tests over HTTP              |
| Domain auth logic (password policy, OTP, tokens, redaction)                                     | Done   | 19 unit tests                              |
| Shared API contracts (one schema for server and browser)                                        | Done   | 51 contract tests                          |
| Design tokens and WCAG-verified themes                                                          | Done   | 30 contrast and token tests                |
| Web app: app shell, auth UI, PWA, dark mode                                                     | Done   | 102 component and client tests             |
| Profile and social graph                                                                        | Done   | 21 unit + 24 end-to-end tests              |
| Feed (posts, timelines, likes, visibility)                                                      | Done   | 18 unit + 21 end-to-end tests              |
| Notifications with live SSE delivery                                                            | Done   | 16 unit + 15 end-to-end tests              |
| Quiz (authoring, attempts, timed, grading, key disclosure)                                      | Done   | 16 unit + 14 end-to-end tests              |
| Forum (categories, threads, answers, accept, locks, blocks)                                     | Done   | 15 unit + 12 end-to-end tests              |
| Messaging (direct, groups, read cursors, blocks, live delivery)                                 | Done   | 16 unit + 23 end-to-end tests              |
| Blog (drafts, scheduling, publishing, archiving, tags, blocks)                                  | Done   | 20 unit + 18 end-to-end tests              |
| Tools (PDF pages, QR, calculator, age, budget, period, notes)                                   | Done   | 13 unit + 11 end-to-end tests              |
| Market (listings, stock holds, carts, orders, shipping, refunds)                                | Done   | 24 unit + 21 end-to-end tests              |
| Health probes (`/health/live`, `/health/ready`)                                                 | Done   | e2e                                        |
| Migration runner with checksum guard                                                            | Done   | e2e + manual                               |
| CI (format, typecheck, DB, build, budget, test)                                                 | Done   | `.github/workflows/ci.yml`                 |

**925 automated tests**, all green — locally and in CI, against real infrastructure.
Every route ships **100–140 kB** of compressed JavaScript, enforced by
`pnpm check:budget`.

---

## Quick start

```bash
# 1. Node 22+ and pnpm 9+
corepack enable

# 2. Install
pnpm install

# 3. Start local infrastructure (Postgres, Redis, OpenSearch, Redpanda, MinIO, Mailpit)
docker compose -f docker/compose.yaml up -d

# 4. Environment
cp .env.example .env
# generate real secrets: openssl rand -base64 48
# set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET

# 5. Create the database, role and schema
pnpm db:setup

# 6. Run
pnpm dev
```

The API listens on `http://localhost:4000` and the web app on `http://localhost:3000`.

### Without Docker

The API can run with an in-process cache and no Redis:

```bash
CACHE_DRIVER=memory pnpm --filter @socialhub/api dev
```

To run the API and the web app together:

```bash
pnpm dev          # api on :4000, web on :3000, with prefixed logs
```

The web app proxies `/api/*` to the API, so requests stay same-origin — which is
what the `__Host-` cookies and `SameSite=Strict` require.

This is a development convenience only; the cache provider refuses
`CACHE_DRIVER=memory` when `NODE_ENV=production`, because per-process caches make
rate limits and permission invalidation wrong across replicas.

---

## Repository layout

```
apps/
  api/                  NestJS HTTP API (modular monolith)
  web/                  Next.js app — app shell, auth UI, PWA shell, dark mode
libs/shared/
  kernel/               Pure domain core — no framework, no I/O
  db/                   Migrations + exact migration runner
  contracts/            Request schemas and response types shared by API and web
  config/               Design tokens, themes and the WCAG contrast checker
services/
  finance-go/           Go (Gin) finance service — ledger, wallet, revenue split
  intelligence-py/      FastAPI recommendation and AI service
docker/compose.yaml     Lightweight-mode development stack
docs/                   Architecture decisions and runbooks
tools/                  Repo tooling (dev runner, bundle budget check)
```

The dependency rule is one-directional: `apps → libs`, never `libs → apps`, and
`kernel` depends on nothing.

---

## Architecture at a glance

Detailed documents live in [`docs/`](docs):

- [`docs/architecture.md`](docs/architecture.md) — system design, service boundaries, scaling model
- [`docs/security-model.md`](docs/security-model.md) — identity, permissions, sessions, audit
- [`docs/data-model.md`](docs/data-model.md) — schema, sharding, indexes, growth path
- [`docs/auth-flows.md`](docs/auth-flows.md) — every authentication flow, step by step
- [`docs/design-system.md`](docs/design-system.md) — tokens, themes, accessibility, JS budget
- [`docs/live-demo.md`](docs/live-demo.md) — demo accounts and a guided tour of the running app

### The access model in one paragraph

There are exactly **three account classes** — `USER`, `STAFF`, `ROOT` — and the
list is closed. Inside them, roles are unlimited and dynamic. Authorisation is
evaluated in four layers: **L1** account class (hard boundary, enforced by a
database `CHECK`), **L2** permissions (a cached integer bitmask, never a database
query on the hot path), **L3** scope (a fixed five-level org tree with
materialised paths, so ancestry is a string prefix comparison), and **L4** policy
(runtime ABAC rules such as ownership). Every decision is auditable, and the
audit table is append-only and hash-chained.

### Money in one paragraph

All money is an integer count of minor units inside a currency. There is no
floating point anywhere in the money path. Revenue splits use the
largest-remainder method, which makes the invariant `gross = commission + Σ(shares)`
hold exactly, to the last paisa — verified by tests that sweep every amount from
0 to 500 across four weight vectors.

---

## Verified security properties

Each of these is enforced by code **and** by a test, so a regression fails CI:

- `ROOT` accounts cannot be deleted, demoted, or exceeded beyond two — enforced by
  database triggers, not application code.
- `STAFF` and `ROOT` cannot exist without an HR profile; `USER` cannot have one —
  deferred constraint trigger, so the invariant holds at transaction commit.
- Registration cannot create a `STAFF`/`ROOT` account: account type is a constant
  in the use case, and unknown request fields are rejected outright.
- Reusing a spent refresh token revokes the entire token family (stolen-token
  detection), and the race between two concurrent refreshes is treated identically.
- Changing a password rotates the session epoch, which invalidates every
  outstanding access **and** refresh token atomically.
- Login returns the same error and takes the same time for "wrong password" and
  "no such account", so response content and latency both refuse to act as an
  account-existence oracle.
- Registration and password-reset always report success, even for an address that
  is already registered or unknown.
- Credential endpoints are throttled on two independent budgets (identity and
  source) using an exact sliding window in Redis.
- Audit rows cannot be updated or deleted (`BEFORE UPDATE OR DELETE` trigger) and
  are hash-chained, so tampering breaks verification.
- Logs redact by key at any depth: passwords, tokens, cookies, OTPs and
  authorisation headers never reach a log line.

---

## Coding standards

- **TypeScript strict**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
  and `noImplicitOverride`. `any` is not used anywhere in application code.
- **No implicit DI metadata.** Every injected dependency is annotated with
  `@Inject(TOKEN)`. Decorator metadata is a build-tool behaviour: `tsc` emits it,
  esbuild (and therefore most test runners) does not. Relying on it produces code
  that is validated in production and silently unvalidated in tests — which is
  exactly the failure this codebase hit and then removed.
- **Validation is explicit.** Routes declare a zod schema per body; unknown keys
  are rejected. See `docs/architecture.md` for why class-validator was removed.
- **Errors are typed.** A domain error is an `AppError` with a stable code from a
  closed set; one table maps codes to HTTP statuses. Unknown throwables become a
  generic 500 carrying only a correlation id.
- **SQL lives in repositories**, never in services or controllers.
- **Business logic is pure** where possible: the kernel has no imports from
  NestJS, Postgres or Node's network stack.

---

## Testing

```bash
pnpm -r typecheck    # strict, all packages
pnpm -r test         # unit + integration (DB tests skip if TEST_DATABASE_URL is unset)
TEST_DATABASE_URL=postgres://postgres@localhost:5433/socialhub pnpm -r test
pnpm -r build
```

The database suites are genuine integration tests: they assert that Postgres
itself refuses to violate the security invariants, rather than trusting the
application layer to be careful.

---

## Roadmap

Phase 1 (this repository): foundation, domain kernel, identity schema, authentication.
Phase 2: web app shell and PWA, profile and social graph, feed.
Phase 3: notifications and real-time delivery, quiz, forum.
Phase 4: blog, tools, market — **all shipped**. Messaging runs over Phase 3's SSE hub with
read cursors, blocks and idempotent sends; blog adds drafts, scheduling and tags; tools are
seven small utilities; the market adds listings with real stock holds, seller-split carts,
and an order state machine the database also enforces.
Phase 5: freelance/job marketplace, digital assets, and advertising.
Phase 6: Go finance service, Python recommendation service, event bus.
Phase 7: search, analytics, Kubernetes autoscaling, multi-shard rollout.

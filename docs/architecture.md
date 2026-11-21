# Architecture

## 1. Shape of the system

```
                      ┌───────────────────────────┐
   Browser / PWA ────▶│  NGINX + HAProxy (TLS)    │
                      └────────────┬──────────────┘
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
        ┌────────▼────────┐                 ┌────────▼────────┐
        │  Next.js (web)  │                 │  NestJS (api)   │
        │  SSR/SSG/CSR    │                 │  modular        │
        │  PWA shell      │                 │  monolith       │
        └────────┬────────┘                 └───┬────┬────┬───┘
                 │                              │    │    │
                 │              ┌───────────────┘    │    └────────────────┐
                 │              │                    │                     │
        ┌────────▼────────┐  ┌──▼────────┐   ┌───────▼───────┐   ┌─────────▼────────┐
        │ Cloudflare CDN  │  │  Redis    │   │  PostgreSQL   │   │  Go finance svc  │
        │ (static, media) │  │ cache,    │   │  sharded +    │   │  ledger, wallet  │
        └─────────────────┘  │ sessions, │   │  PgBouncer    │   │  double entry    │
                             │ limits    │   └───────────────┘   └──────────────────┘
                             └───────────┘            │
                                                      │
                                    ┌─────────────────┴────────────────┐
                                    │                                  │
                          ┌─────────▼─────────┐              ┌─────────▼─────────┐
                          │ OpenSearch / ES   │              │  Redpanda / Kafka │
                          │ search index      │              │  event bus        │
                          └───────────────────┘              └───────────────────┘
```

Phase 1 runs a single API instance and a single Postgres node. Nothing in the code
assumes that: every shard, cache and broker access goes through a port, so scaling
out is configuration rather than a refactor.

## 2. Why a modular monolith first

A microservice split at the start trades real, immediate problems (transactions,
deployment complexity, distributed tracing gaps) for hypothetical ones. A
modular monolith gets the boundaries right first:

- Each feature is a Nest module with an explicit `exports` list.
- Cross-module access is only through that exported surface — never a deep import.
- Business rules live in `libs/shared/kernel`, which has no framework dependency
  and therefore can be lifted into any future service unchanged.

When a module needs to become a service, the work is: move the directory, replace
the in-process call with an RPC client. The interface already exists.

## 3. Why each technology is where it is

| Concern       | Technology                 | Why this one, here                                                                                                                               |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Front end     | Next.js                    | Route-level code splitting, hybrid rendering, first-class PWA path.                                                                              |
| Main API      | NestJS + strict TS         | Module system maps 1:1 onto the service boundaries above; DI makes the ports explicit.                                                           |
| Money         | Go (Gin)                   | Integer arithmetic, explicit error returns, and a runtime with predictable pauses — a ledger should not share a GC profile with request parsing. |
| Recs / AI     | Python (FastAPI)           | The ecosystem of the algorithms; isolated so a heavy model cannot slow request paths.                                                            |
| Primary store | PostgreSQL, sharded        | Transactions, constraints and a query planner that can be held responsible for correctness.                                                      |
| Cache         | Redis                      | Sub-millisecond reads for permission masks and rate-limit windows.                                                                               |
| Search        | OpenSearch (ES-compatible) | Inverted index for content discovery; kept out of the write path.                                                                                |
| Events        | Redpanda (Kafka API)       | Durable, replayable log so a consumer restart cannot lose an event.                                                                              |
| Objects       | MinIO → S3 + Cloudflare    | Same S3 API locally and in production; CDN in front of media.                                                                                    |

## 4. Sharding model

Routing is a pure function, so any service can locate a user without a lookup:

```
UserId → SHA-256 → 4096 virtual buckets → bucket table → shard
```

- **Virtual buckets** are the indirection that makes growth cheap: adding a shard
  moves buckets in a metadata table only. No key is ever re-hashed.
- **SHA-256**, not a rolling hash: user ids are attacker-influenced during
  sign-up, and a weak hash lets an attacker herd accounts onto one shard.
- **One shard per request path.** No cross-user joins and no cross-shard
  transactions; consistency across shards is event-driven.
- Splitting triggers on storage ≥ 70%, sustained CPU ≥ 60%, connection
  saturation, or write-latency breach. Resharding is dual-write → backfill →
  cutover → decommission, all online.

`libs/shared/kernel/src/sharding.ts` implements the hash, the map, the even
distribution, and the failure modes (`UNMAPPED_BUCKET` is an error, never a guess).

## 5. Request lifecycle

```
TLS → NGINX/HAProxy → Nest
  → correlation id (inbound x-request-id honoured, else minted)
  → throttler (coarse, per source)
  → route guard (JWT verify → session check → epoch check → state check)
  → zod body validation (strict, unknown keys rejected)
  → controller → application service → repository
  → response / typed domain error
  → exception filter (code → status, redacted log line)
```

Every hop is observable: one correlation id threads the log lines, and the error
envelope always carries it back to the client.

## 6. Two design decisions worth recording

### 6.1 Explicit dependency injection

Every injected parameter is annotated with `@Inject(TOKEN)`. Nest's default is to
read `design:paramtypes` metadata emitted by `tsc`. esbuild — and therefore
`tsx`, `vitest` and most modern test runners — does not emit that metadata.

The consequence is not a compile error, it is worse: **classes built under the
test runner receive `undefined` dependencies and validation silently does not
run.** This codebase hit that exact failure. Explicit tokens make the wiring
independent of which tool transpiled the code, and the compiler still checks the
types at the injection site.

### 6.2 Explicit validation instead of decorator DTOs

For the same reason, `class-validator` DTOs are not used at HTTP boundaries.
Instead each route declares a zod schema:

```ts
@Post('login')
login(@Body(new ZodBody(loginSchema)) body: LoginDto) { … }
```

- `.strict()` rejects unknown keys, which closes parameter smuggling
  (`{"accountType":"ROOT"}` is a 422, verified by a test).
- `z.infer` derives the handler's parameter type from the schema, so the two
  cannot drift.
- What runs in a test is byte-for-byte what runs in production.

## 7. Performance budget

| Target                        | Approach                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| Authorisation on the hot path | One cached bitmask read from Redis; zero database queries.                          |
| Session validation            | Signature check (local) + one cache-backed lookup, so revocation is immediate.      |
| Login latency uniformity      | Constant-shape hashing work, so timing does not leak account existence.             |
| Query safety                  | `statement_timeout` and `query_timeout` at 10s; connection acquisition fails in 5s. |
| Connection budget             | One pool per endpoint, sized by `DATABASE_POOL_MAX`; PgBouncer in production.       |
| Log cost                      | Single-line JSON, redacted by key, level-filtered before formatting.                |

## 8. Failure policy, stated explicitly

Ambiguity here is where outages come from, so each dependency has a written policy:

| Dependency           | On failure                               | Rationale                                                                              |
| -------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Redis (throttle)     | **Fail open**, log loudly                | Locking every user out of login is worse than degrading to the gateway's per-IP limit. |
| Redis (permissions)  | **Fall back to database**                | Authorisation must never fail open. Latency degrades; correctness does not.            |
| Audit write          | Never fails the request, logs at `fatal` | The user's action is legitimate; the gap is an operator incident.                      |
| Postgres (readiness) | 503 from `/health/ready`                 | Stop routing traffic to an instance that cannot serve it.                              |
| Postgres (liveness)  | Unaffected                               | A dependency failure must not cause a pod restart loop.                                |

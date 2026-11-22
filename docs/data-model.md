# Data model

Migration: `libs/shared/db/src/migrations/0001_identity.sql`.
Invariants below are enforced by the database and asserted by
`libs/shared/db/src/schema.spec.ts` against a real PostgreSQL server.

## 1. Tables

| Table                                        | Purpose                         | Key invariants                                                              |
| -------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `accounts`                                   | one row per human identity      | `account_type` ∈ {USER, STAFF, ROOT}; email unique among **live** rows only |
| `user_profiles`                              | external profile                | username `^[a-z0-9_]{3,30}$`, unique                                        |
| `staff_profiles`                             | internal HR record              | `employee_no` unique; only for STAFF/ROOT                                   |
| `scopes`                                     | org tree                        | canonical path, unique; five fixed levels                                   |
| `roles` / `permissions` / `role_permissions` | RBAC catalogue                  | mask stored as exact `numeric`                                              |
| `user_roles`                                 | scoped grants                   | unique per (account, role, scope); expiry in the future                     |
| `sessions`                                   | live login sessions             | expiry after creation                                                       |
| `refresh_tokens`                             | rotating refresh families       | 32-byte digest, unique                                                      |
| `verification_codes`                         | OTPs                            | 32-byte digest, attempts bounded by `max_attempts`                          |
| `audit_events`                               | append-only, hash-chained trail | 32-byte hash, immutable, multi-segment action names                         |

## 2. Decisions that matter

**`text` + `CHECK` instead of `ENUM`.** Adding a value to a Postgres `ENUM`
requires an exclusive rewrite of every table that uses it. A `CHECK` on a domain
is an online-validatable constraint with the same single-source-of-truth
semantics.

**Unique index scoped to live rows.** `accounts_email_live_key` is
`UNIQUE (email) WHERE deleted_at IS NULL`. A soft-deleted account releases its
address, so a returning user can register again without support intervention —
while an active or suspended account still holds it.

**Two unique indexes, two different questions.** `accounts_email_live_key`
enforces business uniqueness; the `citext` column plus
`accounts_email_is_normalised` guarantees the stored value is lowercased, so a
direct SQL client cannot create `Foo@x` and `foo@x` as different identities.

**UUIDv7 identifiers.** Time-ordered, so B-tree inserts are append-mostly instead
of scattering across the index, and every row carries a free creation time.

**Session epoch instead of a token denylist.** Bumping an integer on the account
row invalidates every outstanding token atomically and in constant time, with no
table that grows with the number of logins.

**Audit has no foreign keys.** An audit row records a fact about the past; it must
survive deletion of the subject. A foreign key with `ON DELETE SET NULL` would
perform an `UPDATE`, which the immutability trigger correctly rejects — so the
constraint and the immutability guarantee are mutually exclusive, and
immutability wins.

## 3. Indexes and why

| Index                                         | Query it serves                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `accounts_email_live_key`                     | login lookup, duplicate detection                                             |
| `accounts_type_state_idx`                     | owner-panel listings filtered by class and state                              |
| `scopes_path_prefix_idx` (`text_pattern_ops`) | subtree queries (`path LIKE '/a/b/%'`) — prefix-safe because paths end in `/` |
| `sessions_account_live_idx` (partial)         | "my devices", revocation by account                                           |
| `refresh_tokens_digest_key`                   | the only refresh lookup                                                       |
| `refresh_tokens_family_idx`                   | family revocation on reuse detection                                          |
| `verification_codes_lookup_idx`               | newest code for (account, purpose)                                            |
| `audit_events_actor_idx`, `..._resource_idx`  | investigation by actor or object                                              |

The partial index on `sessions` matters most: revoked rows are excluded, so "list
my active sessions" stays proportional to active sessions, not to history.

## 4. Trigger reference

| Trigger                            | Fires                                | Guarantee                                                                  |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `accounts_protect_root`            | BEFORE UPDATE/DELETE on `accounts`   | ROOT cannot be deleted or demoted; credential change bumps `session_epoch` |
| `accounts_root_cap`                | BEFORE INSERT/UPDATE OF account_type | at most 2 live ROOT accounts                                               |
| `accounts_staff_profile_invariant` | AFTER INSERT/UPDATE, DEFERRED        | STAFF/ROOT ⇔ `staff_profiles` holds at commit                              |
| `audit_events_immutable`           | BEFORE UPDATE/DELETE                 | the trail cannot be rewritten                                              |
| `set_updated_at`                   | BEFORE UPDATE                        | `updated_at` is never set by application code                              |

The deferred constraint trigger is the interesting one: it lets the application
insert the account and its profile in either order inside one transaction, but
makes a half-provisioned internal identity impossible to commit.

## 5. The market tables (`0009_market.sql`)

| Table                 | Purpose                  | Key invariants                                                                     |
| --------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `market_listings`     | what one seller offers   | `reserved_stock <= stock`; an `ACTIVE` listing has stock; price in 100…100 000 000 |
| `market_orders`       | one seller, one shipment | buyer ≠ seller; `total = subtotal + shipping`; `expires_at` only while unpaid      |
| `market_order_items`  | the receipt line         | title and price are **snapshots**; one row per (order, listing)                    |
| `market_order_events` | the timeline             | append-only; `(from_status, to_status, actor)` per move                            |

Three decisions worth defending:

**The hold is a column, not a table.** `reserved_stock` is incremented by a single
conditional `UPDATE … WHERE stock - reserved_stock >= $n`. A `SELECT` followed by an
`UPDATE` leaves a window where two buyers both see the last unit; one statement cannot.

**The state machine runs twice.** `can_move_order(from, to)` is a SQL function used by
the `market_orders_transition` trigger, and the same table is asserted against the
kernel's `decideOrderMove` in `schema.spec.ts`. If the two ever disagree the test fails,
so a direct `UPDATE` cannot move an order somewhere the application never would.

**`NO ACTION … DEFERRABLE`, not `RESTRICT`.** A seller leaving deletes their account, their
listings and their orders in one statement. `RESTRICT` is checked the moment the listing
row goes, so the cascade order would decide whether that statement is legal. Deferring to
commit keeps the rule — a receipt line must not outlive its listing — while letting one
statement remove both.

## 6. Growth path

Current: one Postgres node. The schema is already shard-ready:

- Every user-owned table keys on `account_id`, which is the shard key.
- No cross-user foreign keys exist except through the account, so no query needs
  a cross-shard join.
- `scopes`, `roles`, `permissions` and `accounts` for STAFF/ROOT are central-DB
  tables by design — they are small and must be globally consistent.

To shard: populate the bucket table from `evenBucketDistribution`, point the shard
router at the new DSNs, and roll out reads before writes. Nothing in the schema
changes.

## 7. Migration policy

`libs/shared/db/src/migrator.ts`:

- files run in lexical order, each in its own transaction unless the file declares
  `-- migrate:no-transaction` (for `CREATE INDEX CONCURRENTLY`);
- a recorded migration whose checksum changed is a **hard error**, because edited
  history is a lie about what production is running;
- a PostgreSQL advisory lock serialises runners, so two deploys cannot race.

This guard caught an edit during development — the correct response was to reset
the development database, not to update the checksum.

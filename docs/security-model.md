# Security model

## 1. Four layers, one decision point

```
L1  Account class     USER | STAFF | ROOT          hard boundary, database-enforced
L2  Permissions       dynamic roles → bitmask     cached in Redis, never queried at runtime
L3  Scope             COMPANY → REGION → BRANCH → DEPARTMENT → POSITION
L4  Policy (ABAC)     ownership, tenancy, risk    evaluated last, short-circuits
```

`libs/shared/kernel/src/policy.ts` evaluates a list of typed `Requirement`s and
returns a typed `Decision` — including _which_ requirement failed, so a 403 can be
explained without leaking anything the caller is not entitled to know.

Evaluation order is deliberate: account state first (a locked account has no
authority at all), then permission (cheap), then scope, then policy.

## 2. Account classes

|               | USER                       | STAFF                       | ROOT                        |
| ------------- | -------------------------- | --------------------------- | --------------------------- |
| Surface       | external only              | internal operations         | system control              |
| Profile       | `user_profiles` (required) | `staff_profiles` (required) | `staff_profiles` (required) |
| Roles         | dynamic                    | dynamic                     | all pre-assigned            |
| Audit         | standard                   | standard                    | maximum                     |
| Deletable     | soft delete                | soft deactivate             | **never**                   |
| Maximum count | unlimited                  | unlimited                   | **2**                       |

Enforcement, and where it lives:

- `accounts.account_type` is a domain with a `CHECK` — an unknown class cannot be
  inserted even by a direct SQL client.
- `accounts_protect_root` trigger: `ROOT` cannot be deleted or demoted.
- `accounts_root_cap` trigger: a third live `ROOT` is rejected.
- `accounts_staff_profile_invariant` deferred constraint trigger: `STAFF`/`ROOT`
  without a profile, or `USER` with one, aborts the transaction at commit.
- `canManageAccount()` in the kernel: nobody acts on a `ROOT`; `STAFF` may act on
  `USER` only, never on another `STAFF`. So a compromised staff session cannot
  escalate into admin-on-admin tampering.

## 3. Permissions

Permissions are a closed registry of `resource:action` strings in
`libs/shared/kernel/src/permissions.ts`. The registry index **is** the bit
position, so the mapping is compile-time constant and identical in every service.

`PermissionMask` is an arbitrary-precision integer:

- JavaScript's bitwise operators truncate to 32 bits, so a single `number` cannot
  hold this safely — the registry is already wider than one machine word.
- Persisted as a canonical decimal string in Redis and `numeric` in Postgres; no
  `bit(64)` truncation, no float.
- Serialisation round-trips are tested, including rejection of malformed and
  out-of-range values.

Aggregation: a role contributes the union of its grants, and expired grants are
excluded **at query time**, so a lapsed delegation stops working at the stated
instant even if a background sweeper is down.

Caching: `PermissionCache` is cache-aside with a 5-minute TTL plus explicit
invalidation on role change. A cache outage falls back to the database —
authorisation never fails open.

## 4. Sessions and tokens

| Token   | Form                  | Storage              | Lifetime          | Revocation                    |
| ------- | --------------------- | -------------------- | ----------------- | ----------------------------- |
| Access  | JWT HS256, 15 min     | client memory        | short             | session epoch + session check |
| Refresh | opaque 256-bit random | SHA-256 digest in DB | 30 days, rotating | family revocation             |

- The access token deliberately carries **no permissions**: a mask inside a
  self-contained token cannot be revoked before it expires.
- Refresh tokens are rotated on every use and grouped into **families**. A
  consumed token presented again can only mean the token leaked, so the whole
  family and its session are revoked.
- `consumeRefreshToken` is a conditional `UPDATE ... WHERE consumed_at IS NULL`,
  so exactly one of two concurrent refresh requests wins; the loser is treated as
  reuse rather than being allowed to mint a second valid token.
- `session_epoch` is bumped by a trigger whenever the password or MFA material
  changes, invalidating every outstanding token for the account atomically.
- Cookies use the `__Host-` prefix (requires `Secure`, `Path=/`, no `Domain`),
  `HttpOnly`, `SameSite=Strict`. Both requirements are unconditional — including
  in development — because a `__Host-` cookie that breaks either rule is not
  weakened, it is **discarded**: the browser stores nothing, the in-memory access
  token hides the problem until the first reload, and the symptom is "signing in
  does not stick". `http://localhost` is a secure context, so keeping `Secure` on
  costs local development nothing.
- Framing defaults to `X-Frame-Options: DENY`. A hosting preview that renders the
  app inside an iframe must opt in with `PREVIEW_FRAME_ANCESTORS`, which swaps in
  `Content-Security-Policy: frame-ancestors 'self' <origins>` citing exact origins. CSRF uses double-submit: a readable nonce cookie
  echoed in a header, which a cross-site request cannot produce.

## 5. Credentials

- **Argon2id only** — memory-hard, side-channel resistant. 47 MiB / t=3 / p=1,
  above the OWASP minimum of 19 MiB, and stated explicitly so a dependency bump
  cannot silently weaken it.
- Transparent rehash on successful login when stored parameters fall below policy.
- The password policy mandates **length** (10, or 12 for administrative accounts)
  and rejects blocklisted passwords, degenerate patterns (`aaaa`, `abab`,
  `abcdef`), single-character-class passwords, and passwords containing the
  user's own email/username/display name. Character-class mandates are
  deliberately absent: they push users toward `Password1!` without adding entropy.
- Password length is capped at 128 so that hashing cannot be used as a cheap
  memory-exhaustion attack.

## 6. OTP and account enumeration

- Codes are 6 digits from a CSPRNG, stored only as a digest that is
  **domain-separated** by account id _and_ purpose — a reset code cannot validate
  as a verification code for another account.
- Attempt counters live in the row, so they survive a restart and cannot be
  bypassed by hitting a different replica.
- Verification is constant-time, and shape-checked first.
- Registration always returns "check your inbox", even for an existing address;
  the real owner is notified out of band instead.
- Login performs a dummy hash when the account is absent, so response **latency**
  does not reveal existence either.

## 7. Audit

`audit_events` is append-only at two levels: a `BEFORE UPDATE OR DELETE` trigger,
and a revoked `UPDATE`/`DELETE` grant for the application role.

Rows are **hash-chained** (`entry_hash = SHA-256(previous_hash ‖ canonical payload)`),
so deleting or editing a row breaks verification. The chain head is cached in
Redis and falls back to the newest table row, so a cache eviction or restart
cannot fork the chain. Canonical serialisation sorts keys, so two identical events
always hash identically.

The table has **no foreign keys on purpose**: an audit row records what was true
at the time and must outlive the rows it references. A cascading `ON DELETE SET
NULL` would perform an `UPDATE`, which the immutability trigger correctly rejects.

## 8. Logging and redaction

One JSON object per line, because the production sink is Loki/Elastic and a parser
is more reliable than a regex.

Redaction is **by key, at any depth**: `password`, `secret`, `token`, `cookie`,
`authorization`, `otp`, `code`, `mfa`, `credential`, `api_key`, `private_key`.
Substring matching is intentional (`refreshToken`, `otpCode` must both match);
false positives are resolved by an explicit allowlist rather than by weakening the
pattern. Client IPs are stored as keyed HMACs, never in plaintext.

## 9. What a compromise buys an attacker

| Compromise                          | Consequence                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Read-only database access           | Password hashes (Argon2id), token digests, OTP digests, hashed IPs. No usable credential.    |
| Redis access                        | Cached permission masks and rate-limit windows. No credentials, no tokens.                   |
| One stolen access token             | 15 minutes of that user's access, revoked immediately by logout or credential change.        |
| One stolen refresh token, used once | The legitimate client's next refresh revokes the family; the attacker's next attempt fails.  |
| A STAFF session                     | USER-scope operations only. Cannot touch other STAFF, cannot touch ROOT, cannot create ROOT. |

# Authentication flows

Each flow lists the exact request sequence, the state transitions, and the failure
branches. All of it is covered by the end-to-end suite in
`apps/api/src/modules/auth/auth.e2e.spec.ts`.

## Endpoints

| Method | Path                           | Auth   | Purpose                                                   |
| ------ | ------------------------------ | ------ | --------------------------------------------------------- |
| POST   | `/api/v1/auth/register`        | —      | create a USER account, issue verification code            |
| POST   | `/api/v1/auth/verify-email`    | —      | consume the code, activate the account                    |
| POST   | `/api/v1/auth/login`           | —      | password login, issue token pair                          |
| POST   | `/api/v1/auth/refresh`         | cookie | rotate refresh token, issue new access token              |
| POST   | `/api/v1/auth/logout`          | bearer | revoke the current session (or all `{scope:"all"}`)       |
| GET    | `/api/v1/auth/me`              | bearer | current principal and permission list                     |
| POST   | `/api/v1/auth/password/forgot` | —      | issue a reset code (always reports success)               |
| POST   | `/api/v1/auth/password/reset`  | —      | consume the code, set a new password, revoke all sessions |
| GET    | `/health/live`                 | —      | liveness (never touches dependencies)                     |
| GET    | `/health/ready`                | —      | readiness (Postgres + cache, 1s budget)                   |

## 1. Registration

```
POST /register { email, password, username, displayName }
  ↓ strict schema (unknown keys → 422)
  ↓ password policy (length, blocklist, patterns, identity) → 422 with the full
    violation list, so a form can show every problem at once
  ↓ Argon2id hash
  ↓ TRANSACTION: insert accounts (USER, PENDING_VERIFICATION) + user_profiles
  ↓ issue 6-digit code (digest stored), send email
  ↓ audit: auth.register.success, auth.otp.issued
202 { verificationRequired: true }
```

Duplicate email takes the _same_ path and returns the _same_ response; the real
owner receives a "someone tried to register" notice instead. The unique index is
the arbiter, so no application-level check can race.

## 2. Email verification

```
POST /verify-email { email, code }
  ↓ load account (404-equivalent if absent — actually the same 422 as a bad code)
  ↓ load newest unconsumed EMAIL_VERIFY row
  ↓ check: consumed? expired? attempts exhausted? code matches (constant time)?
  ↓ on mismatch: attempts += 1, 422
  ↓ on match: consume row, set email_verified_at, PENDING_VERIFICATION → ACTIVE
200 { activated: true }
```

## 3. Login

```
POST /login { email, password }
  ↓ identity throttle (sliding window, Redis) → 429 if exhausted
  ↓ load account
      absent → dummy Argon2id verify (equalise timing) → 401 INVALID_CREDENTIALS
  ↓ locked_until in the future → 423 ACCOUNT_LOCKED
  ↓ verify password
      mismatch → failed_login_count += 1 (single SQL statement), 401
                 at threshold, locked_until = now + LOCKOUT_SECONDS
  ↓ state gate → 403 EMAIL_NOT_VERIFIED / 423 SUSPENDED / 423 LOCKED
  ↓ rehash if parameters are below policy (the user just proved possession)
  ↓ reset failure counter, set last_login_at
  ↓ create session + refresh family + access token
200 { accessToken, accessTokenExpiresAt, refreshTokenExpiresAt, user }
    Set-Cookie: __Host-sh_rt (HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth)
    Set-Cookie: __Host-sh_csrf (readable, SameSite=Strict, Path=/)
```

The intended client stores the access token **in memory only** — never
`localStorage`, where any injected script could read it.

## 4. Refresh (rotation + reuse detection)

```
POST /refresh   Cookie: __Host-sh_rt=…; __Host-sh_csrf=…
                X-CSRF-Token: …
  ↓ CSRF double-submit mismatch → 403
  ↓ digest lookup
      not found            → 401 SESSION_EXPIRED
  ↓ revoked               → 401 SESSION_REVOKED
  ↓ already consumed      → REUSE: revoke family + revoke session
                            audit auth.refresh.reuse_detected → 401 TOKEN_REUSE_DETECTED
  ↓ expired               → 401 SESSION_EXPIRED
  ↓ session gone          → 401 SESSION_REVOKED
  ↓ epoch mismatch        → revoke session → 401 SESSION_REVOKED
  ↓ account not ACTIVE    → revoke session → 423/403
  ↓ consume row (conditional UPDATE; losing the race = reuse) → 401
  ↓ insert child token in the same family (rotation)
  ↓ issue new access token
200 { accessToken, … } + new refresh cookie
```

## 5. Logout

```
POST /logout { scope?: "current" | "all" }   Authorization: Bearer …
  ↓ revoke session + all its refresh tokens (or every session for the account)
  ↓ invalidate cached permissions
204 + cleared cookies
```

## 6. Password reset

```
POST /password/forgot { email }
  ↓ if the account exists and is usable: issue PASSWORD_RESET code
  ↓ either way:
202 { message: "If an account exists for that address, a code is on its way." }

POST /password/reset { email, code, password }
  ↓ password policy → 422
  ↓ load newest unconsumed PASSWORD_RESET row
  ↓ check (same rules as email verification), on mismatch attempts += 1 → 422
  ↓ consume row
  ↓ Argon2id hash, write new password_hash
      → trigger bumps session_epoch
  ↓ revoke every session for the account
200 + cleared cookies
```

Because the epoch moved, every access token issued before the reset now fails the
guard's epoch check, and every refresh token fails the same comparison — the
attacker's sessions die with the reset.

## 7. Guard evaluation (every authenticated request)

```
Authorization: Bearer <jwt>
  ↓ signature + iss + aud + exp + typ=="access"        (local, no I/O)
  ↓ session lookup (cache-backed)                      (revocation is immediate)
  ↓ session.accountId === claims.sub
  ↓ account exists, state ACTIVE
  ↓ account.sessionEpoch === claims.epc                (credential change kills it)
  ↓ request.principal = { accountId, accountType, state, sessionId }
```

Failure returns a typed code: `UNAUTHENTICATED` (401), `SESSION_REVOKED` (401), or
`ACCOUNT_SUSPENDED` (423) — never a bare 500.

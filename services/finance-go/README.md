# Finance service (Go + Gin)

Status: **scaffolded, not yet wired.** The ledger primitives are implemented and
tested; the HTTP surface and the event consumers are the next phase.

## Why a separate service, and why Go

A ledger has different requirements from a request/response API:

- **Exact integer arithmetic, always.** No floating point, ever. Go's `int64`
  minor units paired with explicit overflow checks make that enforceable, and the
  language has no implicit numeric coercions to hide a mistake.
- **Predictable latency.** A ledger must not share a garbage-collector profile
  with request parsing and JSON rendering.
- **Explicit error handling.** In a double-entry system, every function that can
  fail should force the caller to acknowledge it.

The TypeScript kernel implements the _same_ arithmetic
(`libs/shared/kernel/src/money.ts`, `revenue.ts`) so that the API can validate a
split before it is submitted. The Go service is the authority; the TypeScript
version is a pre-flight check. Both are covered by conservation tests, so a
disagreement fails a build rather than silently unbalancing the books.

## Design

```
double-entry ledger
  accounts (chart of accounts)   asset | liability | revenue | expense | equity
  journal_entries                one posting event, immutable, dated
  journal_lines                  ≥2 per entry, Σ debit = Σ credit, per currency

derived, never authoritative:
  wallet balances                materialised from lines, reconciled nightly
  payouts                        state machine: requested → approved → paid → failed
```

Rules:

1. **Every movement is a journal entry with balanced lines.** A wallet balance is a
   cached projection, never a source of truth; if it disagrees with the ledger, the
   ledger wins and the projection is rebuilt.
2. **Entries are immutable.** A correction is a reversing entry, so the audit trail
   shows both the mistake and the fix.
3. **Currency is part of every amount.** Lines in different currencies never sum;
   a cross-currency movement is two entries with an explicit FX rate recorded.
4. **Idempotency key on every external request**, stored with the entry, so a
   retried payout cannot double-pay.

## Revenue split

`libs/shared/kernel/src/revenue.ts` is the reference implementation:

```
gross → commission (bps, ≤ 50%) → distributable
      → allocate(weights in bps) by largest remainder  → Σ shares == distributable
```

The largest-remainder method is what guarantees the platform, the creator, the
referrer and the host always sum back to the gross **exactly**. Rounding dust is
never created or destroyed, which is the property an accountant will ask about
first.

## Layout

```
cmd/server/main.go        composition root
internal/
  ledger/                 double-entry domain (entries, lines, balance checks)
  wallet/                 balance projection and reconciliation
  payout/                 payout state machine
  split/                  commission and revenue distribution
  httpapi/                Gin handlers, request validation, idempotency
```

## Next steps

1. Schema migrations for the ledger tables (same runner discipline as the API).
2. `POST /internal/v1/entries` — post a balanced entry, idempotency-keyed.
3. Kafka consumer for `post.published`, `order.paid`, `quiz.completed` → post entries.
4. Nightly reconciliation job: rebuild wallet projections from lines, alert on drift.
5. Contract tests that mirror the TypeScript conservation suite case for case.

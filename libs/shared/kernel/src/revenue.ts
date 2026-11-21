/**
 * Revenue split engine — the arithmetic behind "everybody earns".
 *
 * The platform takes a commission from gross revenue and distributes the rest
 * across contributors (creator, referrer, host, curator). Two properties are
 * non-negotiable and are enforced here rather than in the caller:
 *
 *   1. Conservation — the parts always sum to the gross, exactly, to the last
 *      minor unit. No rounding dust is ever created or destroyed.
 *   2. Determinism — the same inputs always yield the same split, so the Go
 *      finance service can replay a settlement and prove it matches.
 *
 * Weights are basis points (1/10000) so a 12.5% commission is exactly 1250.
 */

import { type Money, type MoneyError, allocate, money } from './money.js';
import { type Result, fail, ok } from './result.js';

export type SplitParty = {
  readonly partyId: string;
  readonly /** Share of the distributable remainder, in basis points. */ weightBps: number;
};

export type SplitRequest = {
  readonly gross: Money;
  readonly commissionBps: number;
  readonly parties: readonly SplitParty[];
};

export type SplitError =
  | MoneyError
  | { readonly code: 'INVALID_COMMISSION_RATE'; readonly commissionBps: number }
  | { readonly code: 'NO_PARTIES' }
  | { readonly code: 'INVALID_WEIGHTS'; readonly detail: string }
  | { readonly code: 'CONSERVATION_VIOLATION'; readonly expected: number; readonly actual: number };

export type SplitLine = {
  readonly partyId: string;
  readonly amount: Money;
};

export type SplitResult = {
  readonly gross: Money;
  readonly commission: Money;
  readonly distributable: Money;
  readonly lines: readonly SplitLine[];
};

export const TOTAL_BPS = 10_000;

/**
 * Maximum commission is 50%: a marketplace that takes more than half of a
 * creator's gross is not sustainable, and the bound keeps every downstream
 * calculation inside safe integer range.
 */
export const MAX_COMMISSION_BPS = 5_000;

export const computeSplit = (request: SplitRequest): Result<SplitResult, SplitError> => {
  const { gross, commissionBps, parties } = request;

  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > MAX_COMMISSION_BPS) {
    return fail({ code: 'INVALID_COMMISSION_RATE', commissionBps });
  }
  if (gross.minor < 0) return fail({ code: 'NEGATIVE_AMOUNT', minor: gross.minor });
  if (parties.length === 0) return fail({ code: 'NO_PARTIES' });

  const weightSum = parties.reduce((sum, party) => sum + party.weightBps, 0);
  if (weightSum !== TOTAL_BPS) {
    return fail({ code: 'INVALID_WEIGHTS', detail: `weights must total ${TOTAL_BPS}, received ${weightSum}` });
  }
  for (const party of parties) {
    if (!Number.isInteger(party.weightBps) || party.weightBps <= 0) {
      return fail({ code: 'INVALID_WEIGHTS', detail: `non-positive weight for ${party.partyId}` });
    }
  }

  const commissionMinor = Math.floor((gross.minor * commissionBps) / TOTAL_BPS);
  const distributableMinor = gross.minor - commissionMinor;

  const commission = money(commissionMinor, gross.currency);
  if (!commission.ok) return commission;
  const distributable = money(distributableMinor, gross.currency);
  if (!distributable.ok) return distributable;

  const shares = allocate(distributable.value, parties.map((party) => party.weightBps));
  if (!shares.ok) return shares;

  const lines: SplitLine[] = parties.map((party, index) => {
    const share = shares.value[index];
    if (share === undefined) throw new RangeError('allocate returned a shorter result than requested');
    return { partyId: party.partyId, amount: share };
  });

  const conservation = checkConservation(gross, commission.value, lines);
  if (!conservation.ok) return conservation;

  return ok({ gross, commission: commission.value, distributable: distributable.value, lines });
};

/**
 * Verifies gross = commission + sum(lines). Called by the finance service on
 * every settlement batch; a violation is a page-the-on-call incident, because it
 * means money was created or destroyed rather than moved.
 */
export const checkConservation = (
  gross: Money,
  commission: Money,
  lines: readonly SplitLine[],
): Result<true, SplitError> => {
  if (commission.currency !== gross.currency || lines.some((line) => line.amount.currency !== gross.currency)) {
    return fail({ code: 'CURRENCY_MISMATCH', left: gross.currency, right: commission.currency });
  }
  const distributed = commission.minor + lines.reduce((sum, line) => sum + line.amount.minor, 0);
  if (distributed !== gross.minor) {
    return fail({ code: 'CONSERVATION_VIOLATION', expected: gross.minor, actual: distributed });
  }
  return ok(true);
};

/**
 * Applies a time-decayed creator reward curve.
 *
 * Engagement earned early is worth more than engagement earned late: a post that
 * lands immediately is a stronger signal than one that accumulates views after
 * the feed has already moved on. Half-life in hours; returns basis points of the
 * base reward, floored at zero.
 */
export const timeDecayBps = (ageHours: number, halfLifeHours: number): number => {
  if (ageHours <= 0) return TOTAL_BPS;
  if (halfLifeHours <= 0) return 0;
  const factor = Math.pow(0.5, ageHours / halfLifeHours);
  return Math.max(0, Math.min(TOTAL_BPS, Math.round(factor * TOTAL_BPS)));
};

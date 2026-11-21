import { describe, expect, it } from 'vitest';
import { computeSplit, timeDecayBps } from './revenue.js';
import { convert } from './currency.js';
import { money } from './money.js';
import { bucketForUser, buildShardMap, evenBucketDistribution, shardForUser, VIRTUAL_BUCKET_COUNT } from './sharding.js';
import { uuidv7, uuidv7Time } from './ids.js';
import { isEligible, pacedBidCpm, relevanceScore } from './segments.js';

const bdt = (minor: number) => {
  const result = money(minor, 'BDT');
  if (!result.ok) throw new Error('fixture invalid');
  return result.value;
};

const USER_ID = '01930000-0000-7000-8000-000000000001';

describe('revenue split', () => {
  it('splits gross into commission plus exact party lines', () => {
    const result = computeSplit({
      gross: bdt(10_000),
      commissionBps: 1_500,
      parties: [
        { partyId: 'creator', weightBps: 7_000 },
        { partyId: 'referrer', weightBps: 3_000 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.commission.minor).toBe(1_500);
    expect(result.value.distributable.minor).toBe(8_500);
    expect(result.value.lines.map((line) => line.amount.minor)).toEqual([5_950, 2_550]);
    const total =
      result.value.commission.minor + result.value.lines.reduce((sum, line) => sum + line.amount.minor, 0);
    expect(total).toBe(10_000);
  });

  it('never loses a minor unit on awkward amounts', () => {
    for (let gross = 1; gross <= 400; gross += 1) {
      const result = computeSplit({
        gross: bdt(gross),
        commissionBps: 1_337,
        parties: [
          { partyId: 'a', weightBps: 3_333 },
          { partyId: 'b', weightBps: 3_333 },
          { partyId: 'c', weightBps: 3_334 },
        ],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const total =
        result.value.commission.minor + result.value.lines.reduce((sum, line) => sum + line.amount.minor, 0);
      expect(total).toBe(gross);
    }
  });

  it('rejects invalid commission rates and weights', () => {
    const base = { gross: bdt(1_000), parties: [{ partyId: 'a', weightBps: 10_000 }] };
    expect(computeSplit({ ...base, commissionBps: -1 }).ok).toBe(false);
    expect(computeSplit({ ...base, commissionBps: 6_000 }).ok).toBe(false);
    expect(computeSplit({ ...base, commissionBps: 10.5 }).ok).toBe(false);
    expect(computeSplit({ gross: bdt(1_000), commissionBps: 1_000, parties: [] }).ok).toBe(false);
    expect(
      computeSplit({ gross: bdt(1_000), commissionBps: 1_000, parties: [{ partyId: 'a', weightBps: 9_000 }] }).ok,
    ).toBe(false);
    expect(
      computeSplit({
        gross: bdt(1_000),
        commissionBps: 1_000,
        parties: [
          { partyId: 'a', weightBps: 5_000 },
          { partyId: 'b', weightBps: 0 },
        ],
      }).ok,
    ).toBe(false);
  });

  it('decays engagement rewards monotonically', () => {
    expect(timeDecayBps(0, 24)).toBe(10_000);
    expect(timeDecayBps(24, 24)).toBe(5_000);
    expect(timeDecayBps(48, 24)).toBe(2_500);
    expect(timeDecayBps(48, 24)).toBeLessThan(timeDecayBps(24, 24));
    expect(timeDecayBps(-5, 24)).toBe(10_000);
    expect(timeDecayBps(10, 0)).toBe(0);
  });
});

describe('currency conversion', () => {
  it('converts with half-up rounding at the minor unit', () => {
    const result = convert(bdt(10_000), { base: 'BDT', quote: 'USD', ratePpm: 9_100 });
    expect(result.ok && result.value.minor).toBe(91);
  });

  it('rejects mismatched or malformed rates', () => {
    expect(convert(bdt(10_000), { base: 'USD', quote: 'BDT', ratePpm: 100 }).ok).toBe(false);
    expect(convert(bdt(10_000), { base: 'BDT', quote: 'BDT', ratePpm: 0 }).ok).toBe(false);
  });
});

describe('shard routing', () => {
  it('is deterministic and bounded', () => {
    const first = bucketForUser(USER_ID);
    const second = bucketForUser(USER_ID);
    expect(first.ok && second.ok && first.value === second.value).toBe(true);
    if (first.ok) expect(first.value).toBeGreaterThanOrEqual(0);
    if (first.ok) expect(first.value).toBeLessThan(VIRTUAL_BUCKET_COUNT);
  });

  it('rejects malformed ids', () => {
    expect(bucketForUser('not-a-uuid').ok).toBe(false);
    expect(bucketForUser('').ok).toBe(false);
  });

  it('distributes users without collapsing onto one bucket', () => {
    const buckets = new Set<number>();
    for (let index = 0; index < 500; index += 1) {
      const id = `01930000-0000-7000-8000-${index.toString(16).padStart(12, '0')}`;
      const bucket = bucketForUser(id);
      if (bucket.ok) buckets.add(bucket.value);
    }
    expect(buckets.size).toBeGreaterThan(450);
  });

  it('resolves a user to a shard through the bucket table', () => {
    const shards = [
      { shardId: 'shard-0' as never, region: 'ap-south-1', primaryDsn: 'pg-0', replicaDsns: [] },
      { shardId: 'shard-1' as never, region: 'ap-south-1', primaryDsn: 'pg-1', replicaDsns: [] },
    ];
    const entries = evenBucketDistribution(shards);
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const map = buildShardMap(entries.value, 1);
    expect(map.ok).toBe(true);
    if (!map.ok) return;
    const location = shardForUser(USER_ID, map.value);
    expect(location.ok).toBe(true);
  });

  it('rejects duplicate or out-of-range bucket assignments', () => {
    const shard = { shardId: 's0' as never, region: 'r', primaryDsn: 'd', replicaDsns: [] };
    expect(buildShardMap([{ bucket: 1 as never, shard }, { bucket: 1 as never, shard }], 1).ok).toBe(false);
    expect(buildShardMap([{ bucket: VIRTUAL_BUCKET_COUNT as never, shard }], 1).ok).toBe(false);
    expect(evenBucketDistribution([]).ok).toBe(false);
  });

  it('reports unmapped buckets rather than guessing', () => {
    const map = buildShardMap([], 1);
    if (!map.ok) throw new Error('fixture invalid');
    expect(shardForUser(USER_ID, map.value)).toMatchObject({ ok: false, error: { code: 'UNMAPPED_BUCKET' } });
  });
});

describe('uuidv7', () => {
  it('produces standards-shaped, time-ordered ids', () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_001_000);
    expect(earlier).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Time(earlier)).toBe(1_700_000_000_000);
    expect(uuidv7Time(later)).toBe(1_700_000_001_000);
    expect(later > earlier).toBe(true);
  });

  it('rejects timestamps that are not non-negative integers', () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });

  it('generates unique ids under burst load', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });
});

describe('ad placement', () => {
  const audience = {
    interests: ['technology', 'education'],
    countryCode: 'BD',
    language: 'bn',
    ageBand: '25-34' as const,
  };

  it('matches interest, country, language and placement', () => {
    const targeting = {
      placements: ['FEED_INLINE' as const],
      interests: ['technology'],
      countries: ['BD'],
      languages: ['bn'],
      ageBands: ['25-34' as const],
      minRelevanceBps: 5_000,
    };
    expect(isEligible(targeting, 'FEED_INLINE', audience)).toBe(true);
    expect(isEligible(targeting, 'BLOG_INLINE', audience)).toBe(false);
    expect(isEligible({ ...targeting, countries: ['US'] }, 'FEED_INLINE', audience)).toBe(false);
    expect(isEligible({ ...targeting, languages: ['en'] }, 'FEED_INLINE', audience)).toBe(false);
    expect(isEligible({ ...targeting, interests: ['sports'] }, 'FEED_INLINE', audience)).toBe(false);
  });

  it('treats empty criteria as untargeted, not as a non-match', () => {
    const open = {
      placements: [],
      interests: [],
      countries: [],
      languages: [],
      ageBands: [],
      minRelevanceBps: 0,
    };
    expect(isEligible(open, 'SEARCH_RESULTS', { ...audience, ageBand: null })).toBe(true);
  });

  it('scores relevance inside [0, 10000]', () => {
    const score = relevanceScore({ interests: ['technology'] }, 'FEED_INLINE', audience);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(10_000);
    expect(relevanceScore({ interests: ['sports'] }, 'FEED_INLINE', audience)).toBeLessThan(score);
  });

  it('stops bidding when the budget is exhausted', () => {
    expect(
      pacedBidCpm({ placement: 'FEED_INLINE', audience, relevanceBps: 9_000, dailyBudgetRemainingMinor: 0, bidCpmMinor: 500 }),
    ).toBe(0);
    expect(
      pacedBidCpm({ placement: 'FEED_INLINE', audience, relevanceBps: 9_000, dailyBudgetRemainingMinor: 100, bidCpmMinor: 500 }),
    ).toBe(450);
  });
});

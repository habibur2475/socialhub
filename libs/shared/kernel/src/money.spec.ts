import { describe, expect, it } from 'vitest';
import { add, allocate, format, money, parse, subtract } from './money.js';

const bdt = (minor: number) => {
  const result = money(minor, 'BDT');
  if (!result.ok) throw new Error('fixture invalid');
  return result.value;
};

describe('money', () => {
  it('rejects non-integer minor units', () => {
    expect(money(10.5, 'BDT').ok).toBe(false);
  });

  it('keeps zero canonical (no negative zero)', () => {
    expect(Object.is(bdt(-0).minor, 0)).toBe(true);
  });

  it('formats according to currency exponent', () => {
    expect(format(bdt(123456))).toBe('1234.56');
    expect(format(bdt(5))).toBe('0.05');
    expect(format(bdt(-250))).toBe('-2.50');
    expect(format(money(1200, 'JPY').ok ? { currency: 'JPY', minor: 1200 } : bdt(0))).toBe('1200');
  });

  it('parses decimal strings exactly and rejects over-precise input', () => {
    const parsed = parse('1234.56', 'BDT');
    expect(parsed.ok && parsed.value.minor).toBe(123456);
    expect(parse('0.005', 'BDT').ok).toBe(false);
    expect(parse('100', 'BDT').ok && parse('100', 'BDT')).toMatchObject({
      value: { minor: 10000 },
    });
    expect(parse('01.00', 'BDT').ok).toBe(false);
  });

  it('refuses to mix currencies', () => {
    const usd = money(100, 'USD');
    if (!usd.ok) throw new Error('fixture invalid');
    expect(add(bdt(100), usd.value).ok).toBe(false);
    expect(subtract(usd.value, bdt(100)).ok).toBe(false);
  });

  it('allocates with largest remainder and conserves the total', () => {
    const result = allocate(bdt(100), [1, 1, 1]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const total = result.value.reduce((sum, part) => sum + part.minor, 0);
    expect(total).toBe(100);
    expect(result.value.map((part) => part.minor)).toEqual([34, 33, 33]);
  });

  it('conserves the total across many awkward splits', () => {
    for (let amount = 0; amount <= 500; amount += 1) {
      for (const weights of [
        [1, 2, 3],
        [7, 11, 13],
        [1, 1],
        [9999, 1],
      ]) {
        const result = allocate(bdt(amount), weights);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.value.reduce((sum, part) => sum + part.minor, 0)).toBe(amount);
        expect(result.value.every((part) => part.minor >= 0)).toBe(true);
      }
    }
  });

  it('rejects invalid allocation weights', () => {
    expect(allocate(bdt(100), [0, 0]).ok).toBe(false);
    expect(allocate(bdt(100), [-1, 2]).ok).toBe(false);
    expect(allocate(bdt(100), []).ok).toBe(true);
  });
});

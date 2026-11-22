import { describe, expect, it } from 'vitest';

import {
  EMPTY_CALCULATOR,
  applyKey,
  calculate,
  formatNumber,
  normaliseKeys,
} from './arithmetic.js';

describe('calculate', () => {
  it('honours precedence and parentheses', () => {
    expect(calculate('2 + 3 * 4')).toEqual({ ok: true, value: 14 });
    expect(calculate('(2 + 3) * 4')).toEqual({ ok: true, value: 20 });
    expect(calculate('10 - 2 - 3')).toEqual({ ok: true, value: 5 });
    expect(calculate('100 / 4 / 5')).toEqual({ ok: true, value: 5 });
  });

  it('reads a leading minus as a sign', () => {
    expect(calculate('-3 + 1')).toEqual({ ok: true, value: -2 });
    expect(calculate('5 * -2')).toEqual({ ok: true, value: -10 });
  });

  it('hides binary floating-point noise', () => {
    expect(calculate('0.1 + 0.2')).toEqual({ ok: true, value: 0.3 });
    expect(calculate('1 / 3')).toEqual({ ok: true, value: 0.333333333333 });
  });

  it('supports the remainder operator', () => {
    expect(calculate('7 % 3')).toEqual({ ok: true, value: 1 });
  });

  it('refuses division by zero instead of returning Infinity', () => {
    expect(calculate('1 / 0')).toEqual({ ok: false, error: { code: 'DIVISION_BY_ZERO' } });
    expect(calculate('1 % 0')).toEqual({ ok: false, error: { code: 'DIVISION_BY_ZERO' } });
  });

  it('refuses anything that is not arithmetic', () => {
    for (const expression of ['alert(1)', '2 +', 'name', '(1 + 2', '1 + 2)', '', '2 ** 3']) {
      expect(calculate(expression).ok).toBe(false);
    }
  });
});

describe('formatNumber', () => {
  it('groups thousands and drops trailing zeros', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(1234.5)).toBe('1,234.5');
    expect(formatNumber(-1234.567)).toBe('-1,234.567');
    expect(formatNumber(0)).toBe('0');
  });

  it('shows an em dash rather than NaN', () => {
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('the keypad', () => {
  const type = (keys: string) => keys.split('').reduce(applyKey, EMPTY_CALCULATOR);

  it('builds an expression and evaluates it', () => {
    expect(type('12+3=').result).toBe(15);
  });

  it('replaces a stacked operator rather than appending it', () => {
    expect(type('12+*').expression).toBe('12*');
  });

  it('starts a new sum from a digit after a result but continues from an operator', () => {
    const done = type('2+2=');
    expect(applyKey(done, '7').expression).toBe('7');
    expect(applyKey(done, '+').expression).toBe('4+');
  });

  it('does not allow two decimal points in one number', () => {
    expect(type('1.2.').expression).toBe('1.2');
  });

  it('starts a decimal with a leading zero', () => {
    expect(applyKey(EMPTY_CALCULATOR, '.').expression).toBe('0.');
  });

  it('clears on C and deletes one character on DEL', () => {
    expect(applyKey(type('123'), 'DEL').expression).toBe('12');
    expect(applyKey(type('123'), 'C')).toEqual(EMPTY_CALCULATOR);
  });

  it('shows an error instead of a result when the expression is refused', () => {
    expect(type('1/0=')).toEqual({ expression: '1/0', result: null, error: 'DIVISION_BY_ZERO' });
  });

  it('normalises the glyphs a phone keypad produces', () => {
    expect(normaliseKeys('6×7÷2−1')).toBe('6*7/2-1');
  });
});

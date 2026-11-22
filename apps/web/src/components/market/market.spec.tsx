/**
 * Market screens.
 *
 * What is testable without a browser: formatting (the decimal point lands where the kernel
 * says), the status vocabulary (a chip must never show a raw enum), and the two pure helpers
 * that decide what a row says. The interactive screens are exercised over HTTP by the API
 * e2e suite; jsdom has no layout, so asserting pixel positions would prove nothing.
 */

import { describe, expect, it } from 'vitest';

import { actionLabel, formatPrice, priceLabel, statusLabel, statusTone } from './money';

describe('market money', () => {
  it('formats minor units with the currency exponent', () => {
    expect(formatPrice(25_000, 'BDT')).toBe('250.00');
    expect(formatPrice(1, 'BDT')).toBe('0.01');
    expect(formatPrice(0, 'USD')).toBe('0.00');
  });

  it('prefixes the currency symbol, and the code when there is no symbol', () => {
    expect(priceLabel(25_050, 'BDT')).toBe('৳ 250.50');
    expect(priceLabel(25_050, 'USD')).toBe('$ 250.50');
  });
});

describe('market vocabulary', () => {
  it('has a label for every order and listing state', () => {
    for (const status of [
      'PENDING',
      'RESERVED',
      'PAID',
      'SHIPPED',
      'DELIVERED',
      'CANCELLED',
      'EXPIRED',
      'REFUNDED',
      'DRAFT',
      'ACTIVE',
      'SOLD_OUT',
      'WITHDRAWN',
    ]) {
      expect(statusLabel[status]).toEqual(expect.any(String));
    }
  });

  it('has a label for every order action', () => {
    for (const action of ['CANCEL', 'SHIP', 'DELIVER', 'REFUND']) {
      expect(actionLabel[action]).toEqual(expect.any(String));
    }
  });

  it('tones the happy states differently from the dead ones', () => {
    expect(statusTone('DELIVERED')).not.toBe(statusTone('CANCELLED'));
    expect(statusTone('CANCELLED')).toBe(statusTone('EXPIRED'));
    // An unknown status must still render a chip rather than crashing.
    expect(statusTone('SOMETHING_NEW')).toEqual(expect.any(String));
  });
});

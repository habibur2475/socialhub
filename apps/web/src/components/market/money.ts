/**
 * Money on a market screen.
 *
 * The API sends integer minor units, and that is what travels through the app. Formatting
 * happens once, at render, using the kernel's own `format` — the same function the receipt
 * and the tests use. A second implementation here would be a second opinion about where the
 * decimal point goes.
 */

import { format } from '@socialhub/kernel/browser';

import type { MarketCurrency } from '@socialhub/contracts';

export const formatPrice = (minor: number, currency: MarketCurrency): string =>
  format({ currency, minor });

/** The currency's own symbol where there is one, and the code otherwise. */
const SYMBOLS: Readonly<Record<string, string>> = {
  BDT: '৳',
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
};

export const priceLabel = (minor: number, currency: MarketCurrency): string =>
  `${SYMBOLS[currency] ?? currency} ${formatPrice(minor, currency)}`;

export const statusLabel: Readonly<Record<string, string>> = {
  PENDING: 'Pending',
  RESERVED: 'Awaiting payment',
  PAID: 'Paid',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  REFUNDED: 'Refunded',
  DRAFT: 'Draft',
  ACTIVE: 'On sale',
  SOLD_OUT: 'Sold out',
  WITHDRAWN: 'Withdrawn',
};

export const actionLabel: Readonly<Record<string, string>> = {
  CANCEL: 'Cancel order',
  SHIP: 'Mark as shipped',
  DELIVER: 'Mark as delivered',
  REFUND: 'Refund',
};

/**
 * The status chips use one palette for both listings and orders — a green chip means "good
 * and current" in both lists, which is what a colour is for.
 */
export const statusTone = (status: string): string => {
  switch (status) {
    case 'DELIVERED':
    case 'ACTIVE':
    case 'PAID':
      return 'bg-success/10 text-success';
    case 'SHIPPED':
    case 'RESERVED':
    case 'PENDING':
      return 'bg-primary/10 text-primary';
    case 'CANCELLED':
    case 'EXPIRED':
    case 'WITHDRAWN':
      return 'bg-raised text-muted';
    case 'REFUNDED':
    case 'SOLD_OUT':
      return 'bg-warning/10 text-warning';
    default:
      return 'bg-raised text-muted';
  }
};

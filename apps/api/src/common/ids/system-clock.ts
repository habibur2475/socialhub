/**
 * Time and identifier providers.
 *
 * Injected rather than called directly so that token expiry, lockout windows and
 * audit ordering are testable without sleeping or freezing global state.
 */

import { uuidv7 } from '@socialhub/kernel';

export type TimeSource = { readonly now: () => Date };

export const systemClock: TimeSource = { now: () => new Date() };

export type IdentifierSource = { readonly next: () => string };

export const uuidv7Identifiers: IdentifierSource = { next: () => uuidv7() };

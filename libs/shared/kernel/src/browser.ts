/**
 * Browser-safe kernel entry point.
 *
 * The main barrel re-exports modules that legitimately need Node built-ins:
 * `ids.ts` mints UUIDv7 from `randomBytes`, and `sharding.ts` hashes shard keys
 * with `createHash`. Neither belongs in a browser bundle — Node APIs cannot be
 * polyfilled meaningfully there, and a bundler asked to try fails the whole build
 * with `UnhandledSchemeError`.
 *
 * Until this module existed, importing a single type from `@socialhub/kernel` in
 * a React component pulled the entire barrel into the client graph. This is a
 * deliberate narrowing, not a duplicate barrel: it re-exports only modules that
 * are pure (no I/O, no Node built-ins), and the list is short enough to audit.
 *
 * Anything imported here must be usable in a browser and in Node identically.
 * Server-only concerns stay in the main entry point.
 */

export * from './result.js';
export * from './brand.js';
export * from './money.js';
export * from './currency.js';
export * from './errors.js';
export * from './identity.js';
export * from './permissions.js';
export * from './policy.js';
export * from './scope.js';
export * from './revenue.js';
export * from './time.js';
export * from './segments.js';
export * from './relationships.js';
export * from './feed.js';
export * from './notifications.js';
export * from './quiz.js';
export * from './messaging.js';

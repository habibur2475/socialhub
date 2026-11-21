/**
 * Clock token.
 *
 * Time is a dependency, not a language feature: a service that calls `new Date()`
 * cannot be tested for expiry, lockout windows or token rotation. One token keeps
 * every consumer on the same clock.
 */

export const CLOCK = Symbol('CLOCK');

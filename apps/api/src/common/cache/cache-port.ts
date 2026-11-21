/**
 * Cache port.
 *
 * Application code depends on this interface, never on Redis. Two adapters
 * satisfy it: a Redis implementation for every deployed environment, and an
 * in-process implementation used by tests and by developers who want to run the
 * API without infrastructure.
 *
 * The sliding-window primitive is part of the port rather than an ad-hoc script:
 * rate limiting is a correctness concern, so its semantics must be identical
 * under both adapters (and they are — both are exact, not fixed-window
 * approximations).
 */

export type CachePort = {
  /** Returns null for a missing key. Never throws for a missing key. */
  get(key: string): Promise<string | null>;
  /** `ttlSeconds: null` stores the key without expiry (used for the audit chain head). */
  set(key: string, value: string, ttlSeconds: number | null): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Records an event and reports whether it fits inside the window.
   * Exact sliding window: events older than `windowMs` are discarded first.
   */
  allowInSlidingWindow(
    key: string,
    limit: number,
    windowMs: number,
    member: string,
  ): Promise<boolean>;
  /** Empties one sliding-window key. */
  clearSlidingWindow(key: string): Promise<void>;
  /** Liveness probe used by the readiness endpoint. */
  ping(): Promise<boolean>;
};

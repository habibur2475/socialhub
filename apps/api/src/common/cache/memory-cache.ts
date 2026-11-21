/**
 * In-process cache adapter.
 *
 * Correctness-compatible with the Redis adapter, with three deliberate
 * differences documented in code: state is per-process, it is lost on restart,
 * and it is not shared across instances. That makes it suitable for tests and
 * single-process development, and unsuitable for anything horizontally scaled.
 *
 * Expiry is evaluated lazily on read plus swept opportunistically, so memory is
 * reclaimed without a timer holding the process alive.
 */

import type { CachePort } from './cache-port.js';

type Entry = { readonly value: string; readonly expiresAt: number };

const SWEEP_INTERVAL_MS = 60_000;

export class MemoryCache implements CachePort {
  private readonly values = new Map<string, Entry>();
  private readonly windows = new Map<string, number[]>();
  private lastSweep = Date.now();

  public constructor(private readonly now: () => number = () => Date.now()) {}

  public async get(key: string): Promise<string | null> {
    this.sweepIfDue();
    const entry = this.values.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  public async set(key: string, value: string, ttlSeconds: number | null): Promise<void> {
    const expiresAt =
      ttlSeconds === null ? Number.POSITIVE_INFINITY : this.now() + ttlSeconds * 1_000;
    this.values.set(key, { value, expiresAt });
  }

  public async del(key: string): Promise<void> {
    this.values.delete(key);
    this.windows.delete(key);
  }

  public async allowInSlidingWindow(
    key: string,
    limit: number,
    windowMs: number,
    member: string,
  ): Promise<boolean> {
    const now = this.now();
    const cutoff = now - windowMs;
    const existing = this.windows.get(key) ?? [];
    const recent = existing.filter((timestamp) => timestamp > cutoff);

    // `member` is accepted for interface parity. The in-process adapter counts
    // events rather than distinct members, which is the same guarantee the Redis
    // sorted set provides for our call pattern (unique member per attempt).
    void member;

    if (recent.length >= limit) {
      this.windows.set(key, recent);
      return false;
    }
    recent.push(now);
    this.windows.set(key, recent);
    return true;
  }

  public async clearSlidingWindow(key: string): Promise<void> {
    this.windows.delete(key);
  }

  public async ping(): Promise<boolean> {
    return true;
  }

  /** Test helper: drops every key so suites do not leak state between cases. */
  public clear(): void {
    this.values.clear();
    this.windows.clear();
  }

  private sweepIfDue(): void {
    const now = this.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) this.values.delete(key);
    }
  }
}

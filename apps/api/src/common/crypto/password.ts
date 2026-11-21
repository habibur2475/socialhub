/**
 * Password hashing and credential material.
 *
 * Argon2id is the only accepted algorithm: it is memory-hard (resists GPU and
 * ASIC cracking), side-channel resistant (data-independent first pass), and the
 * OWASP first choice for new systems.
 *
 * Parameters are injected rather than hard-coded so that they can be raised over
 * time; `needsRehash` lets the login path transparently upgrade a stored hash
 * the next time the user presents their password.
 */

import { Injectable } from '@nestjs/common';
import { type Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Env } from '../../config/env.js';

const ARGON2ID: Algorithm = 2;

export type HashPolicy = {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
};

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(digest: string, password: string): Promise<boolean>;
  needsRehash(digest: string): boolean;
};

/**
 * Upper bound on accepted password length.
 *
 * Argon2 itself handles long inputs, but hashing unbounded input is a cheap
 * denial-of-service: 1 MiB of "password" costs the server ~1 MiB of memory per
 * attempt. 128 characters covers passphrase users comfortably.
 */
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_PASSWORD_LENGTH = 10;

@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly policy: HashPolicy;

  public constructor(
    env: Pick<Env, 'ARGON2_MEMORY_KIB' | 'ARGON2_TIME_COST' | 'ARGON2_PARALLELISM'>,
  ) {
    this.policy = {
      memoryCost: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    };
  }

  public async hash(password: string): Promise<string> {
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new RangeError(`Password exceeds ${MAX_PASSWORD_LENGTH} characters`);
    }
    return argonHash(password.normalize('NFKC'), {
      algorithm: ARGON2ID,
      memoryCost: this.policy.memoryCost,
      timeCost: this.policy.timeCost,
      parallelism: this.policy.parallelism,
      // 32-byte salt and 32-byte output are the library defaults; stated here so
      // a future dependency bump cannot silently weaken them.
      salt: randomBytes(32),
      outputLen: 32,
    });
  }

  /**
   * Verifies without leaking *why* a check failed. A malformed stored digest is
   * treated as a mismatch rather than an exception, so a corrupted row cannot
   * turn a login attempt into a 500.
   */
  public async verify(digest: string, password: string): Promise<boolean> {
    if (password.length > MAX_PASSWORD_LENGTH) return false;
    try {
      return await argonVerify(digest, password.normalize('NFKC'), {
        algorithm: ARGON2ID,
        memoryCost: this.policy.memoryCost,
        timeCost: this.policy.timeCost,
        parallelism: this.policy.parallelism,
      });
    } catch {
      return false;
    }
  }

  /**
   * True when the stored digest was produced with weaker parameters than the
   * current policy, or with another algorithm.
   */
  public needsRehash(digest: string): boolean {
    const parameters = parseArgon2Parameters(digest);
    if (parameters === null) return true;
    if (parameters.algorithm !== 'argon2id') return true;
    return (
      parameters.memoryCost < this.policy.memoryCost ||
      parameters.timeCost < this.policy.timeCost ||
      parameters.parallelism !== this.policy.parallelism
    );
  }
}

type Argon2Parameters = {
  readonly algorithm: string;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
};

const PHC_PATTERN =
  /^\$(argon2(?:id|i|d))\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

export const parseArgon2Parameters = (digest: string): Argon2Parameters | null => {
  const match = PHC_PATTERN.exec(digest);
  if (match === null) return null;
  const [, algorithm, memory, time, parallelism] = match;
  if (
    algorithm === undefined ||
    memory === undefined ||
    time === undefined ||
    parallelism === undefined
  ) {
    return null;
  }
  return {
    algorithm,
    memoryCost: Number(memory),
    timeCost: Number(time),
    parallelism: Number(parallelism),
  };
};

/**
 * Constant-time comparison for fixed-length secrets (session ids, digests).
 * Length is compared first because `timingSafeEqual` throws on differing
 * lengths; both inputs here are always 32 bytes by construction.
 */
export const constantTimeEquals = (left: Buffer, right: Buffer): boolean => {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

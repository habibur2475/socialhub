/**
 * Privacy-preserving digests for request metadata.
 *
 * Client IPs are personal data. We keep them out of logs and the audit table
 * while retaining the ability to correlate abuse: a keyed digest is stable for a
 * given address (so repeated attempts from one source correlate) but cannot be
 * reversed or rainbow-tabled without the key.
 */

import { createHmac } from 'node:crypto';

export type RequestFingerprints = {
  readonly ipHash: (ip: string | undefined) => string | null;
};

export const createFingerprints = (pepper: string): RequestFingerprints => {
  if (pepper.length < 32) {
    throw new Error('Fingerprint pepper must be at least 32 characters');
  }
  return {
    ipHash: (ip) =>
      ip === undefined || ip.length === 0
        ? null
        : createHmac('sha256', pepper).update(ip).digest('hex'),
  };
};

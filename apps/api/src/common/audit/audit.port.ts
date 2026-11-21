/**
 * Audit port.
 *
 * The audit trail is cross-cutting: authentication records logins, the social
 * graph records blocks, and the marketplace will record payouts. It therefore
 * lives in `common/` rather than inside whichever module happened to need it
 * first, so a feature module depends on the capability rather than on auth.
 *
 * An entry is a *claim about the past*. `actorId` is nullable because some events
 * (a rejected token, an expired session) have no confirmed actor — recording one
 * anyway would be inventing evidence.
 */

import type { AccountType } from '@socialhub/kernel';

export type AuditEvent = {
  readonly action: string;
  readonly actorId: string | null;
  readonly actorType: AccountType | null;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly outcome: 'SUCCESS' | 'DENIED' | 'ERROR';
  readonly ipHash: string | null;
  readonly userAgent: string | null;
  readonly traceId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type AuditSink = {
  record(event: AuditEvent): Promise<void>;
};

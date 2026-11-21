/**
 * Identity model — the hard security boundary.
 *
 * L1 of the four-layer access design. There are exactly three account classes
 * and the list is closed: adding a fourth requires a schema migration, a policy
 * review, and a security sign-off, which is precisely the friction we want.
 *
 * USER  : external humans. Never reachable from internal scopes.
 * STAFF : internal operators. Always carry a staff profile (HR data).
 * ROOT  : system owner. At most two, cannot be deleted or demoted, every action
 *         audited at maximum verbosity.
 */

export const ACCOUNT_TYPES = ['USER', 'STAFF', 'ROOT'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_STATES = [
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'LOCKED',
  'DEACTIVATED',
  'SOFT_DELETED',
] as const;

export type AccountState = (typeof ACCOUNT_STATES)[number];

/** States in which authentication may complete and tokens may be issued. */
const AUTHENTICATABLE_STATES: ReadonlySet<AccountState> = new Set(['ACTIVE']);

/** States in which the account still occupies its unique email/phone slot. */
const IDENTITY_RESERVING_STATES: ReadonlySet<AccountState> = new Set([
  'PENDING_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'LOCKED',
]);

export const canAuthenticate = (state: AccountState): boolean => AUTHENTICATABLE_STATES.has(state);

export const reservesIdentity = (state: AccountState): boolean => IDENTITY_RESERVING_STATES.has(state);

/**
 * Whether an actor may operate on a target account.
 *
 * Rules, in order of precedence:
 *  1. Nobody acts on themselves except through self-service flows, which never
 *     route through this function.
 *  2. ROOT is inviolable: no actor can modify or delete a ROOT account.
 *  3. ROOT may act on anyone else.
 *  4. STAFF may act on USER accounts only — never on other STAFF.
 *
 * The consequence is that a compromised STAFF session can never escalate into
 * admin-on-admin tampering, and a compromised ROOT session cannot delete the
 * other ROOT by accident.
 */
export const canManageAccount = (actor: AccountType, target: AccountType): boolean => {
  if (target === 'ROOT') return false;
  if (actor === 'ROOT') return true;
  if (actor === 'STAFF') return target === 'USER';
  return false;
};

export const MAX_ROOT_ACCOUNTS = 2;

export const isInternalAccount = (accountType: AccountType): boolean => accountType !== 'USER';

/**
 * Access evaluation — L2 (RBAC) + L3 (scope) + L4 (ABAC) in one decision point.
 *
 * The decision is expressed as a list of typed requirements rather than a
 * boolean, so a 403 response can explain *which* requirement failed without
 * leaking anything the actor is not already entitled to know.
 *
 * Evaluation order is deliberate and short-circuits:
 *   1. account state  — a locked account has no authority at all
 *   2. permission     — the coarse capability gate, served from the cached mask
 *   3. scope          — does the actor's scope subtree contain the target scope
 *   4. policy         — runtime ABAC rules (ownership, tenancy, time, risk)
 */

import type { AccountState, AccountType } from './identity.js';
import type { Permission, PermissionMask } from './permissions.js';
import type { ScopeId } from './brand.js';

export type Principal = {
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly state: AccountState;
  readonly permissions: PermissionMask;
  /** Scope nodes the principal holds roles on. Absent for ROOT and external USER. */
  readonly scopes: readonly ScopeId[];
};

export type Requirement =
  | { readonly kind: 'permission'; readonly permission: Permission }
  | { readonly kind: 'any_permission'; readonly permissions: readonly Permission[] }
  | { readonly kind: 'account_type'; readonly oneOf: readonly AccountType[] }
  | { readonly kind: 'scope'; readonly scope: ScopeId; readonly allowDescendants: boolean }
  | { readonly kind: 'policy'; readonly name: string; readonly evaluate: PolicyPredicate };

export type PolicyPredicate = (context: PolicyContext) => boolean;

export type PolicyContext = {
  readonly principal: Principal;
  readonly targetScope: ScopeId | null;
  readonly resourceOwnerId: string | null;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
};

export type DenialReason =
  | { readonly kind: 'account_state'; readonly state: AccountState }
  | { readonly kind: 'missing_permission'; readonly permission: string }
  | { readonly kind: 'account_type'; readonly actual: AccountType }
  | { readonly kind: 'out_of_scope'; readonly scope: ScopeId }
  | { readonly kind: 'policy_failed'; readonly policy: string };

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenialReason };

export const ALLOW: Decision = { allowed: true };

export const deny = (reason: DenialReason): Decision => ({ allowed: false, reason });

export type ScopeResolver = (parent: ScopeId, child: ScopeId) => boolean;

/**
 * Evaluates a requirement set. All requirements must hold (AND semantics);
 * alternative permissions are expressed with `any_permission`.
 */
export const evaluate = (
  principal: Principal,
  requirements: readonly Requirement[],
  context: Omit<PolicyContext, 'principal'>,
  isDescendantScope: ScopeResolver,
): Decision => {
  if (principal.state !== 'ACTIVE') {
    return deny({ kind: 'account_state', state: principal.state });
  }

  const fullContext: PolicyContext = { ...context, principal };

  for (const requirement of requirements) {
    switch (requirement.kind) {
      case 'permission': {
        if (!principal.permissions.has(requirement.permission)) {
          return deny({ kind: 'missing_permission', permission: requirement.permission });
        }
        break;
      }
      case 'any_permission': {
        if (!principal.permissions.hasAny(requirement.permissions)) {
          return deny({
            kind: 'missing_permission',
            permission: requirement.permissions.join('|'),
          });
        }
        break;
      }
      case 'account_type': {
        if (!requirement.oneOf.includes(principal.accountType)) {
          return deny({ kind: 'account_type', actual: principal.accountType });
        }
        break;
      }
      case 'scope': {
        const target = context.targetScope;
        const allowed =
          target !== null &&
          principal.scopes.some(
            (held) =>
              held === target || (requirement.allowDescendants && isDescendantScope(held, target)),
          );
        if (!allowed) return deny({ kind: 'out_of_scope', scope: requirement.scope });
        break;
      }
      case 'policy': {
        if (!requirement.evaluate(fullContext)) {
          return deny({ kind: 'policy_failed', policy: requirement.name });
        }
        break;
      }
    }
  }

  return ALLOW;
};

/** Ownership rule used by user-authored resources (posts, blogs, listings). */
export const isResourceOwner: PolicyPredicate = (context) =>
  context.resourceOwnerId !== null && context.resourceOwnerId === context.principal.accountId;

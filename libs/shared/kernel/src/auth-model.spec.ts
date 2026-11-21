import { describe, expect, it } from 'vitest';
import { canAuthenticate, canManageAccount, MAX_ROOT_ACCOUNTS, reservesIdentity } from './identity.js';
import { PERMISSIONS, PermissionMask, aggregatePermissions, permissionBit } from './permissions.js';
import { evaluate, isResourceOwner, type Principal } from './policy.js';
import { isWithinScope, appendScope, isLegalChild, rootPath } from './scope.js';

const active = (overrides: Partial<Principal> = {}): Principal => ({
  accountId: '01930000-0000-7000-8000-000000000001',
  accountType: 'STAFF',
  state: 'ACTIVE',
  permissions: PermissionMask.fromList(['user:read']),
  scopes: [],
  ...overrides,
});

describe('permission mask', () => {
  it('uses 64-bit semantics beyond index 31', () => {
    const beyond = PERMISSIONS[40];
    expect(beyond).toBeDefined();
    if (beyond === undefined) return;
    const mask = PermissionMask.fromList([beyond]);
    expect(mask.has(beyond)).toBe(true);
    expect(mask.toList()).toEqual([beyond]);
    expect(permissionBit(beyond) > 0xffffffffn).toBe(true);
  });

  it('round-trips through its string form', () => {
    const mask = aggregatePermissions([['user:read', 'blog:write'], ['audit:read']]);
    const restored = PermissionMask.fromString(mask.toString());
    expect(restored?.toList()).toEqual(mask.toList());
  });

  it('rejects malformed persisted masks', () => {
    expect(PermissionMask.fromString('-1')).toBeNull();
    expect(PermissionMask.fromString('1.5')).toBeNull();
    expect(PermissionMask.fromString('abc')).toBeNull();
    expect(PermissionMask.fromString('99999999999999999999999')).toBeNull();
  });

  it('round-trips through fixed-width words', () => {
    const mask = aggregatePermissions([PERMISSIONS.slice(0, 40), PERMISSIONS.slice(60)]);
    const restored = PermissionMask.fromWords(mask.toWords());
    expect(restored?.equals(mask)).toBe(true);
    expect(PermissionMask.fromWords(['1', '18446744073709551616'])).toBeNull();
    expect(PermissionMask.fromWords(['-1'])).toBeNull();
  });

  it('counts and removes without leaking bits beyond the catalogue', () => {
    const mask = PermissionMask.fromList(['user:read', 'audit:read']);
    expect(mask.cardinality()).toBe(2);
    expect(PermissionMask.NONE.except(mask).isEmpty()).toBe(true);
    expect(mask.except(mask).isEmpty()).toBe(true);
  });

  it('supports union, intersection and removal', () => {
    const a = PermissionMask.fromList(['user:read', 'user:manage']);
    const b = PermissionMask.fromList(['user:manage', 'audit:read']);
    expect(a.union(b).toList()).toEqual(['user:read', 'user:manage', 'audit:read']);
    expect(a.intersect(b).toList()).toEqual(['user:manage']);
    expect(a.except(b).toList()).toEqual(['user:read']);
  });

  it('distinguishes hasAll from hasAny', () => {
    const mask = PermissionMask.fromList(['user:read']);
    expect(mask.hasAll(['user:read'])).toBe(true);
    expect(mask.hasAll(['user:read', 'user:manage'])).toBe(false);
    expect(mask.hasAny(['user:manage', 'user:read'])).toBe(true);
    expect(mask.hasAny([])).toBe(false);
  });
});

describe('identity boundaries', () => {
  it('only ACTIVE accounts authenticate', () => {
    expect(canAuthenticate('ACTIVE')).toBe(true);
    for (const state of ['PENDING_VERIFICATION', 'SUSPENDED', 'LOCKED', 'DEACTIVATED', 'SOFT_DELETED'] as const) {
      expect(canAuthenticate(state)).toBe(false);
    }
  });

  it('reserves identity until deactivated', () => {
    expect(reservesIdentity('PENDING_VERIFICATION')).toBe(true);
    expect(reservesIdentity('LOCKED')).toBe(true);
    expect(reservesIdentity('DEACTIVATED')).toBe(false);
    expect(reservesIdentity('SOFT_DELETED')).toBe(false);
  });

  it('protects ROOT from every actor including ROOT', () => {
    expect(canManageAccount('ROOT', 'ROOT')).toBe(false);
    expect(canManageAccount('STAFF', 'ROOT')).toBe(false);
    expect(canManageAccount('USER', 'ROOT')).toBe(false);
  });

  it('never lets STAFF act on STAFF or escalate to ROOT', () => {
    expect(canManageAccount('STAFF', 'STAFF')).toBe(false);
    expect(canManageAccount('STAFF', 'USER')).toBe(true);
    expect(canManageAccount('USER', 'USER')).toBe(false);
    expect(canManageAccount('ROOT', 'STAFF')).toBe(true);
  });

  it('caps ROOT accounts', () => {
    expect(MAX_ROOT_ACCOUNTS).toBe(2);
  });
});

describe('policy evaluation', () => {
  it('denies non-active principals before anything else', () => {
    const decision = evaluate(active({ state: 'LOCKED' }), [{ kind: 'permission', permission: 'user:read' }], {
      targetScope: null,
      resourceOwnerId: null,
      attributes: {},
    }, () => false);
    expect(decision.allowed).toBe(false);
  });

  it('requires every listed requirement', () => {
    const decision = evaluate(
      active(),
      [
        { kind: 'permission', permission: 'user:read' },
        { kind: 'account_type', oneOf: ['STAFF', 'ROOT'] },
      ],
      { targetScope: null, resourceOwnerId: null, attributes: {} },
      () => false,
    );
    expect(decision.allowed).toBe(true);

    const denied = evaluate(
      active(),
      [
        { kind: 'permission', permission: 'user:read' },
        { kind: 'permission', permission: 'payroll:process' },
      ],
      { targetScope: null, resourceOwnerId: null, attributes: {} },
      () => false,
    );
    expect(denied).toMatchObject({ allowed: false, reason: { kind: 'missing_permission' } });
  });

  it('enforces scope containment for scoped principals', () => {
    const scoped = active({ scopes: ['01930000-0000-7000-8000-0000000000aa' as Principal['scopes'][number]] });
    const target = '01930000-0000-7000-8000-0000000000bb' as Principal['scopes'][number];
    const inScope = evaluate(scoped, [{ kind: 'scope', scope: target, allowDescendants: true }], {
      targetScope: target,
      resourceOwnerId: null,
      attributes: {},
    }, () => true);
    expect(inScope.allowed).toBe(true);

    const outOfScope = evaluate(scoped, [{ kind: 'scope', scope: target, allowDescendants: true }], {
      targetScope: target,
      resourceOwnerId: null,
      attributes: {},
    }, () => false);
    expect(outOfScope).toMatchObject({ allowed: false, reason: { kind: 'out_of_scope' } });
  });

  it('applies ownership policies', () => {
    const principal = active();
    const decision = evaluate(
      principal,
      [{ kind: 'policy', name: 'owner', evaluate: isResourceOwner }],
      { targetScope: null, resourceOwnerId: principal.accountId, attributes: {} },
      () => false,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('scope graph', () => {
  it('rejects skipping levels', () => {
    expect(isLegalChild('COMPANY', 'BRANCH')).toBe(false);
    expect(isLegalChild('COMPANY', 'REGION')).toBe(true);
    expect(isLegalChild('DEPARTMENT', 'POSITION')).toBe(true);
  });

  it('builds canonical paths', () => {
    const root = rootPath('socialhub');
    expect(root).toBe('/socialhub/');
    const region = appendScope({ path: root, level: 'COMPANY' }, 'REGION', 'khulna');
    expect(region).toEqual({ ok: true, value: '/socialhub/khulna/' });
    if (!region.ok) return;
    expect(appendScope({ path: region.value, level: 'REGION' }, 'BRANCH', 'main')).toMatchObject({
      value: '/socialhub/khulna/main/',
    });
  });

  it('does not confuse sibling segments sharing a prefix', () => {
    const a = '/socialhub/khulna/branch-1/';
    const b = '/socialhub/khulna/branch-10/';
    expect(isWithinScope(a, b)).toBe(false);
    expect(isWithinScope('/socialhub/khulna/', b)).toBe(true);
    expect(isWithinScope('/socialhub/', '/socialhub/')).toBe(true);
    expect(isWithinScope('/', a)).toBe(true);
  });

  it('rejects duplicate or malformed segments', () => {
    const root = rootPath('socialhub');
    expect(appendScope({ path: root, level: 'COMPANY' }, 'REGION', 'socialhub')).toMatchObject({
      ok: false,
    });
    expect(appendScope({ path: root, level: 'COMPANY' }, 'REGION', 'Bad Segment')).toMatchObject({ ok: false });
  });
});

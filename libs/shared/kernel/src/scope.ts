/**
 * Organisational scope graph — L3 of the access model.
 *
 * The hierarchy is fixed at five levels and will not grow:
 *
 *   COMPANY > REGION > BRANCH > DEPARTMENT > POSITION
 *
 * Every node is identified by a UUIDv7 and carries a materialised path such as
 * `/c0ffee/region-a/branch-7/dept-3/`. Ancestry checks are then pure string
 * prefix comparisons — O(1) memory, no recursive query, cacheable in Redis —
 * which is what allows scope checks to stay off the database on the hot path.
 */

import type { ScopeId } from './brand.js';

export const SCOPE_LEVELS = ['COMPANY', 'REGION', 'BRANCH', 'DEPARTMENT', 'POSITION'] as const;

export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export type ScopeNode = {
  readonly id: ScopeId;
  /** Slash-delimited, leading and trailing slash, root-to-node order. */
  readonly path: string;
  readonly level: ScopeLevel;
  readonly name: string;
  readonly parentId: ScopeId | null;
};

export type ScopeError =
  | { readonly code: 'INVALID_PATH'; readonly path: string }
  | {
      readonly code: 'LEVEL_ORDER_VIOLATION';
      readonly parent: ScopeLevel;
      readonly child: ScopeLevel;
    }
  | { readonly code: 'DUPLICATE_SEGMENT'; readonly segment: string };

const LEVEL_INDEX: ReadonlyMap<ScopeLevel, number> = new Map(
  SCOPE_LEVELS.map((level, index) => [level, index]),
);

const SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const scopeDepth = (level: ScopeLevel): number => {
  const index = LEVEL_INDEX.get(level);
  if (index === undefined) throw new RangeError(`Unknown scope level: ${String(level)}`);
  return index + 1;
};

/** A child must sit exactly one level below its parent; skipping levels is rejected. */
export const isLegalChild = (parent: ScopeLevel, child: ScopeLevel): boolean =>
  scopeDepth(child) === scopeDepth(parent) + 1;

export const rootPath = (companySegment: string): string => {
  if (!SEGMENT_PATTERN.test(companySegment)) {
    throw new TypeError('Company segment must be lowercase alphanumeric with hyphens');
  }
  return `/${companySegment}/`;
};

export const appendScope = (
  parent: Pick<ScopeNode, 'path' | 'level'>,
  childLevel: ScopeLevel,
  segment: string,
): ScopeNode['path'] extends string ? import('./result.js').Result<string, ScopeError> : never => {
  type R = import('./result.js').Result<string, ScopeError>;
  const fail = (error: ScopeError): R => ({ ok: false, error });
  if (!isLegalChild(parent.level, childLevel)) {
    return fail({ code: 'LEVEL_ORDER_VIOLATION', parent: parent.level, child: childLevel });
  }
  if (!SEGMENT_PATTERN.test(segment)) return fail({ code: 'INVALID_PATH', path: segment });
  if (parent.path.includes(`/${segment}/`)) return fail({ code: 'DUPLICATE_SEGMENT', segment });
  return { ok: true, value: `${parent.path}${segment}/` };
};

/**
 * True when `child` is `ancestor` or lives beneath it. Because paths are
 * canonical, prefix equality is sufficient and cannot produce false positives
 * on look-alike segments ("branch-1" vs "branch-10") — the trailing slash in the
 * path is what guarantees that.
 */
export const isWithinScope = (ancestorPath: string, candidatePath: string): boolean => {
  if (!ancestorPath.endsWith('/') || !candidatePath.endsWith('/')) return false;
  return candidatePath.startsWith(ancestorPath);
};

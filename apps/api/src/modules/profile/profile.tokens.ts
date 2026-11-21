/**
 * Injection tokens for the profile module.
 *
 * Ports are interfaces, which vanish at runtime, so they are bound to symbols.
 * One module for every token keeps the dependency graph greppable.
 */

export const PROFILE_SERVICE = Symbol('PROFILE_SERVICE');
export const PROFILE_STORE = Symbol('PROFILE_STORE');
export const SOCIAL_GRAPH_STORE = Symbol('SOCIAL_GRAPH_STORE');

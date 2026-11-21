/**
 * Injection tokens.
 *
 * Ports are interfaces, which do not exist at runtime, so they are bound to
 * symbols. Keeping every token in one module makes the dependency graph
 * greppable and prevents a circular import between a module and the classes it
 * wires together.
 */

export const AUTH_SERVICE = Symbol('AUTH_SERVICE');
export const PASSWORD_SERVICE = Symbol('PASSWORD_SERVICE');
export const ACCOUNT_STORE = Symbol('ACCOUNT_STORE');
export const SESSION_STORE = Symbol('SESSION_STORE');
export const REFRESH_TOKEN_STORE = Symbol('REFRESH_TOKEN_STORE');
export const ONE_TIME_CODE_STORE = Symbol('ONE_TIME_CODE_STORE');
export const ACCESS_TOKEN_ISSUER = Symbol('ACCESS_TOKEN_ISSUER');
export const LOGIN_THROTTLE = Symbol('LOGIN_THROTTLE');
export const MAILER = Symbol('MAILER');
export const AUDIT_SINK = Symbol('AUDIT_SINK');
export const CLOCK = Symbol('CLOCK');
export const IDS = Symbol('IDS');
export const PERMISSIONS_FOR = Symbol('PERMISSIONS_FOR');

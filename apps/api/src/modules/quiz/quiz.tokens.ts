/** Injection tokens for the quiz module. */

export const QUIZ_SERVICE = Symbol('QUIZ_SERVICE');
export const QUIZ_STORE = Symbol('QUIZ_STORE');
/** Injected rather than called directly, so a test can grade at a fixed instant. */
export const QUIZ_CLOCK = Symbol('QUIZ_CLOCK');

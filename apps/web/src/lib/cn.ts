import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Composes class names, with later utilities overriding earlier ones.
 *
 * `clsx` alone concatenates, so `className="p-2"` passed to a component that
 * already applies `p-4` produces both classes and the winner depends on stylesheet
 * order. `twMerge` understands the conflict and drops the loser, which is what
 * makes a component's default padding genuinely overridable by its caller.
 */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

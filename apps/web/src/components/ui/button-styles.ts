/**
 * Button styling, in a server-safe module.
 *
 * These are pure functions over class strings: no state, no hooks, no DOM. Keeping
 * them separate from the interactive `Button` component means a server component
 * can render a styled `<Link>` without importing a client module — which would
 * otherwise fail the build ("cannot call a client function from the server") or,
 * worse, pull the whole component into the client bundle for a link.
 */

import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-contrast hover:bg-primary-hover shadow-sm',
  secondary: 'bg-surface text-text border border-border-strong/40 hover:bg-raised shadow-sm',
  ghost: 'bg-transparent text-text hover:bg-raised',
  danger: 'bg-danger text-inverted hover:opacity-90 shadow-sm',
};

/**
 * Every size clears the 44px touch target on its height, and the small size
 * compensates with horizontal padding so it still reads as a comfortable target.
 */
const sizes: Record<ButtonSize, string> = {
  sm: 'h-11 px-md text-small gap-xs',
  md: 'h-11 px-lg text-body gap-xs',
  lg: 'h-12 px-xl text-body gap-sm',
};

/** Shared by the `Button` component and by links that must look like buttons. */
export const buttonClass = (
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  className?: string,
): string =>
  cn(
    'inline-flex items-center justify-center rounded-md font-medium',
    'transition-colors duration-fast ease-standard',
    'disabled:cursor-not-allowed disabled:opacity-50',
    variants[variant],
    sizes[size],
    className,
  );

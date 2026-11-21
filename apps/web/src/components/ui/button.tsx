'use client';

/**
 * Button.
 *
 * One component, four variants, three sizes. `asChild` is intentionally absent:
 * a link that looks like a button is a link, and rendering it as one keeps the
 * semantics (and the middle-click, the "open in new tab", the screen reader
 * announcement) correct. Use `Link` with the shared `buttonClass` for that case.
 *
 * Loading is a first-class state rather than a separate spinner element the caller
 * has to place. It disables the button — which is what prevents a double-submitted
 * form, the most common way a registration endpoint gets hit twice.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { buttonClass, type ButtonSize, type ButtonVariant } from './button-styles';

export { buttonClass, type ButtonSize, type ButtonVariant } from './button-styles';

export type ButtonProps = {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly leadingIcon?: ReactNode;
  readonly fullWidth?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leadingIcon,
    fullWidth,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={buttonClass(variant, size, cn(fullWidth === true && 'w-full', className))}
      disabled={disabled === true || loading}
      // Announce the state change instead of only showing a spinner, which is
      // invisible to a screen reader user.
      aria-busy={loading}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : leadingIcon}
      {children}
    </button>
  );
});

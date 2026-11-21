/**
 * Loading states, in the hierarchy the product uses:
 *
 *   skeleton  — the default. Preserves layout, so nothing jumps when data lands.
 *   spinner   — for an action with no known shape (submitting, mutating).
 *   progress  — for something measurable (uploads, multi-step imports).
 *
 * The order is not aesthetic. A centred spinner on a page that will become a list
 * guarantees a layout shift and a blank rectangle where content should be; a
 * skeleton of the right shape costs the same and reads as "almost there".
 */

import { cn } from '@/lib/cn';

export const Skeleton = ({
  className,
  ...rest
}: { readonly className?: string } & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element => (
  <div
    className={cn('skeleton', className)}
    // Announced once by the container; individual bones would be noise.
    aria-hidden
    {...rest}
  />
);

/** Marks a region as loading for assistive tech, without hiding its shape. */
export const LoadingRegion = ({
  label = 'Loading',
  children,
}: {
  readonly label?: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <div aria-busy="true" aria-live="polite" aria-label={label}>
    {children}
  </div>
);

export const Spinner = ({
  label = 'Loading',
  className,
}: {
  readonly label?: string;
  readonly className?: string;
}): React.JSX.Element => (
  <span role="status" className="inline-flex items-center gap-xs">
    <span
      aria-hidden
      className={cn(
        'size-4 animate-spin rounded-full border-2 border-border border-t-primary',
        className,
      )}
    />
    <span className="sr-only">{label}</span>
  </span>
);

export const ProgressBar = ({
  value,
  label,
}: {
  /** 0–100. Clamped, because a caller's arithmetic should not break the UI. */
  readonly value: number;
  readonly label: string;
}): React.JSX.Element => {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="flex flex-col gap-1">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-border"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-base ease-standard"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
};

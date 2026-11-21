'use client';

/**
 * Theme toggle.
 *
 * The theme is a `data-theme` attribute on `<html>`, not a React state that
 * re-renders components. That means a change repaints via CSS variables with zero
 * component work, and — more importantly — the correct theme is applied by an
 * inline script *before first paint*. Reading `localStorage` inside a component
 * effect would run after paint, producing a white flash for dark-mode users on
 * every navigation.
 *
 * `system` is the default and follows the OS setting live, via a media-query
 * listener. An explicit choice is remembered and wins.
 */

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { cn } from '@/lib/cn';

export type ThemeChoice = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'socialhub.theme';

const OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const prefersDark = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

const applyTheme = (choice: ThemeChoice): void => {
  const resolved = choice === 'system' ? (prefersDark() ? 'dark' : 'light') : choice;
  document.documentElement.dataset['theme'] = resolved;
};

const readStoredChoice = (): ThemeChoice => {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
};

export const ThemeToggle = ({ className }: { readonly className?: string }): React.JSX.Element => {
  const [choice, setChoice] = useState<ThemeChoice>('system');

  // Hydration-safe: the attribute is already set by the inline boot script, so
  // this only syncs React's state to what the DOM says.
  useEffect(() => {
    setChoice(readStoredChoice());
  }, []);

  useEffect(() => {
    if (choice !== 'system') return;

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => applyTheme('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);

  const select = (next: ThemeChoice): void => {
    setChoice(next);
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
  };

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={cn('inline-flex rounded-md border border-border bg-surface p-[2px]', className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => select(value)}
          aria-pressed={choice === value}
          title={label}
          // 44px minimum: a 32px icon button is a miss-tap on a phone.
          className={cn(
            'inline-flex size-11 items-center justify-center rounded-sm transition-colors duration-fast',
            choice === value ? 'bg-primary/10 text-primary' : 'text-muted hover:text-text',
          )}
        >
          <Icon aria-hidden className="size-4" />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
};

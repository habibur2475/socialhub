'use client';

/**
 * The calculator.
 *
 * The keypad and the keyboard dispatch through the same reducer (`applyKey` in the kernel),
 * so the `C` on screen and the `Escape` on the keyboard cannot disagree. Editing the
 * expression by typing into the field is allowed too — it is the same string — which is
 * what makes pasting a sum from a message work.
 */

import { useEffect, useRef, useState } from 'react';
import { Calculator as CalculatorIcon, Delete } from 'lucide-react';

import {
  EMPTY_CALCULATOR,
  applyKey,
  calculate,
  formatNumber,
  normaliseKeys,
  type CalculatorState,
} from '@socialhub/kernel/browser';

import { ToolShell } from '@/components/tools/tool-shell';
import { buttonClass } from '@/components/ui/button-styles';
import { cn } from '@/lib/cn';

const KEYS = [
  ['C', '(', ')', 'DEL'],
  ['7', '8', '9', '/'],
  ['4', '5', '6', '*'],
  ['1', '2', '3', '-'],
  ['0', '.', '%', '+'],
] as const;

const KEY_LABEL: Record<string, string> = {
  DEL: '⌫',
  '*': '×',
  '/': '÷',
  '-': '−',
};

const ERROR_TEXT = {
  DIVISION_BY_ZERO: 'Cannot divide by zero.',
  MALFORMED_EXPRESSION: 'That is not a sum I can read.',
  OVERFLOW: 'That number is too large.',
} as const;

export const CalculatorTool = (): React.JSX.Element => {
  const [state, setState] = useState<CalculatorState>(EMPTY_CALCULATOR);
  const input = useRef<HTMLInputElement>(null);

  const press = (key: string): void => {
    setState((current) => applyKey(current, key));
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      // Typing into the expression field is handled by the field itself; only take the
      // key when focus is elsewhere, or a digit would be entered twice.
      if (target?.tagName === 'INPUT') return;

      if (/^[0-9.+\-*/%()]$/u.test(event.key)) {
        event.preventDefault();
        press(event.key);
        return;
      }
      if (event.key === 'Enter' || event.key === '=') {
        event.preventDefault();
        press('=');
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        press('DEL');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        press('C');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Live preview: the running answer, computed on every keystroke but never shown as the
  // result until `=`. A calculator that only answers on `=` makes you press it to check.
  const live = state.expression.trim() === '' ? null : calculate(state.expression);

  return (
    <ToolShell
      title="Calculator"
      icon={CalculatorIcon}
      description="Four functions, parentheses and a remainder. Arithmetic on the keyboard and on the keypad goes through the same rules, and the running answer updates as you type."
      handling="local"
    >
      <div className="mx-auto flex w-full max-w-[420px] flex-col gap-md">
        <div className="flex flex-col gap-xs rounded-xl border border-border bg-surface p-md">
          <label htmlFor="calculator-expression" className="sr-only">
            Expression
          </label>
          <input
            ref={input}
            id="calculator-expression"
            value={state.expression}
            onChange={(event) =>
              setState({ expression: normaliseKeys(event.target.value), result: null, error: null })
            }
            placeholder="0"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="calculator-result"
            className="w-full bg-transparent text-right font-mono text-h3 outline-none"
          />

          <p
            id="calculator-result"
            aria-live="polite"
            className={cn(
              'text-right font-mono text-h2 font-semibold tabular-nums',
              state.error !== null
                ? 'text-danger'
                : state.result !== null
                  ? 'text-foreground'
                  : 'text-muted',
            )}
          >
            {state.error !== null
              ? ERROR_TEXT[state.error]
              : state.result !== null
                ? formatNumber(state.result)
                : live !== null && live.ok
                  ? formatNumber(live.value)
                  : '0'}
          </p>
        </div>

        <div className="grid grid-cols-4 gap-xs">
          {KEYS.flat().map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => press(key)}
              aria-label={key === 'DEL' ? 'Delete the last character' : key === 'C' ? 'Clear' : key}
              className={cn(
                'flex h-14 items-center justify-center rounded-lg text-body font-medium transition-colors',
                key === 'C' || key === 'DEL'
                  ? 'bg-danger/10 text-danger hover:bg-danger/20'
                  : /[+\-*/%()]/u.test(key)
                    ? 'bg-primary/10 text-primary hover:bg-primary/20'
                    : 'bg-raised hover:bg-border',
              )}
            >
              {key === 'DEL' ? <Delete aria-hidden className="size-4" /> : (KEY_LABEL[key] ?? key)}
            </button>
          ))}

          <button
            type="button"
            onClick={() => press('=')}
            className={cn(buttonClass('primary', 'lg'), 'col-span-4 h-14')}
          >
            =
          </button>
        </div>

        <p className="text-caption text-muted">
          Keyboard: digits and operators work directly, <kbd>Enter</kbd> evaluates,{' '}
          <kbd>Backspace</kbd> deletes, <kbd>Esc</kbd> clears.
        </p>
      </div>
    </ToolShell>
  );
};

/**
 * The calculator's arithmetic.
 *
 * Shunting-yard into Reverse Polish notation, then one evaluation pass. Written out rather
 * than delegated to `eval` or `new Function`: an expression can arrive from a URL or a
 * saved note, and to those two every string is code. This module is imported by the
 * browser, so "it is only our own input" is not a defence.
 *
 * Division is the one place a float is unavoidable. Results are rounded to twelve
 * significant digits so that `0.1 + 0.2` displays `0.3` rather than
 * `0.30000000000000004` — the calculator is a tool for people, not a float inspector.
 */

import { type Result, fail, ok } from '../../result.js';

export type CalculationError =
  | { readonly code: 'DIVISION_BY_ZERO' }
  | { readonly code: 'MALFORMED_EXPRESSION' }
  | { readonly code: 'OVERFLOW' };

const precedence: Readonly<Record<string, number>> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };

const isNumberToken = (token: string): boolean => /^\d/u.test(token);

export const calculate = (expression: string): Result<number, CalculationError> => {
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/%()]/gu);
  if (tokens === null || tokens.join('') !== expression.replace(/\s+/gu, '')) {
    return fail({ code: 'MALFORMED_EXPRESSION' });
  }

  const output: (number | string)[] = [];
  const operators: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';

    if (isNumberToken(token)) {
      output.push(Number(token));
      continue;
    }

    if (token === '(') {
      operators.push(token);
      continue;
    }

    if (token === ')') {
      let open = operators.pop();
      while (open !== undefined && open !== '(') {
        output.push(open);
        open = operators.pop();
      }
      if (open !== '(') return fail({ code: 'MALFORMED_EXPRESSION' });
      continue;
    }

    // A leading `-`, or one after an operator or `(`, is a sign rather than subtraction:
    // `-3 + 1` and `5 * -2` are things people type.
    const previous = tokens[index - 1];
    if (
      token === '-' &&
      (previous === undefined || previous === '(' || precedence[previous] !== undefined)
    ) {
      const next = tokens[index + 1];
      if (next === undefined || !isNumberToken(next)) return fail({ code: 'MALFORMED_EXPRESSION' });
      output.push(-Number(next));
      index += 1;
      continue;
    }

    const own = precedence[token];
    if (own === undefined) return fail({ code: 'MALFORMED_EXPRESSION' });

    let top = operators.at(-1);
    while (top !== undefined && top !== '(' && (precedence[top] ?? 0) >= own) {
      output.push(operators.pop() as string);
      top = operators.at(-1);
    }
    operators.push(token);
  }

  while (operators.length > 0) {
    const operator = operators.pop() as string;
    if (operator === '(') return fail({ code: 'MALFORMED_EXPRESSION' });
    output.push(operator);
  }

  const stack: number[] = [];
  for (const token of output) {
    if (typeof token === 'number') {
      stack.push(token);
      continue;
    }

    const right = stack.pop();
    const left = stack.pop();
    if (left === undefined || right === undefined) return fail({ code: 'MALFORMED_EXPRESSION' });

    switch (token) {
      case '+':
        stack.push(left + right);
        break;
      case '-':
        stack.push(left - right);
        break;
      case '*':
        stack.push(left * right);
        break;
      case '/':
      case '%':
        if (right === 0) return fail({ code: 'DIVISION_BY_ZERO' });
        stack.push(token === '/' ? left / right : left % right);
        break;
      default:
        return fail({ code: 'MALFORMED_EXPRESSION' });
    }
  }

  const result = stack.pop();
  if (result === undefined || stack.length > 0) return fail({ code: 'MALFORMED_EXPRESSION' });
  if (!Number.isFinite(result)) return fail({ code: 'OVERFLOW' });

  return ok(Number(result.toPrecision(12)));
};

/** The display form: grouped thousands, at most `digits` decimals, no trailing zeros. */
export const formatNumber = (value: number, digits = 6): string => {
  if (!Number.isFinite(value)) return '—';
  const fixed = Number(value.toFixed(digits));
  const [whole = '0', fraction] = Math.abs(fixed).toString().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${fixed < 0 ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
};

/**
 * The keypad, in one place.
 *
 * A calculator with a keyboard handler and a button grid usually ends up with the two
 * disagreeing about what `C` does. Both dispatch through `applyKey`, so there is one
 * definition of every key.
 */
export type CalculatorState = {
  /** The expression as typed, with operator glyphs (`×`, `÷`) already normalised. */
  readonly expression: string;
  /** The last computed value, shown until the next key replaces it. */
  readonly result: number | null;
  readonly error: CalculationError['code'] | null;
};

export const EMPTY_CALCULATOR: CalculatorState = { expression: '', result: null, error: null };

const OPERATORS = '+-*/%';

export const applyKey = (state: CalculatorState, key: string): CalculatorState => {
  if (key === 'C') return EMPTY_CALCULATOR;

  if (key === '=') {
    if (state.expression.trim() === '') return state;
    const outcome = calculate(state.expression);
    return outcome.ok
      ? { expression: state.expression, result: outcome.value, error: null }
      : { expression: state.expression, result: null, error: outcome.error.code };
  }

  if (key === 'DEL') {
    const expression = state.expression.slice(0, -1);
    return { expression, result: null, error: null };
  }

  // A digit typed after `=` starts a new sum; an operator continues from the answer. That
  // is the behaviour of every desk calculator, and the one people do not have to learn.
  let base = state.expression;
  if (state.result !== null) base = OPERATORS.includes(key) ? formatNumber(state.result) : '';

  if (key === '.') {
    // One decimal point per number: find the digits of the number being typed and refuse a
    // second point in it.
    const current = /\d*\.?\d*$/u.exec(base)?.[0] ?? '';
    if (current.includes('.')) return state;
    const expression = `${base}${current === '' ? '0.' : '.'}`;
    return { expression, result: null, error: null };
  }

  const lastCharacter = base.at(-1) ?? '';
  if (OPERATORS.includes(key) && OPERATORS.includes(lastCharacter)) {
    // Replace the trailing operator instead of stacking two: `+ *` is never what was meant.
    return { expression: `${base.slice(0, -1)}${key}`, result: null, error: null };
  }

  return { expression: `${base}${key}`, result: null, error: null };
};

/** Normalises the glyphs a phone keypad or a copied expression may contain. */
export const normaliseKeys = (input: string): string =>
  input.replace(/×/gu, '*').replace(/÷/gu, '/').replace(/−/gu, '-');

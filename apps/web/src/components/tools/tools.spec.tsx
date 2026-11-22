/**
 * Tools UI.
 *
 * What is worth asserting in a component test here is behaviour the kernel tests cannot
 * see: that the age calculator shows the answer it computed, that a bad amount is refused
 * with a sentence rather than a silent no-op, and that the calculator's keypad and field
 * stay one expression.
 *
 * The PDF and QR surfaces depend on canvas and on a dynamic import of `pdf-lib`; those are
 * covered by the kernel's planning tests and by the live check, not by jsdom, which has no
 * canvas to draw on.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { AgeCalculatorTool } from './age-calculator/age-calculator';
import { CalculatorTool } from './calculator/calculator';
import { TOOLS } from './tool-catalogue';

afterEach(cleanup);

describe('the catalogue', () => {
  it('lists every tool with its folder and a route named after it', () => {
    expect(TOOLS.map((tool) => tool.folder)).toEqual([
      'pdf-editor',
      'qr-code',
      'notes',
      'calculator',
      'age-calculator',
      'budget',
      'period',
    ]);

    for (const tool of TOOLS) {
      expect(tool.href).toBe(`/tools/${tool.folder}`);
    }
  });

  /** The one tool that needs a server says so; the rest promise they do not. */
  it('marks only notes as account-backed', () => {
    expect(TOOLS.filter((tool) => tool.storage === 'account').map((tool) => tool.folder)).toEqual([
      'notes',
    ]);
  });
});

describe('the age calculator', () => {
  it('shows the exact age and the next birthday for a set of dates', () => {
    render(<AgeCalculatorTool />);

    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1990-11-21' } });
    fireEvent.change(screen.getByLabelText('Age on'), { target: { value: '2026-11-21' } });

    expect(screen.getByText('36')).toBeTruthy();
    expect(screen.getByText(/turns 36 on 2026-11-21/)).toBeTruthy();
    expect(screen.getByText('Today.')).toBeTruthy();
  });

  it('refuses a birthday in the future with a sentence, not a silent zero', () => {
    render(<AgeCalculatorTool />);

    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2030-01-01' } });
    fireEvent.change(screen.getByLabelText('Age on'), { target: { value: '2026-11-21' } });

    expect(screen.getByRole('alert').textContent).toContain('has not happened yet');
  });

  it('warns about an implausible year rather than reporting a 1000-year-old', () => {
    render(<AgeCalculatorTool />);

    fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '1026-01-01' } });
    fireEvent.change(screen.getByLabelText('Age on'), { target: { value: '2026-11-21' } });

    expect(screen.getByRole('alert').textContent).toContain('check the year');
  });
});

describe('the calculator', () => {
  it('evaluates from the keypad and shows the result', () => {
    const { container } = render(<CalculatorTool />);

    for (const key of ['1', '2', '+', '3']) {
      fireEvent.click(screen.getByRole('button', { name: key }));
    }
    // The running answer is shown before `=`, so a mistyped sum is caught early.
    expect(screen.getByText('15')).toBeTruthy();

    const expression = container.querySelector<HTMLInputElement>('#calculator-expression');
    expect(expression?.value).toBe('12+3');
  });

  it('replaces the expression when a digit follows a result but extends it for an operator', () => {
    const { container } = render(<CalculatorTool />);

    for (const key of ['2', '+', '2']) fireEvent.click(screen.getByRole('button', { name: key }));
    fireEvent.click(screen.getByRole('button', { name: '=' }));

    const expression = container.querySelector<HTMLInputElement>('#calculator-expression');

    fireEvent.click(screen.getByRole('button', { name: '7' }));
    expect(expression?.value).toBe('7');

    fireEvent.click(screen.getByRole('button', { name: '=' }));
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    fireEvent.click(screen.getByRole('button', { name: '+' }));
    expect(expression?.value).toBe('3+');
  });

  it('shows division by zero as a sentence rather than Infinity', () => {
    render(<CalculatorTool />);

    fireEvent.change(screen.getByLabelText('Expression'), { target: { value: '1/0' } });
    fireEvent.click(screen.getByRole('button', { name: '=' }));

    expect(screen.getByText('Cannot divide by zero.')).toBeTruthy();
  });
});

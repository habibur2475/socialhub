import { describe, expect, it } from 'vitest';

import {
  PDF_MAX_PAGES,
  applyOperation,
  describeSelection,
  exportFileName,
  identityPlan,
} from './pdf.js';

const pages = (count: number) => identityPlan(count);

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
  return result.value;
};

describe('the page plan', () => {
  it('starts as an identity plan', () => {
    expect(pages(3).map((page) => page.source)).toEqual([0, 1, 2]);
  });

  it('reorders without changing the sources', () => {
    expect(
      unwrap(applyOperation(pages(3), { kind: 'REORDER', order: [2, 0, 1] })).map(
        (page) => page.source,
      ),
    ).toEqual([2, 0, 1]);
  });

  it('refuses an order that drops, repeats or invents a page', () => {
    expect(applyOperation(pages(3), { kind: 'REORDER', order: [0, 1] })).toEqual({
      ok: false,
      error: { code: 'ORDER_MUST_KEEP_EVERY_PAGE' },
    });
    expect(applyOperation(pages(3), { kind: 'REORDER', order: [0, 1, 1] })).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_PAGE_IN_ORDER', page: 1 },
    });
    expect(applyOperation(pages(3), { kind: 'REORDER', order: [0, 1, 5] })).toEqual({
      ok: false,
      error: { code: 'PAGE_OUT_OF_RANGE', page: 5 },
    });
  });

  it('rotates one page at a time and wraps at 360', () => {
    let plan = unwrap(applyOperation(pages(2), { kind: 'ROTATE', page: 1, by: 90 }));
    expect(plan[1]?.rotation).toBe(90);
    plan = unwrap(applyOperation(plan, { kind: 'ROTATE', page: 1, by: 270 }));
    expect(plan[1]?.rotation).toBe(0);
    expect(plan[0]?.rotation).toBe(0);
  });

  it('deletes a page but refuses to empty the document', () => {
    expect(
      unwrap(applyOperation(pages(3), { kind: 'DELETE', page: 1 })).map((page) => page.source),
    ).toEqual([0, 2]);
    expect(applyOperation(pages(1), { kind: 'DELETE', page: 0 })).toEqual({
      ok: false,
      error: { code: 'NO_PAGES' },
    });
  });

  it('duplicates a page in place', () => {
    expect(
      unwrap(applyOperation(pages(2), { kind: 'DUPLICATE', page: 0 })).map((page) => page.source),
    ).toEqual([0, 0, 1]);
  });

  it('appends merged pages after the highest source rather than restarting at zero', () => {
    const merged = unwrap(applyOperation([...pages(2)], { kind: 'MERGE', append: 2 }));
    expect(merged.map((page) => page.source)).toEqual([0, 1, 2, 3]);
  });

  it('refuses an empty merge and one past the page ceiling', () => {
    expect(applyOperation(pages(2), { kind: 'MERGE', append: 0 })).toEqual({
      ok: false,
      error: { code: 'NOTHING_TO_MERGE' },
    });
    expect(applyOperation(pages(2), { kind: 'MERGE', append: PDF_MAX_PAGES })).toEqual({
      ok: false,
      error: { code: 'TOO_MANY_PAGES', count: PDF_MAX_PAGES + 2 },
    });
  });

  it('refuses a page index outside the document, on every operation', () => {
    for (const operation of [
      { kind: 'ROTATE', page: 9, by: 90 },
      { kind: 'DELETE', page: 9 },
      { kind: 'DUPLICATE', page: -1 },
    ] as const) {
      expect(applyOperation(pages(2), operation).ok).toBe(false);
    }
  });
});

describe('export details', () => {
  it('derives a filename from the original', () => {
    expect(exportFileName('Scan.pdf', 3)).toBe('Scan-3-pages.pdf');
    expect(exportFileName('re:port.pdf', 1)).toBe('re-port-1-pages.pdf');
    expect(exportFileName('', 2)).toBe('document-2-pages.pdf');
  });

  it('describes a selection as the ranges a person would say out loud', () => {
    expect(describeSelection([])).toBe('no pages');
    expect(describeSelection([1])).toBe('page 2');
    expect(describeSelection([1, 2, 3, 6])).toBe('pages 2–4, 7');
  });
});

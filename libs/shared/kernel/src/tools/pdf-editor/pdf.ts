/**
 * PDF page operations.
 *
 * The editor is page-level on purpose: reorder, rotate, delete, merge and split. Those are
 * the five things people actually need from "edit a PDF" at a kitchen table, and each of
 * them is a manipulation of page indices — which is why the planning happens here, in a
 * pure function that a test can check, rather than inside a canvas callback.
 *
 * What this file does **not** do: draw text on a page, redact, or sign. A tool that claims
 * to redact an image-only PDF and does not is a tool that publishes someone's ID number, so
 * the absence is stated rather than faked.
 */

import { type Result, fail, ok } from '../../result.js';

/** Every page carries its own rotation; a rotated scan is a real thing. */
export type PageRotation = 0 | 90 | 180 | 270;

export type PagePlan = {
  /** Index in the source document. */
  readonly source: number;
  readonly rotation: PageRotation;
};

export type PdfOperation =
  | { readonly kind: 'REORDER'; readonly order: readonly number[] }
  | { readonly kind: 'ROTATE'; readonly page: number; readonly by: 90 | 180 | 270 }
  | { readonly kind: 'DELETE'; readonly page: number }
  | { readonly kind: 'DUPLICATE'; readonly page: number }
  | { readonly kind: 'MERGE'; readonly append: number };

export type PdfRefusal =
  | { readonly code: 'NO_PAGES' }
  | { readonly code: 'PAGE_OUT_OF_RANGE'; readonly page: number }
  | { readonly code: 'DUPLICATE_PAGE_IN_ORDER'; readonly page: number }
  | { readonly code: 'ORDER_MUST_KEEP_EVERY_PAGE' }
  | { readonly code: 'NOTHING_TO_MERGE' }
  | { readonly code: 'TOO_MANY_PAGES'; readonly count: number };

/** A browser has to hold every page in memory while it renders; 500 is already generous. */
export const PDF_MAX_PAGES = 500;

export const identityPlan = (pageCount: number): readonly PagePlan[] =>
  Array.from({ length: pageCount }, (_, index) => ({ source: index, rotation: 0 }));

const normaliseRotation = (rotation: number): PageRotation => {
  const wrapped = ((rotation % 360) + 360) % 360;
  return wrapped === 90 || wrapped === 180 || wrapped === 270 ? wrapped : 0;
};

/**
 * Applies one edit to the plan.
 *
 * The plan is the document: `source` says which page of the *original* file to draw, so
 * reordering, duplicating and deleting are all the same operation on an array. Nothing is
 * re-encoded until the export, which is why an edit is instant and undoable.
 */
export const applyOperation = (
  plan: readonly PagePlan[],
  operation: PdfOperation,
): Result<readonly PagePlan[], PdfRefusal> => {
  const guard = (page: number): PdfRefusal | null => {
    if (!Number.isInteger(page) || page < 0 || page >= plan.length) {
      return { code: 'PAGE_OUT_OF_RANGE', page };
    }
    return null;
  };

  switch (operation.kind) {
    case 'REORDER': {
      const order = operation.order;
      if (order.length !== plan.length) return fail({ code: 'ORDER_MUST_KEEP_EVERY_PAGE' });
      const seen = new Set<number>();
      for (const index of order) {
        if (!Number.isInteger(index) || index < 0 || index >= plan.length) {
          return fail({ code: 'PAGE_OUT_OF_RANGE', page: index });
        }
        if (seen.has(index)) return fail({ code: 'DUPLICATE_PAGE_IN_ORDER', page: index });
        seen.add(index);
      }
      return ok(order.map((index) => plan[index] as PagePlan));
    }

    case 'ROTATE': {
      const refusal = guard(operation.page);
      if (refusal !== null) return fail(refusal);
      return ok(
        plan.map((page, index) =>
          index === operation.page
            ? { ...page, rotation: normaliseRotation(page.rotation + operation.by) }
            : page,
        ),
      );
    }

    case 'DELETE': {
      const refusal = guard(operation.page);
      if (refusal !== null) return fail(refusal);
      if (plan.length === 1) return fail({ code: 'NO_PAGES' });
      return ok(plan.filter((_, index) => index !== operation.page));
    }

    case 'DUPLICATE': {
      const refusal = guard(operation.page);
      if (refusal !== null) return fail(refusal);
      if (plan.length >= PDF_MAX_PAGES)
        return fail({ code: 'TOO_MANY_PAGES', count: plan.length + 1 });
      const page = plan[operation.page] as PagePlan;
      return ok([
        ...plan.slice(0, operation.page + 1),
        { ...page },
        ...plan.slice(operation.page + 1),
      ]);
    }

    case 'MERGE': {
      if (!Number.isInteger(operation.append) || operation.append <= 0) {
        return fail({ code: 'NOTHING_TO_MERGE' });
      }
      if (plan.length + operation.append > PDF_MAX_PAGES) {
        return fail({ code: 'TOO_MANY_PAGES', count: plan.length + operation.append });
      }
      // Appended pages continue numbering after the existing sources, so a second merge
      // does not silently redraw page 1 of the second file twice.
      const offset = plan.reduce((highest, page) => Math.max(highest, page.source + 1), 0);
      const appended = Array.from({ length: operation.append }, (_, index) => ({
        source: offset + index,
        rotation: 0 as PageRotation,
      }));
      return ok([...plan, ...appended]);
    }
  }
};

/** "page-3-of-12.pdf" — the filename an export should have, derived rather than typed. */
export const exportFileName = (originalName: string, pageCount: number): string => {
  const stem = originalName.replace(/\.pdf$/iu, '').replace(/[\\/:*?"<>|]/gu, '-') || 'document';
  return `${stem}-${pageCount}-pages.pdf`;
};

/** Human range of what is selected, e.g. "pages 2–4, 7" — used by the bulk actions. */
export const describeSelection = (pages: readonly number[]): string => {
  if (pages.length === 0) return 'no pages';
  const sorted = [...new Set(pages)].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = sorted[0] as number;
  let previous = start;

  for (let index = 1; index <= sorted.length; index += 1) {
    const current = sorted[index];
    if (current !== undefined && current === previous + 1) {
      previous = current;
      continue;
    }
    parts.push(start === previous ? `${start + 1}` : `${start + 1}–${previous + 1}`);
    if (current !== undefined) {
      start = current;
      previous = current;
    }
  }

  return `page${sorted.length === 1 ? '' : 's'} ${parts.join(', ')}`;
};

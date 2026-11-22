'use client';

/**
 * The PDF editor.
 *
 * Rendering a page needs `pdf.js`; **editing** needs none of it. The plan — which page of the
 * original goes where, and how it is rotated — is computed by the kernel and drawn as page
 * cards, so reordering, rotating, deleting and duplicating are instant and undoable before a
 * single byte is re-encoded.
 *
 * `pdf-lib` is loaded with a dynamic `import()` at export time and only then. A visitor who
 * opens the editor to look at a file should not download a PDF writer, and the bundle budget
 * is a hard gate rather than an aspiration — the library is several hundred kilobytes that
 * only the export needs.
 *
 * What the panel deliberately does not promise: text editing and redaction. Both would have
 * to be honest about an image-only scan, and a tool that claims to redact and draws a black
 * box over a still-searchable word is worse than one that says it cannot.
 */

import { useCallback, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CopyPlus,
  Download,
  FileWarning,
  Loader2,
  RotateCw,
  Trash2,
  Upload,
} from 'lucide-react';

import {
  type PagePlan,
  type PdfRefusal,
  applyOperation,
  describeSelection,
  exportFileName,
  identityPlan,
} from '@socialhub/kernel/browser';

import { buttonClass } from '@/components/ui/button-styles';
import { ToolShell } from '@/components/tools/tool-shell';
import { cn } from '@/lib/cn';

/** Mirrors `PDF_MAX_PAGES` in the kernel; the reader stops early rather than after the OOM. */
const MAX_PAGES = 500;

const refusalText = (refusal: PdfRefusal): string => {
  switch (refusal.code) {
    case 'NO_PAGES':
      return 'A document needs at least one page.';
    case 'PAGE_OUT_OF_RANGE':
      return `There is no page ${refusal.page + 1}.`;
    case 'DUPLICATE_PAGE_IN_ORDER':
      return `Page ${refusal.page + 1} appears twice in that order.`;
    case 'ORDER_MUST_KEEP_EVERY_PAGE':
      return 'That order drops a page.';
    case 'NOTHING_TO_MERGE':
      return 'The second file has no pages.';
    case 'TOO_MANY_PAGES':
      return `That would be ${refusal.count} pages; the limit is ${MAX_PAGES}.`;
  }
};

type Loaded = {
  readonly name: string;
  readonly bytes: ArrayBuffer;
  readonly plan: readonly PagePlan[];
};

export const PdfEditor = (): React.JSX.Element => {
  const [document, setDocument] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Undo is a stack of plans, not a re-parse: an edit is an array copy, so this is cheap.
  const [history, setHistory] = useState<readonly (readonly PagePlan[])[]>([]);
  const mergeInput = useRef<HTMLInputElement>(null);

  const readPageCount = async (bytes: ArrayBuffer): Promise<number> => {
    const { PDFDocument } = await import('pdf-lib');
    const parsed = await PDFDocument.load(bytes, { updateMetadata: false });
    return parsed.getPageCount();
  };

  const open = useCallback(async (file: File): Promise<void> => {
    setError(null);
    setBusy(true);

    try {
      if (!/\.pdf$/iu.test(file.name) && file.type !== 'application/pdf') {
        throw new Error('That is not a PDF. Choose a file ending in .pdf.');
      }
      if (file.size > 40 * 1024 * 1024) {
        throw new Error('That file is over 40 MB. A browser has to hold all of it in memory.');
      }

      const bytes = await file.arrayBuffer();
      const pageCount = await readPageCount(bytes);
      if (pageCount === 0) throw new Error('That PDF has no pages.');
      if (pageCount > MAX_PAGES)
        throw new Error(`That PDF has ${pageCount} pages; the limit is ${MAX_PAGES}.`);

      setDocument({ name: file.name, bytes, plan: identityPlan(pageCount) });
      setHistory([]);
      setSelected(null);
    } catch (cause) {
      // A corrupt file is the common case here and it throws from inside pdf-lib with a
      // stack trace; the useful sentence is the one above it.
      setError(cause instanceof Error ? cause.message : 'That file could not be read.');
      setDocument(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const edit = (operation: Parameters<typeof applyOperation>[1]): void => {
    if (document === null) return;
    const outcome = applyOperation(document.plan, operation);
    if (!outcome.ok) {
      setError(refusalText(outcome.error));
      return;
    }

    setError(null);
    setHistory((stack) => [...stack.slice(-19), document.plan]);
    setDocument({ ...document, plan: outcome.value });
    setSelected((current) =>
      current === null ? null : Math.min(current, outcome.value.length - 1),
    );
  };

  const undo = (): void => {
    const previous = history.at(-1);
    if (document === null || previous === undefined) return;
    setHistory((stack) => stack.slice(0, -1));
    setDocument({ ...document, plan: previous });
  };

  const merge = async (file: File): Promise<void> => {
    setError(null);
    setBusy(true);

    try {
      const pageCount = await readPageCount(await file.arrayBuffer());
      edit({ kind: 'MERGE', append: pageCount });
    } catch {
      setError('That second file could not be read.');
    } finally {
      setBusy(false);
      if (mergeInput.current !== null) mergeInput.current.value = '';
    }
  };

  const exportPdf = async (): Promise<void> => {
    if (document === null) return;
    setBusy(true);
    setError(null);

    try {
      const { PDFDocument, degrees } = await import('pdf-lib');
      const source = await PDFDocument.load(document.bytes, { updateMetadata: false });
      const output = await PDFDocument.create();

      for (const page of document.plan) {
        const [copied] = await output.copyPages(source, [page.source]);
        if (copied !== undefined) {
          if (page.rotation !== 0) {
            copied.setRotation(degrees((copied.getRotation().angle + page.rotation) % 360));
          }
          output.addPage(copied);
        }
      }

      const bytes = await output.save();
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = exportFileName(document.name, document.plan.length);
      anchor.click();
      // Revoking immediately can cancel the download in some browsers; one frame is enough.
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setError('The export failed. The file may be encrypted or damaged.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ToolShell
      title="PDF editor"
      icon={FileWarning}
      description="Reorder, rotate, delete, duplicate and merge pages. Text is not edited and pages are not redacted — for those, a page-level tool would be a promise it cannot keep."
      handling="local"
    >
      {document === null ? (
        <label
          className={cn(
            'flex min-h-[260px] cursor-pointer flex-col items-center justify-center gap-sm',
            'rounded-xl border-2 border-dashed border-border-strong/40 p-lg text-center',
            'transition-colors hover:border-primary/50 hover:bg-primary/5',
          )}
        >
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void open(file);
            }}
          />
          {busy ? (
            <Loader2 aria-hidden className="size-6 animate-spin text-muted" />
          ) : (
            <Upload aria-hidden className="size-6 text-muted" />
          )}
          <span className="text-body font-medium">
            {busy ? 'Reading the file…' : 'Choose a PDF'}
          </span>
          <span className="text-small text-muted">
            Up to 40 MB and 500 pages. Nothing is uploaded.
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-md">
          <div className="flex flex-wrap items-center gap-sm rounded-lg border border-border p-sm">
            <span className="min-w-0 flex-1 truncate text-small font-medium">{document.name}</span>
            <span className="text-caption text-muted">
              {document.plan.length} page{document.plan.length === 1 ? '' : 's'} ·{' '}
              {describeSelection(document.plan.map((_, index) => index))}
            </span>

            <button
              type="button"
              onClick={undo}
              disabled={history.length === 0}
              className={buttonClass('ghost', 'sm')}
            >
              Undo
            </button>
            <button
              type="button"
              onClick={() => void exportPdf()}
              disabled={busy}
              className={buttonClass('primary', 'sm')}
            >
              {busy ? (
                <Loader2 aria-hidden className="size-4 animate-spin" />
              ) : (
                <Download aria-hidden className="size-4" />
              )}
              Download
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-xs">
            <button
              type="button"
              onClick={() => mergeInput.current?.click()}
              disabled={busy}
              className={buttonClass('secondary', 'sm')}
            >
              <CopyPlus aria-hidden className="size-4" />
              Merge another PDF
            </button>
            <input
              ref={mergeInput}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file !== undefined) void merge(file);
              }}
            />
            <button
              type="button"
              onClick={() => {
                setDocument(null);
                setError(null);
                setHistory([]);
              }}
              className={buttonClass('ghost', 'sm')}
            >
              Close
            </button>
          </div>

          {error === null ? null : (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger/10 px-sm py-xs text-small text-danger"
            >
              {error}
            </p>
          )}

          <ol className="grid grid-cols-2 gap-sm sm:grid-cols-3 md:grid-cols-4">
            {document.plan.map((page, index) => (
              <li
                key={`${index}-${page.source}`}
                className={cn(
                  'flex flex-col gap-xs rounded-lg border p-xs transition-colors',
                  selected === index ? 'border-primary bg-primary/5' : 'border-border',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelected(selected === index ? null : index)}
                  aria-pressed={selected === index}
                  aria-label={`Page ${index + 1}${page.source === index ? '' : `, from page ${page.source + 1}`}`}
                  className="flex aspect-[1/1.414] w-full items-center justify-center rounded-md bg-raised"
                >
                  <span
                    className="text-h3 font-semibold text-muted"
                    style={{ transform: `rotate(${page.rotation}deg)` }}
                  >
                    {index + 1}
                  </span>
                </button>

                <div className="flex items-center justify-between gap-[2px]">
                  <span className="text-caption text-muted">
                    p{index + 1}
                    {page.source === index ? '' : ` ← ${page.source + 1}`}
                  </span>
                  <span className="flex gap-[2px]">
                    <button
                      type="button"
                      aria-label={`Move page ${index + 1} earlier`}
                      disabled={index === 0}
                      onClick={() =>
                        edit({
                          kind: 'REORDER',
                          order: document.plan.map((_, position) =>
                            position === index - 1
                              ? index
                              : position === index
                                ? index - 1
                                : position,
                          ),
                        })
                      }
                      className="rounded-sm p-[4px] text-muted transition-colors hover:bg-raised disabled:opacity-30"
                    >
                      <ArrowUp aria-hidden className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move page ${index + 1} later`}
                      disabled={index === document.plan.length - 1}
                      onClick={() =>
                        edit({
                          kind: 'REORDER',
                          order: document.plan.map((_, position) =>
                            position === index + 1
                              ? index
                              : position === index
                                ? index + 1
                                : position,
                          ),
                        })
                      }
                      className="rounded-sm p-[4px] text-muted transition-colors hover:bg-raised disabled:opacity-30"
                    >
                      <ArrowDown aria-hidden className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Rotate page ${index + 1}`}
                      onClick={() => edit({ kind: 'ROTATE', page: index, by: 90 })}
                      className="rounded-sm p-[4px] text-muted transition-colors hover:bg-raised"
                    >
                      <RotateCw aria-hidden className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Duplicate page ${index + 1}`}
                      onClick={() => edit({ kind: 'DUPLICATE', page: index })}
                      className="rounded-sm p-[4px] text-muted transition-colors hover:bg-raised"
                    >
                      <CopyPlus aria-hidden className="size-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete page ${index + 1}`}
                      disabled={document.plan.length === 1}
                      onClick={() => edit({ kind: 'DELETE', page: index })}
                      className="rounded-sm p-[4px] text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
                    >
                      <Trash2 aria-hidden className="size-3" />
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {document === null && error !== null ? (
        <p
          role="alert"
          className="mt-sm rounded-md border border-danger/30 bg-danger/10 px-sm py-xs text-small text-danger"
        >
          {error}
        </p>
      ) : null}
    </ToolShell>
  );
};

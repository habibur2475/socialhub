'use client';

/**
 * Markdown rendering for an article body.
 *
 * Why a hand-written renderer rather than a library: the subset an article needs is
 * headings, paragraphs, lists, quotes, fenced code and inline emphasis, and a full
 * Markdown parser plus a sanitiser is ~40 kB of the 250 kB route budget for those six
 * things.
 *
 * Why it is safe without a sanitiser: this component never produces HTML. Every branch
 * returns React elements built from *text*, so a body containing `<script>` renders the
 * literal characters. That is the whole defence, and it is why the rules below are a
 * small fixed set rather than "anything that looks like Markdown".
 *
 * What it deliberately does not support: raw HTML, links and images. A link in an
 * article is a place where a phishing page gets to borrow this origin's credibility, and
 * that deserves a real preview-and-allowlist implementation rather than an `<a>` tag.
 */

import type { ReactNode } from 'react';

/** Inline emphasis: `**bold**`, `*italic*` and `` `code` ``, in that order of certainty. */
const renderInline = (text: string, keyPrefix: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  // One pass over the three markers, preferring the longest first so `**` is not read as
  // two italics. Escaped markers are not supported: prose about Markdown is rare, and a
  // backslash rule doubles the parser for it.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/gu;
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));

    const token = match[0];
    const key = `${keyPrefix}-i${index}`;

    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={key} className="rounded-sm bg-raised px-[4px] py-[1px] text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }

    cursor = start + token.length;
    index += 1;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
};

type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'code'; readonly text: string };

/**
 * Splits a body into blocks.
 *
 * A blank line ends a paragraph, a fence swallows everything to its closing line, and a
 * list continues until a line that is not an item. Anything unrecognised is a paragraph:
 * a body is prose first, and an unknown construct rendered as text is better than one
 * rendered as nothing.
 */
export const parseArticle = (body: string): readonly Block[] => {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (line.startsWith('```')) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' });
      continue;
    }

    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote !== null) {
      flushParagraph();
      blocks.push({ kind: 'quote', text: quote[1] ?? '' });
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    const unordered = /^\s*[-*+]\s+(.*)$/u.exec(line);
    if (ordered !== null || unordered !== null) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: string[] = [];
      let current = ordered?.[1] ?? unordered?.[1] ?? '';
      items.push(current);

      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        const nextItem = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/u.exec(next);
        if (nextItem === null) break;
        current = nextItem[1] ?? '';
        items.push(current);
        index += 1;
      }

      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
};

const HEADING_CLASS: Readonly<Record<number, string>> = {
  1: 'text-subheading font-semibold',
  2: 'text-body font-semibold',
  3: 'text-body font-semibold',
};

export const ArticleBody = ({ body }: { readonly body: string }): React.JSX.Element => {
  const blocks = parseArticle(body);

  return (
    <div className="flex flex-col gap-sm text-body leading-relaxed">
      {blocks.map((block, index) => {
        const key = `b-${index}`;

        switch (block.kind) {
          case 'heading': {
            const content = renderInline(block.text, key);
            return block.level === 1 ? (
              <h2 key={key} className={HEADING_CLASS[1]}>
                {content}
              </h2>
            ) : block.level === 2 ? (
              <h3 key={key} className={HEADING_CLASS[2]}>
                {content}
              </h3>
            ) : (
              <h4 key={key} className={HEADING_CLASS[3]}>
                {content}
              </h4>
            );
          }

          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-lg bg-raised p-sm text-caption leading-normal"
              >
                <code>{block.text}</code>
              </pre>
            );

          case 'quote':
            return (
              <blockquote key={key} className="border-l-2 border-primary/40 pl-sm text-muted">
                {renderInline(block.text, key)}
              </blockquote>
            );

          case 'list':
            return block.ordered ? (
              <ol key={key} className="flex list-decimal flex-col gap-xs pl-lg">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key} className="flex list-disc flex-col gap-xs pl-lg">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );

          case 'paragraph':
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
};

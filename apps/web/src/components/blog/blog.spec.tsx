/**
 * Article rendering.
 *
 * The parser is the surface where an article body meets the DOM, so the properties here
 * are the ones that matter for safety and structure: nothing in a body becomes HTML, a
 * fence swallows its contents literally, and the block split is what the component renders.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ArticleBody, parseArticle } from './article-body';

afterEach(cleanup);

describe('parseArticle', () => {
  it('splits paragraphs on blank lines and joins their lines with a space', () => {
    const blocks = parseArticle('First line\nsecond line.\n\nAnother paragraph.');
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'First line second line.' },
      { kind: 'paragraph', text: 'Another paragraph.' },
    ]);
  });

  it('reads headings by level', () => {
    expect(parseArticle('# One\n## Two\n### Three')).toEqual([
      { kind: 'heading', level: 1, text: 'One' },
      { kind: 'heading', level: 2, text: 'Two' },
      { kind: 'heading', level: 3, text: 'Three' },
    ]);
  });

  it('groups an unordered list and an ordered one separately', () => {
    const blocks = parseArticle('- one\n- two\n\n1. first\n2. second');
    expect(blocks).toEqual([
      { kind: 'list', ordered: false, items: ['one', 'two'] },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
    ]);
  });

  it('keeps a quote and a fenced block intact', () => {
    const blocks = parseArticle('> quoted\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```');
    expect(blocks).toEqual([
      { kind: 'quote', text: 'quoted' },
      // The blank line inside the fence survives: it is code, not paragraph spacing.
      { kind: 'code', text: 'const a = 1;\n\nconst b = 2;' },
    ]);
  });

  it('treats an unclosed fence as code to the end rather than swallowing the page', () => {
    expect(parseArticle('```\nunclosed')).toEqual([{ kind: 'code', text: 'unclosed' }]);
  });

  it('renders an unrecognised construct as a paragraph', () => {
    expect(parseArticle('| a | b |')).toEqual([{ kind: 'paragraph', text: '| a | b |' }]);
  });
});

describe('ArticleBody', () => {
  it('never turns a body into HTML', () => {
    render(<ArticleBody body={'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'} />);

    // If any of this had been parsed as HTML, there would be a script or an img element.
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
  });

  it('renders emphasis and inline code as elements, not markers', () => {
    const { container } = render(<ArticleBody body={'A **bold** word and `code` here.'} />);

    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.textContent).not.toContain('**');
  });

  it('does not treat a link as a link', () => {
    render(<ArticleBody body={'See https://example.com for more.'} />);
    // Deliberate: an unfiltered link in user prose borrows this origin's credibility.
    expect(document.querySelector('a')).toBeNull();
  });

  it('renders a heading at the right level', () => {
    const { container } = render(<ArticleBody body={'## A section'} />);
    expect(container.querySelector('h3')?.textContent).toBe('A section');
  });

  it('keeps a code block verbatim', () => {
    const { container } = render(<ArticleBody body={'```\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1;');
  });
});

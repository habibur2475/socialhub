/**
 * Prettier configuration.
 *
 * Plain JavaScript: this file is read by Node before any transpilation, so a
 * TypeScript annotation here would fail with a syntax error rather than a
 * formatting message.
 *
 * @type {import('prettier').Config}
 */
const config = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  quoteProps: 'as-needed',
  trailingComma: 'all',
  bracketSpacing: true,
  arrowParens: 'always',
  endOfLine: 'lf',
  overrides: [
    { files: ['*.json', '*.jsonc'], options: { singleQuote: false, trailingComma: 'none' } },
    { files: ['*.md'], options: { proseWrap: 'preserve' } },
    { files: ['*.yml', '*.yaml'], options: { singleQuote: true } },
  ],
};

export default config;

import type { Config } from 'prettier';

const config: Config = {
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
    { files: ['*.json', '*.jsonc'], options: { singleQuote: false } },
    { files: ['*.md'], options: { proseWrap: 'preserve' } },
  ],
};

export default config;

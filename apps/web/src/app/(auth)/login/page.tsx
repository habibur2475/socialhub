import type { Metadata } from 'next';

import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your SocialHub account.',
  // An authentication page must never be indexed: a search result linking to a
  // login screen is a dead end for the visitor and a phishing template for anyone
  // who imitates the URL.
  robots: { index: false, follow: false },
};

/**
 * Server component that reads the query string and hands it to the form.
 *
 * The alternative — `useSearchParams` in a client component — forces a Suspense
 * boundary, which means the form is *not* in the initial HTML and the browser
 * paints a skeleton first. On a page where the form is the entire content, that
 * is a visible delay for no benefit. Reading the params here keeps the markup
 * complete on first paint.
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;

  const notice = first(params['notice']);
  const next = first(params['next']);

  return <LoginForm notice={notice} next={next} />;
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

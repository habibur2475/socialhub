/**
 * Marketing homepage.
 *
 * Static by default. There is no data dependency here, so no client component,
 * no hydration cost, and the whole page is prerendered at build time — it is the
 * first thing an unauthenticated visitor sees, and it must arrive fast on a slow
 * connection.
 *
 * Structure is the one the brief asked for: hero, features, about, contact. Each
 * section is a landmark with its own heading, so a screen reader user can jump
 * between them with the heading shortcut instead of tabbing through every link.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import {
  Briefcase,
  GraduationCap,
  MessagesSquare,
  Newspaper,
  ShoppingBag,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react';

import { buttonClass } from '@/components/ui/button-styles';
import { NAV_ITEMS } from '@/components/layout/navigation';

import { HomeRedirect } from './home-redirect';

export const metadata: Metadata = {
  title: 'One platform for everything social',
  description:
    'Social, messaging, learning, marketplace, and work. One account, one identity, built to scale.',
};

const FEATURES = [
  {
    icon: Users,
    title: 'Social',
    body: 'Profiles, follows, and a feed that respects your attention.',
  },
  {
    icon: MessagesSquare,
    title: 'Messages',
    body: 'Real-time conversations that stay in sync across devices.',
  },
  {
    icon: GraduationCap,
    title: 'Quiz',
    body: 'Practice sets, playlists, and timed exams with progress tracking.',
  },
  {
    icon: Newspaper,
    title: 'Blog',
    body: 'Long-form writing where reading time earns its author revenue.',
  },
  {
    icon: ShoppingBag,
    title: 'Market',
    body: 'Products, sellers, and orders with a single checkout.',
  },
  {
    icon: Briefcase,
    title: 'Work',
    body: 'Freelance jobs, contracts, and milestones in one place.',
  },
  { icon: Sparkles, title: 'Stock', body: 'Digital assets from independent creators.' },
  {
    icon: Wrench,
    title: 'Tools',
    body: 'PDF, QR, notes, and image utilities that run in the browser.',
  },
];

export default function HomePage(): React.JSX.Element {
  return (
    <>
      <HomeRedirect />

      {/* Hero */}
      <section aria-labelledby="hero-heading" className="border-b border-border">
        <div className="container-shell px-md py-xxl lg:py-xxxl">
          <div className="mx-auto flex max-w-[720px] flex-col items-center gap-md text-center">
            <span className="rounded-full border border-border bg-surface px-sm py-1 text-caption text-muted">
              Now in early access
            </span>

            <h1 id="hero-heading" className="text-display text-balance">
              Everything you do online, in one place
            </h1>

            <p className="max-w-[56ch] text-body text-muted text-pretty">
              Social, messaging, learning, marketplaces, and work — sharing one identity, one
              permission model, and one account.
            </p>

            <div className="mt-xs flex w-full flex-col gap-xs sm:w-auto sm:flex-row">
              <Link href="/register" className={buttonClass('primary', 'lg')}>
                Create your account
              </Link>
              <Link href="/login" className={buttonClass('secondary', 'lg')}>
                Sign in
              </Link>
            </div>

            <p className="text-caption text-muted">Free to start. No card required.</p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section aria-labelledby="features-heading" className="border-b border-border">
        <div className="container-shell px-md py-xxl">
          <header className="mx-auto mb-lg flex max-w-[56ch] flex-col gap-1 text-center">
            <h2 id="features-heading" className="text-heading text-balance">
              Ten products, one account
            </h2>
            <p className="text-body text-muted">
              Each surface is built for its own job, and all of them understand the same identity.
            </p>
          </header>

          <ul className="grid gap-sm sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li
                key={title}
                className="flex flex-col gap-xs rounded-lg border border-border bg-surface p-md"
              >
                <span className="grid size-10 place-items-center rounded-md bg-primary/10 text-primary">
                  <Icon aria-hidden className="size-5" />
                </span>
                <h3 className="text-subheading">{title}</h3>
                <p className="text-small text-muted">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* About */}
      <section aria-labelledby="about-heading" className="border-b border-border">
        <div className="container-shell grid gap-lg px-md py-xxl lg:grid-cols-2 lg:items-center">
          <div className="flex flex-col gap-sm">
            <h2 id="about-heading" className="text-heading text-balance">
              Built like infrastructure, not like a website
            </h2>
            <p className="text-body text-muted text-pretty">
              Every part of the platform was designed for the load it will eventually carry: sharded
              data, a permission model that answers in microseconds, and a ledger that balances to
              the paisa.
            </p>
            <p className="text-body text-muted text-pretty">
              The same care goes into what you cannot see — rate limits that stop credential
              stuffing, sessions that die the moment a password changes, and an audit trail that
              cannot be edited.
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-sm">
            {[
              { value: '3 layers', label: 'Identity, permission, scope' },
              { value: '4', label: 'Access control layers' },
              { value: '16px', label: 'Minimum reading size' },
              { value: '44px', label: 'Minimum touch target' },
            ].map(({ value, label }) => (
              <div
                key={label}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-md"
              >
                <dt className="sr-only">{label}</dt>
                <dd className="text-heading text-primary">{value}</dd>
                <p aria-hidden className="text-caption text-muted">
                  {label}
                </p>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* Contact */}
      <section aria-labelledby="contact-heading">
        <div className="container-shell px-md py-xxl">
          <div className="mx-auto flex max-w-[56ch] flex-col items-center gap-sm text-center">
            <h2 id="contact-heading" className="text-heading">
              Get in touch
            </h2>
            <p className="text-body text-muted">
              Questions, partnerships, or press — we read every message.
            </p>
            <a
              href="mailto:hello@socialhub.example"
              className={buttonClass('secondary', 'md', 'mt-xs')}
            >
              hello@socialhub.example
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="container-shell flex flex-col gap-sm px-md py-lg sm:flex-row sm:items-center sm:justify-between">
          <p className="text-caption text-muted">© {new Date().getFullYear()} SocialHub</p>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-md">
              {NAV_ITEMS.slice(0, 5).map(({ key, label, href }) => (
                <li key={key}>
                  <Link href={href} className="text-caption text-muted hover:text-text">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </footer>
    </>
  );
}

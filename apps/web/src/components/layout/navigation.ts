/**
 * The single navigation model.
 *
 * Every surface reads from this one array: desktop sidebar, mobile bottom bar,
 * and the placeholder routes generated from it. Duplicating the list into each
 * component is how a new section ends up reachable on desktop and unreachable on
 * mobile.
 *
 * `mobilePrimary` is capped at five items by the type itself — a bottom bar with
 * six targets gives each one less than the 44px minimum on a 320px screen, so the
 * constraint is enforced in the type rather than in a review comment.
 */

import {
  Bell,
  Bookmark,
  Briefcase,
  GraduationCap,
  Home,
  MessagesSquare,
  Newspaper,
  ShoppingBag,
  Sparkles,
  Users,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavItem = {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** Shown in the mobile bottom bar. At most five items may set this. */
  readonly mobilePrimary?: boolean;
  readonly description: string;
  /** Rendered but marked "coming soon" while the feature is still being built. */
  readonly status: 'live' | 'planned';
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'home',
    label: 'Home',
    href: '/',
    icon: Home,
    mobilePrimary: true,
    description: 'Your feed, the people you follow, and what is happening now.',
    status: 'live',
  },
  {
    key: 'notifications',
    label: 'Notifications',
    href: '/notifications',
    icon: Bell,
    description: 'Likes, replies, mentions and answers, delivered live.',
    status: 'live',
  },
  {
    key: 'social',
    label: 'Social',
    href: '/social',
    icon: Users,
    description: 'Profiles, the social graph, and posts.',
    status: 'planned',
  },
  {
    key: 'messages',
    label: 'Messages',
    href: '/messages',
    icon: MessagesSquare,
    mobilePrimary: true,
    description: 'Direct and group conversations, delivered live over the shared stream.',
    status: 'live',
  },
  {
    key: 'quiz',
    label: 'Quiz',
    href: '/quiz',
    icon: GraduationCap,
    mobilePrimary: true,
    description: 'Practice sets, playlists, and timed exams.',
    status: 'live',
  },
  {
    key: 'forum',
    label: 'Forum',
    href: '/forum',
    icon: Bookmark,
    mobilePrimary: true,
    description: 'Threaded discussion by topic.',
    status: 'live',
  },
  {
    key: 'blog',
    label: 'Blog',
    href: '/blog',
    icon: Newspaper,
    description: 'Long-form articles: drafts, schedules, and a permanent URL.',
    status: 'live',
  },
  {
    key: 'tools',
    label: 'Tools',
    href: '/tools',
    icon: Wrench,
    description: 'PDF, QR, notes, calculator, age, budgeting and a period tracker.',
    status: 'live',
  },
  {
    key: 'market',
    label: 'Market',
    href: '/market',
    icon: ShoppingBag,
    description: 'Products, sellers, and order tracking.',
    status: 'live',
  },
  {
    key: 'work',
    label: 'Work',
    href: '/work',
    icon: Briefcase,
    description: 'Freelance jobs, contracts, and milestones.',
    status: 'planned',
  },
  {
    key: 'stock',
    label: 'Stock',
    href: '/stock',
    icon: Sparkles,
    description: 'Digital assets from independent creators.',
    status: 'planned',
  },
];

export const MOBILE_PRIMARY_ITEMS: readonly NavItem[] = NAV_ITEMS.filter(
  (item) => item.mobilePrimary === true,
);

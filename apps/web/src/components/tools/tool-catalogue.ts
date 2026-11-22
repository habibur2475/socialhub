/**
 * The tools catalogue — one entry per tool, used by the index page.
 *
 * Both names in this file matter: `folder` is the directory under
 * `apps/web/src/components/tools/` (and the matching folder in the kernel), and `href` is
 * the route. Keeping them in one table means a tool cannot exist without being listed, and
 * a listed tool cannot point at a route that was never created.
 */

import {
  Calculator,
  Cake,
  CalendarHeart,
  FilePen,
  NotebookPen,
  QrCode,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

export type ToolEntry = {
  readonly key: string;
  /** Mirrors the folder name in `components/tools/` and `kernel/src/tools/`. */
  readonly folder: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly description: string;
  /** Where the data lives: on the device, or on the server behind the account. */
  readonly storage: 'device' | 'account';
  /** Bengali name, shown under the English one for the tools written for a Bengali user. */
  readonly bengali?: string;
};

export const TOOLS: readonly ToolEntry[] = [
  {
    key: 'pdf-editor',
    folder: 'pdf-editor',
    label: 'PDF editor',
    href: '/tools/pdf-editor',
    icon: FilePen,
    description: 'Reorder, rotate, delete, duplicate and merge pages, then download the result.',
    storage: 'device',
  },
  {
    key: 'qr-code',
    folder: 'qr-code',
    label: 'QR code',
    href: '/tools/qr-code',
    icon: QrCode,
    description: 'Links, Wi-Fi, contacts, phone numbers and SMS, as a printable PNG.',
    storage: 'device',
  },
  {
    key: 'notes',
    folder: 'notes',
    label: 'Notes',
    href: '/tools/notes',
    icon: NotebookPen,
    description: 'Short notes that follow you to another device.',
    storage: 'account',
  },
  {
    key: 'calculator',
    folder: 'calculator',
    label: 'Calculator',
    href: '/tools/calculator',
    icon: Calculator,
    description: 'Four functions, parentheses and a remainder, on screen and on the keyboard.',
    storage: 'device',
  },
  {
    key: 'age-calculator',
    folder: 'age-calculator',
    label: 'Age calculator',
    href: '/tools/age-calculator',
    icon: Cake,
    description: 'Exact age in years, months and days, plus the next birthday.',
    storage: 'device',
  },
  {
    key: 'budget',
    folder: 'budget',
    label: 'Income and expenses',
    bengali: 'দৈনন্দিন আয়-ব্যয়ের হিসাব',
    href: '/tools/budget',
    icon: Wallet,
    description: 'A daily ledger by category, with what is left at the end of the month.',
    storage: 'device',
  },
  {
    key: 'period',
    folder: 'period',
    label: 'Period tracker',
    bengali: 'মেয়েদের পিরিয়ড ম্যানেজমেন্ট',
    href: '/tools/period',
    icon: CalendarHeart,
    description: 'Log cycles and symptoms; see an estimated next period. Stays on this device.',
    storage: 'device',
  },
];

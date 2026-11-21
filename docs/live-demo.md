# SocialHub — live demo guide

The stack is running in this sandbox and is visible in your browser as the
**SocialHub website** live preview (port 3000). The screenshots you asked for
cannot be produced here — browser binaries are blocked in this sandbox — so this
guide walks through the same pages directly.

## Sign in

Open **`/login`** and use a demo account:

| Email                  | Password              | What it shows               |
| ---------------------- | --------------------- | --------------------------- |
| `ada@socialhub.test`   | `SocialHub-demo-2026` | Public profile, 2 followers |
| `grace@socialhub.test` | `SocialHub-demo-2026` | Followers-only profile      |
| `linus@socialhub.test` | `SocialHub-demo-2026` | Private profile             |

These accounts are **already verified**, so login works directly. (Registering a
new account sends a 6-digit code to the development mail transport, which writes
to the API log rather than to a real inbox — that is why the demo accounts exist.)

## Pages to look at

| Route               | What to check                                                         |
| ------------------- | --------------------------------------------------------------------- |
| `/`                 | Marketing page — theme toggle, responsive layout                      |
| `/login`            | Form with real labels, inline validation, error states                |
| `/register`         | Username and display-name validation against the shared schema        |
| `/dashboard`        | Session details, appearance, and the new "Your profile" card          |
| `/settings/profile` | Edit display name and bio; three visibility options with explanations |
| `/u/ada_lovelace`   | Full public profile: bio, follower count, Follow button               |
| `/u/grace_hopper`   | Followers-only: bio and counts redacted, "restricted" notice          |
| `/u/linus_t`        | Private: same redaction, follow creates a _pending request_           |
| `/u/nobody`         | Deliberately identical to a profile you have been blocked from        |

## What to try, in order

1. Sign in as **ada**, then visit `/u/grace_hopper`. The bio is hidden — she chose
   _followers only_. Press **Follow**: the follower count stays hidden, because
   following grants the bio, not the audience metrics.
2. Visit `/u/linus_t` and press **Follow**. The button changes to **Requested**,
   not **Following** — the server accepted the request, not the follow.
3. Go to `/settings/profile`, change your bio, and switch visibility to _Private_.
   Refresh: the change persisted.
4. Sign in as **grace** (private-ish account) and visit `/u/ada_lovelace`. Press
   **Follow** — the count goes from 2 to 3, and **Following** replaces the button.
5. Try `/u/ada_lovelace` while signed out: you are redirected to `/login?next=…`,
   and land back on the profile after signing in.

## Design decisions you can see on screen

- **A hidden thing says so.** A redacted bio reads "This profile is restricted",
  and a hidden count renders as `—`. Neither is rendered as empty, because a
  blank profile is a different — and false — statement.
- **"Requested" vs "Following".** Follow is a two-step consensus for private
  accounts; the button reflects which step you are on.
- **Accessibility is structural.** Real `<label>` elements bound by `htmlFor`,
  `aria-describedby` on hints and errors, `aria-pressed` on the follow toggle,
  and `role="alert"` used once per error rather than on every keystroke.
- **Responsive by construction.** The bottom bar holds at most five items,
  enforced in the type; every target is at least 44 px.
- **Dark mode.** The toggle in the header follows the system by default and is
  applied before first paint, so there is no flash of the wrong theme.

## Running it yourself

```bash
pnpm install
pnpm --filter @socialhub/db run setup      # creates the role, database, migrations
pnpm -r build
pnpm --filter @socialhub/api start         # :4000
pnpm --filter @socialhub/web start         # :3000
```

The web app proxies `/api/*` to the API, so the browser only ever talks to one
origin — which is what makes `__Host-` cookies and `credentials: 'include'`
behave predictably.

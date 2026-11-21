# SocialHub — live demo guide

The stack is running in this sandbox and is visible in your browser as the
**SocialHub website** live preview (port 3000). The screenshots you asked for
cannot be produced here — browser binaries are blocked in this sandbox — so this
guide walks through the same pages directly.

## Sign in

Open **`/login`** and use a demo account:

| Email                  | Password              | What it shows                                             |
| ---------------------- | --------------------- | --------------------------------------------------------- |
| `ada@socialhub.test`   | `SocialHub-demo-2026` | Public profile, owns the seeded quiz set and forum thread |
| `grace@socialhub.test` | `SocialHub-demo-2026` | Followers-only profile, accepted follower of ada          |
| `linus@socialhub.test` | `SocialHub-demo-2026` | Private profile, follow of ada is still pending           |

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
| `/u/ada`            | Full public profile: bio, follower count, Follow button               |
| `/u/grace`          | Followers-only: bio and counts redacted, "restricted" notice          |
| `/u/linus`          | Private: same redaction, follow creates a _pending request_           |
| `/u/nobody`         | Deliberately identical to a profile you have been blocked from        |
| `/notifications`    | The inbox, live — see below                                           |
| `/quiz`             | Quiz library with the seeded "Engines and algorithms" set             |
| `/quiz/new`         | Build a set: add questions and options, mark the key                  |
| `/forum`            | Threads by category, with the seeded answered thread                  |
| `/forum/new`        | Start a thread in a real category                                     |

## What to try, in order

1. Sign in as **ada**, then visit `/u/grace`. The bio is hidden — she chose
   _followers only_. Press **Follow**: the follower count stays hidden, because
   following grants the bio, not the audience metrics.
2. Visit `/u/linus` and press **Follow**. The button changes to **Requested**,
   not **Following** — the server accepted the request, not the follow.
3. Go to `/settings/profile`, change your bio, and switch visibility to _Private_.
   Refresh: the change persisted.
4. Sign in as **grace** (private-ish account) and visit `/u/ada`. Press
   **Follow** — the count goes from 2 to 3, and **Following** replaces the button.
5. Try `/u/ada` while signed out: you are redirected to `/login?next=…`,
   and land back on the profile after signing in.

## Step 6: notifications, quiz and forum

### Notifications arrive live

Open **two browser windows side by side**, both signed in — one as **ada**, one as
**grace**. In grace's window, like one of ada's posts. Ada's bell updates without a
reload, and `/notifications` gains a row that says _"Grace Hopper liked your post"_.

The bell's dot turns green while the stream is connected and grey while it is
reconnecting; the badge caps at `99+` on purpose, because an exact count on an
active account is unreadable and quietly publishes how much activity the account
receives.

The stream is server-sent events at `/notifications/stream`, opened with `fetch`
and an `Authorization` header rather than with `EventSource` — `EventSource`
cannot send headers, and putting a token in a query string puts it in every access
log and in the browser's history.

### Collapsing is visible in the wording

Ask **grace** and **linus** to both like the same post. Ada still has **one** row,
which reads _"Grace Hopper and 1 other liked your post"_. Ten likes are one row
with a count and the last five faces, because a viral post must not be able to
make the inbox unusable. A block removes the row entirely — ada blocking an account
also silences its likes.

### The quiz key is withheld until you are graded

Sign in as **grace** and open `/quiz`, then the seeded set. The options are shown
with no indication of which is right: `isCorrect` is `null`, not `false`, because a
`false` would still tell you which options are _wrong_. Press **Start attempt**, the
countdown starts at five minutes, answer, and submit. Only now does the key appear,
with your picks and the correct ones marked independently — and a second submission
is refused with `409`.

Sign in as **ada** (the owner) and the key is visible immediately: an author has to
be able to check their own set.

### The forum accepts one answer

Open `/forum`, then the seeded thread. The accepted answer is pinned to the top with
a green border. Sign in as **grace** (the thread's author) and accept a _different_
answer: the endorsement moves, and the database's partial unique index still holds
exactly one. The answer counter is maintained by a trigger, so deleting an answer
brings it back down. A blocked reader loses the thread from the list, the detail
**and** the answers route at once — a block that stopped at the detail would still
hand over the conversation.

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
- **A notification is a sentence, not a row of icons.** "Ada and 2 others liked
  your post" is what a reader needs; the collapse count is spoken, not hidden.
- **Grading is reproducible.** The score is a pure function of the questions, the
  key and the stored answers — no clock, no randomness — so a disputed grade can be
  recomputed from the database at any time. An unanswered question counts as wrong
  and still counts toward the total, which is the only reading that makes
  "3 out of 10" mean three correct answers.

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

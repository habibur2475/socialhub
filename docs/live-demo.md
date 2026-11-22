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

| Route                   | What to check                                                           |
| ----------------------- | ----------------------------------------------------------------------- |
| `/`                     | Marketing page — theme toggle, responsive layout                        |
| `/login`                | Form with real labels, inline validation, error states                  |
| `/register`             | Username and display-name validation against the shared schema          |
| `/dashboard`            | Session details, appearance, and the new "Your profile" card            |
| `/settings/profile`     | Edit display name and bio; three visibility options with explanations   |
| `/u/ada`                | Full public profile: bio, follower count, Follow button                 |
| `/u/grace`              | Followers-only: bio and counts redacted, "restricted" notice            |
| `/u/linus`              | Private: same redaction, follow creates a _pending request_             |
| `/u/nobody`             | Deliberately identical to a profile you have been blocked from          |
| `/notifications`        | The inbox, live — see below                                             |
| `/quiz`                 | Quiz library with the seeded "Engines and algorithms" set               |
| `/quiz/new`             | Build a set: add questions and options, mark the key                    |
| `/forum`                | Threads by category, with the seeded answered thread                    |
| `/forum/new`            | Start a thread in a real category                                       |
| `/messages`             | Conversations, unread counts, and a live list                           |
| `/messages/new`         | Start a direct conversation or a group, by username                     |
| `/messages/[id]`        | One transcript: live messages, read cursor, composer, delete            |
| `/blog`                 | The archive: published articles, tag filters, "Mine"                    |
| `/blog/new`             | Write: live excerpt, reading time and slug preview                      |
| `/blog/[slug]`          | Read an article — or, as its author, publish, schedule, archive, delete |
| `/tools`                | Seven utilities, each saying whether it touches a server                |
| `/tools/pdf-editor`     | Reorder, rotate, delete, duplicate and merge PDF pages                  |
| `/tools/qr-code`        | A link, Wi-Fi, contact or SMS code, downloadable as a PNG               |
| `/tools/notes`          | Notes that follow you to another device                                 |
| `/tools/calculator`     | Keypad and keyboard go through the same rules                           |
| `/tools/age-calculator` | Exact age, weekday of birth, next birthday                              |
| `/tools/budget`         | দৈনন্দিন আয়-ব্যয়ের হিসাব — a daily ledger by category                 |
| `/tools/period`         | পিরিয়ড ট্র্যাকার — cycles and symptoms, on this device only            |

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

## Step 7: messaging

### A direct conversation is one row per pair

Sign in as **ada** and open `/u/grace`, then press **Message**. The conversation
opens. Now sign in as **grace** in a second window and press **Message** on ada's
profile: you land on **the same thread**, not a second one. Two people clicking at
the same instant produce one row as well — the unordered `dm_key` has a unique
index, and the insert is an upsert on it.

A stranger cannot open a conversation at all: with no follow relationship in either
direction the API answers `403`, and the reply is identical for an account that does
not exist, so the endpoint cannot be used to discover who is reachable.

### Messages arrive live on the same stream as notifications

Open `/messages/[id]` as grace, then send from ada's window. The message appears in
grace's transcript **and** moves the conversation to the top of her `/messages` list
with an unread count, without a reload. There is no second connection: the messaging
module publishes to the same hub the notification bell already listens on, because a
tab holds one stream and the browser caps connections per origin.

The unread count is not a flag. It is `count(*)` of other people's messages after the
reader's `last_read_message_id`, so opening a thread clears it, a message you sent
from another tab never raises it, and the cursor never moves backwards — an
out-of-order event from a second device cannot mark a read message unread again.

### A block ends the conversation in both directions

With a conversation open, sign in as grace and block ada from `/u/ada`. Both windows
lose the thread from the list and get `404` on the transcript and on any send — the
history included. Messaging has no "block but keep reading": a blocked person who
can still read has a channel, and a blocker who can still read has to keep looking
at someone they removed.

The same rule applies inside a group, and only to the two sides of the block: a
group is not a way around it, while an uninvolved member keeps the conversation.

### Groups are owned and lockable

`/messages/new` → **A group**: name it, list usernames, and create it. The creator is
the owner and can rename or lock it; a member who tries is refused with `403`, and a
locked group refuses every send with `412` — including the owner's. Members can leave
(`DELETE …/members/me`), and a direct conversation cannot be left at all, so nobody is
left talking to themselves.

### A retried send is not a second message

Every send carries a `clientId`. The composer keeps the same id until the send
succeeds, so a timeout followed by a press of **Send** returns the message that was
already stored rather than posting it twice. Deleting is soft: the row stays, the body
becomes _"This message was deleted"_, and only the sender can do it.

## Step 8: the blog

### A draft is not an article with a flag

Sign in as **ada**, open `/blog/new`, and write a title and a body. The reading time,
the excerpt and the URL are already filled in on the right, computed in the browser
by the **same kernel functions the server runs** — so the preview cannot flatter you.
Press **Save draft**, then open `/blog`: it is not there. Open `/blog?mine=true`: there
it is, marked _Draft_. Sign in as **grace** and paste the URL: `404`, identical to an
article that does not exist. A draft is invisible, not hidden.

The URL is derived from the title on the server, once, and it does not move when the
title changes — `/blog/shipping-a-monorepo-in-90-days` stays that address after a
rename, because a URL readers have already shared must not silently start pointing at
`404`. Choosing a URL that already exists is refused with `409` rather than quietly
becoming `-2`: a silent suffix is a link that disagrees with what the author typed.

### Publishing, and the difference between hidden and gone

Press **Publish now** on an article you wrote. Grace refreshes `/blog` and it is there,
in order, newest first. Publish a second article, and the archive reorders by
publication date, not by when you happened to save it.

The four states are not four booleans. `DRAFT → SCHEDULED → PUBLISHED → ARCHIVED`, and
the legal moves are a table in the kernel. Two consequences are visible:

- **Unpublish** a published article and it leaves the archive; publish it again and it
  returns to **its original date**, not the top. A correction is not a new article.
- **Archive** is one way. An archived article keeps its URL and its date but answers
  `404` to readers, and republishing it is refused with `412` — an archived slug is a
  tombstone with a body, and resurrecting it would silently reuse a link readers saw die.

Deleting is different again: the row is gone, the URL is free, and the article no
longer appears in **Mine** either.

### A schedule is a promise the database keeps without a worker

On an article, pick a moment a couple of minutes ahead and press **Schedule**. It is
not in the archive, and the page says when it goes live. Wait for that minute and
reload: it is there, with no cron, no queue and no "published by job" — due-ness is
decided inside the read query with the database's own `now()`, so the article is
readable the instant it is due and not one millisecond before, and the row keeps
saying `SCHEDULED` while the API reports `PUBLISHED`. A
schedule in the past is refused (`422`) with "choose a moment in the future, or publish
now", and a scheduled article can be rescheduled by picking a new time.

### Tags fold, and the tag cloud counts only what readers can see

Tags are typed freely: `PostgreSQL`, `State Management`, `monorepo`. They are folded to
lowercase and hyphens **before** validation, so a capital letter is not an error after
you have written eight hundred words. `?tag=Monorepo` finds `monorepo`, because the
filter folds the same way.

The tag cloud at `/api/v1/blog/tags` counts only published or due articles. A tag used
by one draft is not a tag yet — a cloud listing tags with nothing behind them is a list
of dead ends.

### A block hides the article from the reader, not the author

With grace reading ada's published article, block ada from `/u/ada`: grace gets `404`
on the article, and it leaves her archive. Ada still reads her own article, and still
edits it. The block is about what grace has to look at; it is not a way to delete
someone else's work.

### The body is Markdown, and never HTML

An article body accepts headings, lists, quotes, fenced code and inline emphasis. It
does **not** accept raw HTML, and it does not linkify: `<script>` in a body renders as
the characters `<script>`, because the renderer builds React elements from text rather
than handing a string to `dangerouslySetInnerHTML`. Links are deliberately out of scope
until there is a preview-and-allowlist story — a link in a stranger's article borrows
this origin's credibility. An unclosed code fence is refused when you save it (`422`),
because it is the one Markdown typo that silently breaks every heading after it.

## Step 9: the tools

Each tool is a folder in two places with the same name — `components/tools/<tool>/` for the
screen and `kernel/src/tools/<tool>/` for the arithmetic — so "where is the QR rule" has one
answer and the catalogue at `/tools` is generated from one list.

### Six of the seven never touch a server

Open `/tools`. Every card says where its data lives, and six say **on this device**. That
is not a label on a policy; it is what the code does. The budget ledger and the period log
read and write `localStorage`, the PDF never leaves the tab, and the QR encoder runs in the
page. Clear the site data in your browser and the ledgers are gone — which is the honest
trade for a tool that has no server to breach.

The seventh, **Notes**, says **in your account**, because a note you cannot open on your
phone is not a note. That is the only tool with an API, a database table and an owner check.

### A period log should not be a server record

Open `/tools/period` and log a day. The prediction says **"most likely between"** two dates,
never "you are fertile today": ovulation is anchored fourteen days before the _next_ period,
the fertile window is the six days ending there, and the whole thing is an estimate. Two
months of logging change the average, and one mistyped date is dropped rather than allowed
to shift every prediction. Nothing in the panel fetches anything — the network tab is empty
while you use it.

### The PDF editor's edits are an array, not a re-encode

Choose a PDF and reorder a page. It moves instantly, because the editor is not rewriting the
file: it is keeping a plan of "which source page goes where, at what rotation". Only
**Download** loads `pdf-lib` and writes a new file — which is why the page is 122 kB and not 400. Duplicating, deleting, rotating and merging are all the same operation on that plan,
`Undo` is the previous plan, and the export is named after what it is.

### A QR code refuses to be a delivery mechanism

Try `/tools/qr-code` with `javascript:alert(1)` as the address. It is refused: only `http`
and `https` are encoded, because the phone that scans a poster will happily run a scheme
that is not a web page. Switch to **Wi-Fi** and the password field is written into the code
and nowhere else — and the panel says out loud that a printed Wi-Fi code is a password
anyone who photographs it can use.

### Money and dates are integers, not guesses

`/tools/budget` keeps every amount as paisa and prints `৳ 1,250.50` by moving a decimal
point, never by formatting a float — a ledger that disagrees with the cash in an envelope by
one taka is a ledger nobody keeps. Paste `১২৫০.৫০` into the amount and it parses. Amounts
are always positive with a direction, so a refund is income rather than a negative expense,
and a category total cannot depend on which sign a row happened to use.

`/tools/age-calculator` works the same way in days: a calendar date is a `YYYY-MM-DD`
string, so a birthday does not move by a day for somebody east of UTC, a 29 February birthday
is celebrated on 1 March in a common year, and "days lived" is exact.

### Notes: the title is the first line, and the order is the index

Sign in as **ada** and open `/tools/notes`. Type `Shopping` on the first line and the list
row becomes Shopping — no title field. Make a note in a second browser window: it is there,
because notes are the one tool with a server. Pin it: it jumps to the top and stays there
even after you edit something newer, because pinning is a column and the list order is an
index, not a sort of whatever happened to be loaded. Search for a word in the middle of a
body: the request goes to the API, not a filter over the current page.

A stranger's note is a `404` on read, edit and delete — never a `403`, which would confirm
the id exists.

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
- **The conversation list never polls.** A message frame inserts or moves one row;
  refetching the inbox per message would throw away the scroll position to learn what
  the frame already carried.
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

/**
 * Seed data for the screenshots and for anyone clicking through the live demo.
 *
 * It talks to the API over HTTP exactly as a person would, because a seed that writes rows
 * directly can produce states the application would never create — a published article with
 * no excerpt, an order whose total does not add up.
 *
 * Idempotent: every step checks first and skips what already exists, so re-running it after
 * a partial failure finishes the job rather than duplicating the demo.
 */

import { writeFile } from 'node:fs/promises';

import { Client } from 'pg';

const BASE = process.env['API_BASE'] ?? 'http://localhost:4000';
const CONNECTION =
  process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:5432/socialhub';
const PASSWORD = 'SocialHub-demo-2026';

const client = new Client({ connectionString: CONNECTION });
await client.connect();

const { digestOtp } = await import('../apps/api/dist/modules/auth/domain/one-time-code.js');

/**
 * A minimal HTTP client.
 *
 * `fetch` rather than the app's own client: the seed is a client of the API, not part of it,
 * and it must keep working if the client is refactored.
 */
const call = async (path, options = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
};

/** Registers, verifies (by recovering the code the way the dev mail transport would show it), and logs in. */
const ensureActor = async (email, username, displayName, bio) => {
  const register = await call('/api/v1/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, username, displayName },
  });
  if (register.status !== 202 && register.status !== 409) {
    throw new Error(`${email}: register answered ${register.status}`);
  }

  const { rows } = await client.query(
    `SELECT vc.code_digest, a.id FROM verification_codes vc
       JOIN accounts a ON a.id = vc.account_id
      WHERE a.email = $1 AND vc.purpose = 'EMAIL_VERIFY'
      ORDER BY vc.created_at DESC LIMIT 1`,
    [email],
  );

  const row = rows[0];
  if (row !== undefined) {
    let code = '';
    for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
      const attempt = candidate.toString().padStart(6, '0');
      if (
        digestOtp({ accountId: row.id, purpose: 'EMAIL_VERIFY', code: attempt }).equals(
          row.code_digest,
        )
      ) {
        code = attempt;
        break;
      }
    }
    await call('/api/v1/auth/verify-email', { method: 'POST', body: { email, code } });
  }

  const login = await call('/api/v1/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  if (login.status !== 200) throw new Error(`${email}: login answered ${login.status}`);

  const token = login.body.accessToken;
  if (bio !== undefined) await call('/api/v1/profile', { method: 'PATCH', token, body: { bio } });

  const me = await call('/api/v1/auth/me', { token });
  return { token, id: me.body.id, username };
};

/** Creates a listing only if that seller does not have one with that title. */
const ensureListing = async (actor, input) => {
  const existing = await call('/api/v1/market/listings?mine=true', { token: actor.token });
  const found = (existing.body?.items ?? []).find((item) => item.title === input.title);
  if (found !== undefined) return found.id;

  const created = await call('/api/v1/market/listings', {
    method: 'POST',
    token: actor.token,
    body: { ...input, status: 'ACTIVE' },
  });
  if (created.status !== 201) throw new Error(`listing ${input.title}: ${created.status}`);
  return created.body.id;
};

const ada = await ensureActor(
  'ada@socialhub.test',
  'ada',
  'Ada Lovelace',
  'Mathematician. Writes about engines, algorithms and the occasional kettle.',
);
const grace = await ensureActor(
  'grace@socialhub.test',
  'grace',
  'Grace Hopper',
  'Compilers, debugging, and the occasional ship in a bottle.',
);
const linus = await ensureActor(
  'linus@socialhub.test',
  'linus',
  'Linus T.',
  'Kernel things. Mostly quiet.',
);

const POSTS = [
  [
    ada,
    'The Analytical Engine weaves algebraic patterns, just as the Jacquard loom weaves flowers and leaves.',
  ],
  [ada, 'Reading Note G again. The Bernoulli program really is the first published algorithm.'],
  [
    grace,
    'Found a moth in the relay. Logged it. That log entry is now the most famous bug report in the archive.',
  ],
  [grace, 'A compiler is a program that writes programs. It is the highest form of laziness.'],
  [linus, 'Quiet week. Rebased a branch. Nothing broke, which is suspicious.'],
];

for (const [actor, body] of POSTS) {
  const feed = await call(`/api/v1/profiles/${actor.username}/posts`, { token: actor.token });
  const seen = (feed.body?.items ?? []).some((post) => post.body === body);
  if (!seen) await call('/api/v1/posts', { method: 'POST', token: actor.token, body: { body } });
}

// Follows: grace and linus follow ada, so ada's notifications and feed are not empty.
for (const follower of [grace, linus]) {
  await call('/api/v1/social/follow', {
    method: 'POST',
    token: follower.token,
    body: { accountId: ada.id },
  });
}

// A direct conversation, so the messaging screen has something to show.
//
// The kernel only lets you *start* a conversation if you follow the person (or they follow
// you), which is deliberate: an inbox that anyone can write into is a spam channel. So the
// seed follows first — as a person would — rather than bypassing the rule.
await call('/api/v1/social/follow', {
  method: 'POST',
  token: ada.token,
  body: { accountId: grace.id },
});

const conversations = await call('/api/v1/messages/conversations', { token: ada.token });
if ((conversations.body?.items ?? []).length === 0) {
  const thread = await call('/api/v1/messages/direct', {
    method: 'POST',
    token: ada.token,
    body: { accountId: grace.id },
  });
  if (thread.status !== 201 && thread.status !== 200) {
    throw new Error(`demo conversation: ${thread.status}`);
  }

  const threadId = thread.body.id;
  for (const [actor, body] of [
    [ada, 'Loved your note on the moth in the relay.'],
    [grace, 'It is still in the archive. Say the word and I will bring the log entry.'],
    [ada, 'Please do. Bring the kettle too.'],
  ]) {
    await call(`/api/v1/messages/conversations/${threadId}/messages`, {
      method: 'POST',
      token: actor.token,
      body: { body },
    });
  }
}

// A forum thread with an accepted answer.
const categories = await call('/api/v1/forum/categories', { token: ada.token });
const category = (categories.body?.items ?? [])[0];
const threads = await call('/api/v1/forum/threads', { token: ada.token });
const hasThread = (threads.body?.items ?? []).some(
  (thread) => thread.title === 'How do you test a scheduler without a clock?',
);

if (category !== undefined && !hasThread) {
  const thread = await call('/api/v1/forum/threads', {
    method: 'POST',
    token: ada.token,
    body: {
      categoryId: category.id,
      title: 'How do you test a scheduler without a clock?',
      body: 'I have a scheduler I cannot drive forward in a test without sleeping. What do you do instead?',
    },
  });

  if (thread.status === 201) {
    const answer = await call(`/api/v1/forum/threads/${thread.body.id}/answers`, {
      method: 'POST',
      token: grace.token,
      body: {
        body: 'Inject the clock. If the code asks *now* instead of reading the wall clock, the test moves time itself.',
      },
    });

    if (answer.status === 201) {
      await call(`/api/v1/forum/threads/${thread.body.id}/answers/${answer.body.id}/accept`, {
        method: 'POST',
        token: ada.token,
      });
    }
  }
}

// One quiz set, with two questions.
const sets = await call('/api/v1/quiz/sets', { token: ada.token });
const hasQuiz = (sets.body?.items ?? []).some((set) => set.title === 'Engines and algorithms');

if (!hasQuiz) {
  await call('/api/v1/quiz/sets', {
    method: 'POST',
    token: ada.token,
    body: {
      title: 'Engines and algorithms',
      description: 'Three questions about computing before computers.',
      questions: [
        {
          prompt: 'Who wrote the first published algorithm?',
          options: [
            { label: 'Ada Lovelace', correct: true },
            { label: 'Alan Turing', correct: false },
            { label: 'Charles Babbage', correct: false },
          ],
        },
        {
          prompt: 'What was the first computer bug?',
          options: [
            { label: 'A moth', correct: true },
            { label: 'A rounding error', correct: false },
            { label: 'A power cut', correct: false },
          ],
        },
      ],
    },
  });
}

// One published article.
const articles = await call('/api/v1/blog/articles', { token: ada.token });
const hasArticle = (articles.body?.items ?? []).some(
  (article) => article.title === 'Why the market holds stock instead of counting it',
);

if (!hasArticle) {
  const article = await call('/api/v1/blog/articles', {
    method: 'POST',
    token: ada.token,
    body: {
      title: 'Why the market holds stock instead of counting it',
      body: [
        '## The problem',
        '',
        'Two buyers, one kettle. If the check and the write are two statements, both buyers read',
        '"one left" and both get a kettle.',
        '',
        '## The fix',
        '',
        '`UPDATE ... SET reserved = reserved + 1 WHERE stock - reserved >= 1` is one statement, so',
        'the second buyer gets zero rows and an honest answer.',
        '',
        '- A hold is not a sale.',
        '- A refund is not a cancellation.',
        '- A cart with two sellers is two parcels.',
      ].join('\n'),
      tags: ['design', 'market'],
    },
  });

  if (article.status === 201) {
    await call(`/api/v1/blog/articles/${article.body.id}/publish`, {
      method: 'POST',
      token: ada.token,
      body: { status: 'PUBLISHED' },
    });
  }
}

// A note, so the tools screen has one.
const notes = await call('/api/v1/tools/notes', { token: ada.token });
if ((notes.body?.items ?? []).length === 0) {
  await call('/api/v1/tools/notes', {
    method: 'POST',
    token: ada.token,
    body: { body: 'Shopping\nmilk\neggs\nclay for the kettle' },
  });
}

// Three listings, and one live order between grace and ada.
const kettle = await ensureListing(ada, {
  title: 'Hand-thrown clay kettle',
  description: '1.2 litres. Fired twice, holds heat for an hour.',
  price: '1250',
  stock: 3,
});
await ensureListing(grace, {
  title: 'Brass desk compass',
  description: 'A working compass in a brass case, from a ship that no longer exists.',
  price: '840.50',
  stock: 2,
});
await ensureListing(linus, {
  title: 'Mechanical keyboard, 87 keys',
  description: 'Quiet switches. No RGB, because it is a tool.',
  price: '3200',
  stock: 1,
});

const graceOrders = await call('/api/v1/market/orders?role=BUYING', { token: grace.token });
if ((graceOrders.body?.items ?? []).length === 0) {
  const order = await call('/api/v1/market/orders', {
    method: 'POST',
    token: grace.token,
    body: {
      lines: [{ listingId: kettle, quantity: 1 }],
      shippingAddress: '12 Example Road, Khulna 9100',
      quotedTotalMinor: 125_000 + 6_000,
    },
  });
  if (order.status !== 201) throw new Error(`demo order: ${order.status}`);
}

// ------------------------------------------------------------------------------ work
//
// Two jobs and one full contract, so the board has live work and the contract screen has
// something with real money in it. Everything here goes through the API — an award is a
// transaction, and a seed that wrote the rows itself would skip the transaction that makes the
// escrow balance true.

const OPEN_JOBS = [
  {
    client: ada,
    title: 'Write the launch announcement for a notebook app',
    description:
      'Two paragraphs and a headline. Plain English, no exclamation marks. I have the feature list; you bring the sentences.',
    category: 'writing',
    budget: '6500',
    days: 12,
  },
  {
    client: ada,
    title: 'Edit a five-minute how-to video down to two minutes',
    description:
      'Trim the pauses, keep every step in order, add captions for the three steps that only have narration. I have the raw footage and the script.',
    category: 'video',
    budget: '8000',
    days: 18,
  },
  {
    client: linus,
    title: 'Design a one-page logo sheet for a small tool shop',
    description:
      'Three directions, one page each, delivered as SVG plus a PNG preview. Black and white first — colour is the easy part.',
    category: 'design',
    budget: '4200',
    days: 9,
  },
  // Posted by grace, so ada is a *freelancer* on one job and a client on the others. Without
  // this the client's proposal inbox has nothing pending in it after the seed, and the award
  // screen — the one place the plan is typed — has no live proposal to plan for.
  {
    client: grace,
    title: 'Translate a product page from English into Bengali',
    description:
      'About 900 words. Keep the tone plain, not promotional. I will send the page and the glossary.',
    category: 'translation',
    budget: '3600',
    days: 15,
  },
];

for (const input of OPEN_JOBS) {
  const mine = await call('/api/v1/work/jobs?mine=true&openOnly=false', {
    token: input.client.token,
  });
  const exists = (mine.body?.items ?? []).some((job) => job.title === input.title);
  if (exists) continue;

  const created = await call('/api/v1/work/jobs', {
    method: 'POST',
    token: input.client.token,
    body: {
      title: input.title,
      description: input.description,
      category: input.category,
      budget: input.budget,
      currency: 'BDT',
      deadline: new Date(Date.now() + input.days * 86_400_000).toISOString(),
      status: 'OPEN',
    },
  });
  if (created.status !== 201) throw new Error(`job ${input.title}: ${created.status}`);
}

/**
 * Bids, from both directions.
 *
 * Every open job posted by ada gets a bid from grace, and every open job posted by grace gets
 * one from ada. Both accounts are therefore a client on some jobs and a freelancer on others —
 * which is what a marketplace actually looks like, and what puts a pending proposal on the award
 * screen of every fresh seed.
 */
const LETTERS = [
  'I have written four launch posts for developer tools this year. The shape I would use: one headline, one paragraph on the problem, one on what changes. Happy to send three recent samples.',
  'I have cut six product videos down to two minutes or less. The pause-trimming you describe is most of the work, and the captions need to match the narration word for word.',
  'I have translated two developer-facing pages into Bengali this year, keeping technical terms in English with a short gloss the first time. Nine hundred words is a day of careful work; I would rather promise three and deliver early.',
  'I have drawn marks for four small shops this year. Black and white first is the right instinct — the only way to find out whether a mark works before colour rescues it.',
];

const OPEN_TITLES = new Set(OPEN_JOBS.map((entry) => entry.title));

for (const [owner, bidder] of [
  [ada, grace],
  [grace, ada],
]) {
  const jobs = await call('/api/v1/work/jobs?openOnly=true', { token: bidder.token });
  const targets = (jobs.body?.items ?? []).filter(
    (job) => job.client.username === owner.username && !job.isClient && !job.hasProposed,
  );

  for (const [index, target] of targets.entries()) {
    if (!OPEN_TITLES.has(target.title)) continue;

    const proposed = await call(`/api/v1/work/jobs/${target.id}/proposals`, {
      method: 'POST',
      token: bidder.token,
      body: {
        // A little under the budget: below-budget bids are the interesting case for the award
        // screen, because the plan must add up to the *bid*, not to the posted budget.
        bid: ((target.budgetMinor * 92) / 100 / 100).toFixed(2),
        coverLetter: LETTERS[index % LETTERS.length],
        deliveryDays: 4,
      },
    });
    if (proposed.status !== 201) throw new Error(`proposal on ${target.title}: ${proposed.status}`);
  }
}

// One contract, awarded end to end: grace wins ada's job, delivers the first milestone, and
// ada has not approved it yet — so the contract screen shows a release waiting to happen, which
// is the state worth screenshotting.
const adaContracts = await call('/api/v1/work/contracts', { token: ada.token });
if ((adaContracts.body?.items ?? []).length === 0) {
  const mine = await call('/api/v1/work/jobs?mine=true&openOnly=false', { token: ada.token });
  const candidates = (mine.body?.items ?? []).filter((entry) => entry.isAcceptingProposals);

  // The job with a pending proposal on it — that is the award screen, and the seed should end
  // with the contract it produces rather than guessing at the first row.
  let job;
  let inbox = [];
  for (const candidate of candidates) {
    const proposals = (
      await call(`/api/v1/work/jobs/${candidate.id}/proposals`, { token: ada.token })
    ).body;
    const pending = (proposals ?? []).filter((proposal) => proposal.status === 'PENDING');
    if (pending.length > 0) {
      job = candidate;
      inbox = pending;
      break;
    }
  }

  if (job !== undefined && inbox.length > 0) {
    const chosen = inbox[0];
    const half = Math.floor(chosen.bidMinor / 2);

    const awarded = await call(`/api/v1/work/jobs/${job.id}/actions`, {
      method: 'POST',
      token: ada.token,
      body: {
        action: 'AWARD',
        proposalId: chosen.id,
        milestones: [
          { title: 'Rough cut', amount: (half / 100).toFixed(2) },
          {
            title: 'Finished cut with captions',
            amount: ((chosen.bidMinor - half) / 100).toFixed(2),
          },
        ],
      },
    });
    if (awarded.status !== 200)
      throw new Error(`award: ${awarded.status} ${awarded.body?.error?.message}`);

    const contracts = await call('/api/v1/work/contracts', { token: grace.token });
    const contract = (contracts.body?.items ?? [])[0];

    if (contract !== undefined) {
      // The freelancer starts and delivers the first milestone; ada leaves it in review.
      await call(`/api/v1/work/jobs/${job.id}/actions`, {
        method: 'POST',
        token: grace.token,
        body: { action: 'START' },
      });
      await call(
        `/api/v1/work/contracts/${contract.id}/milestones/${contract.milestones[0].id}/actions`,
        { method: 'POST', token: grace.token, body: { action: 'SUBMIT' } },
      );
    }
  }
}

/**
 * Writes the ids the tour needs.
 *
 * The tour must not guess a UUID: a hardcoded one is a second source of truth that goes
 * wrong the first time the seed is run against a fresh database. Ids that came out of the
 * API during the seed are recorded here, and the tour reads them.
 */
const sampleThread = (await client.query('SELECT id FROM forum_threads LIMIT 1')).rows[0];
const sampleQuiz = (await client.query('SELECT id FROM quiz_sets LIMIT 1')).rows[0];
const sampleNote = (await client.query('SELECT id FROM notes LIMIT 1')).rows[0];
const samplePost = (await client.query('SELECT id FROM posts LIMIT 1')).rows[0];
const sampleOrder = (await client.query('SELECT id FROM market_orders ORDER BY created_at LIMIT 1'))
  .rows[0];

const sampleJob = (
  await client.query("SELECT id FROM work_jobs WHERE status <> 'DRAFT' ORDER BY created_at LIMIT 1")
).rows[0];
const sampleContract = (
  await client.query('SELECT id FROM work_contracts ORDER BY created_at LIMIT 1')
).rows[0];

const ids = {
  thread: sampleThread?.id ?? null,
  job: sampleJob?.id ?? null,
  contract: sampleContract?.id ?? null,
  quiz: sampleQuiz?.id ?? null,
  note: sampleNote?.id ?? null,
  post: samplePost?.id ?? null,
  order: sampleOrder?.id ?? null,
  conversation: null,
};

const conversationRows = await client.query('SELECT id FROM message_threads LIMIT 1');
ids.conversation = conversationRows.rows[0]?.id ?? null;

await client.end();
console.log('seed: demo accounts and content are in place');
console.log(`seed: ids ${JSON.stringify(ids)}`);

// Written next to the screenshots so the tour can address a real thread, quiz, note and
// order without a second query and without a hardcoded UUID.
await writeFile('docs/screenshots/demo-ids.json', `${JSON.stringify(ids, null, 2)}\n`);

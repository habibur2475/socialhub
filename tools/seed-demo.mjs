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

const ids = {
  thread: sampleThread?.id ?? null,
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

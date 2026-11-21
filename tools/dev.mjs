/**
 * Development runner.
 *
 * Starts the API and the web app together, because the web app proxies `/api/*` to
 * the API and neither is useful alone. Running two terminals is a papercut that
 * becomes a bug: someone starts only the web app, sees a 502 on login, and spends
 * ten minutes on it.
 *
 * Deliberately a plain child-process supervisor rather than a task-runner
 * dependency: the requirement is "start two processes and stop them together",
 * which is thirty lines, not a framework.
 *
 * Output is prefixed and coloured per service. With two servers interleaving on
 * one terminal, an unprefixed log line is unattributable.
 */

import { spawn } from 'node:child_process';

const RESET = '\u001b[0m';
const COLOURS = { api: '\u001b[36m', web: '\u001b[35m' };

const SERVICES = [
  { name: 'api', filter: '@socialhub/api', script: 'dev', port: 4000 },
  { name: 'web', filter: '@socialhub/web', script: 'dev', port: 3000 },
];

const children = [];
let shuttingDown = false;

const prefix = (name, chunk) => {
  const colour = COLOURS[name] ?? '';
  return chunk
    .toString()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `${colour}[${name}]${RESET} ${line}\n`)
    .join('');
};

const start = ({ name, filter, script }) => {
  // `corepack pnpm` because pnpm is not guaranteed to be on PATH in every
  // environment; corepack ships with Node.
  const child = spawn('corepack', ['pnpm', '--filter', filter, 'run', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  child.stdout.on('data', (chunk) => process.stdout.write(prefix(name, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(name, chunk)));

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    // One service dying must take the other down: a half-running stack produces
    // confusing 502s rather than an obvious failure.
    console.error(`[${name}] exited (${signal ?? code}). Stopping the others.`);
    shutdown(code ?? 1);
  });

  children.push(child);
  return child;
};

const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }

  // Give the children a moment to close their listeners, then leave.
  setTimeout(() => process.exit(code), 500).unref();
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

for (const service of SERVICES) start(service);

console.log(
  `Starting ${SERVICES.map(({ name, port }) => `${name} (http://localhost:${port})`).join(' and ')}`,
);
console.log('Press Ctrl+C to stop both.\n');

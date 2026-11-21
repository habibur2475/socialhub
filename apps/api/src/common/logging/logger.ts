/**
 * Structured logging.
 *
 * One JSON object per line, because the production sink is Loki/Elastic and a
 * parser is more reliable than a regex. The logger redacts by key rather than by
 * value: a password field is dangerous regardless of its content, and value
 * scanning misses anything nested or encoded.
 */

import { Injectable, type LoggerService } from '@nestjs/common';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

const REDACTED = '[redacted]';

/**
 * Substring match by design: a field named `refreshToken`, `otpCode` or
 * `authorizationHeader` must be redacted even though none matches exactly.
 *
 * The cost of that breadth is false positives, which are handled by the explicit
 * allowlist below rather than by weakening the pattern. A key may only be added
 * to the allowlist when it is provably not a secret — `errorCode` holds a value
 * from the closed `ERROR_CODES` set, for example.
 */
const SENSITIVE_KEY_PATTERN =
  /pass(word)?|secret|token|cookie|authorization|otp|code|mfa|credential|api[-_]?key|private[-_]?key/i;

const NEVER_REDACT: ReadonlySet<string> = new Set(['errorCode']);

type LogValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | LogValue[]
  | { [key: string]: LogValue };

const redact = (value: unknown, depth = 0): LogValue => {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack ?? null };
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (typeof value === 'object') {
    const output: { [key: string]: LogValue } = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const sensitive = !NEVER_REDACT.has(key) && SENSITIVE_KEY_PATTERN.test(key);
      output[key] = sensitive ? REDACTED : redact(entry, depth + 1);
    }
    return output;
  }
  return String(value);
};

export type LogContext = {
  readonly traceId?: string;
  readonly accountId?: string;
  readonly [key: string]: unknown;
};

@Injectable()
export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  public constructor(level: LogLevel = 'info') {
    this.threshold = LEVEL_WEIGHT[level];
  }

  public log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  public error(message: unknown, trace?: string, context?: string): void {
    this.write('error', message, context, trace);
  }

  public warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  public debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  public verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  public fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  /** Emits a structured event; the primary API used by application code. */
  public event(level: LogLevel, event: string, data: LogContext = {}): void {
    this.write(level, event, undefined, undefined, data);
  }

  private write(
    level: LogLevel,
    message: unknown,
    context?: string,
    trace?: string,
    data?: LogContext,
  ): void {
    if (LEVEL_WEIGHT[level] > this.threshold) return;

    const record = {
      ts: new Date().toISOString(),
      level,
      ...(context === undefined ? {} : { context }),
      message: typeof message === 'string' ? message : redact(message),
      ...(trace === undefined ? {} : { trace }),
      ...(data === undefined ? {} : { data: redact(data) }),
    };

    const line = JSON.stringify(record);
    if (level === 'fatal' || level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

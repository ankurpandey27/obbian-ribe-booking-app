import { LoggerService, LogLevel } from '@nestjs/common';
import { RequestContext } from './request-context';

/**
 * Severity ordering. `LOG_LEVEL=warn` emits fatal/error/warn and drops the
 * rest, which is the shape every log backend and on-call engineer expects.
 */
const SEVERITY: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  log: 3,
  debug: 4,
  verbose: 5,
};

/** `info` is the conventional name for what Nest calls `log`. */
const LEVEL_ALIASES: Record<string, LogLevel> = {
  fatal: 'fatal',
  error: 'error',
  warn: 'warn',
  warning: 'warn',
  info: 'log',
  log: 'log',
  debug: 'debug',
  verbose: 'verbose',
  trace: 'verbose',
};

/**
 * Keys whose values are never safe to print (AGENTS §6). Matched
 * case-insensitively as a substring, so `refreshToken`,
 * `x-razorpay-signature` and `cardNumber` are all caught. A backstop, not a
 * licence to pass secrets to the logger — the expensive failure mode is an
 * engineer logging a whole DTO during an incident.
 */
const REDACT_PATTERN =
  /(token|secret|password|passwd|otp|authorization|signature|apikey|api_key|cvv|card|upi|vpa|accountnumber|account_number|ifsc)/i;

const REDACTED = '[REDACTED]';

/** Cap on serialised metadata, so one huge object cannot flood the pipeline. */
const MAX_META_CHARS = 4_000;

export interface AppLoggerOptions {
  /** `json` for machine-parseable lines, `pretty` for local development. */
  format: 'json' | 'pretty';
  /** Minimum severity to emit. */
  level: string;
  /** Overridable for tests. */
  now?: () => Date;
}

/**
 * AppLogger — structured application logging.
 *
 * WHY REPLACE ConsoleLogger: its human-formatted, ANSI-coloured output needs
 * fragile regexes to parse and splits stack traces across records — neither
 * is workable for querying by `requestId` during an incident.
 *
 * WHY NOT AN INJECTABLE PROVIDER: Nest needs the logger before the DI
 * container exists (`bufferLogs: true` replays boot logs into whatever logger
 * is installed); it is constructed directly in `main.ts` from config.
 *
 * Every line carries the ambient `requestId` when one exists, so one
 * request's guard rejections, service warnings and error stack can be pulled
 * together with a single query.
 */
export class AppLogger implements LoggerService {
  private readonly threshold: number;
  private readonly json: boolean;
  private readonly now: () => Date;

  constructor(options: AppLoggerOptions) {
    const level = LEVEL_ALIASES[options.level?.toLowerCase()] ?? 'log';
    this.threshold = SEVERITY[level];
    this.json = options.format !== 'pretty';
    this.now = options.now ?? (() => new Date());
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('log', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  /**
   * Serialise one record.
   *
   * Nest's calling convention is `(message, ...params, context)` where the
   * trailing string is the logger context (`RidesService`), and `error()` may
   * also receive a stack string. Both are unpacked here so `context` and
   * `stack` become real fields instead of being concatenated into the message.
   */
  private write(level: LogLevel, message: unknown, params: unknown[]): void {
    if (SEVERITY[level] > this.threshold) return;

    const rest = [...params];
    let context: string | undefined;
    if (rest.length > 0 && typeof rest[rest.length - 1] === 'string') {
      context = rest.pop() as string;
    }

    let stack: string | undefined;
    if (message instanceof Error) {
      stack = message.stack;
      message = message.message;
    }
    // `error(msg, stack, context)` — a remaining multi-line string is a stack.
    if (!stack && rest.length > 0 && typeof rest[0] === 'string') {
      const candidate = rest[0];
      if (candidate.includes('\n    at ')) {
        stack = candidate;
        rest.shift();
      }
    }

    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level: level === 'log' ? 'info' : level,
      msg: this.stringify(message),
    };
    if (context) record.context = context;

    const requestId = RequestContext.requestId();
    if (requestId) record.requestId = requestId;
    const userId = RequestContext.get()?.userId;
    if (userId) record.userId = userId;

    if (stack) record.stack = stack;
    if (rest.length > 0) record.meta = rest.map((p) => this.redact(p));

    // error/fatal to stderr so log routing can split severity by stream, as
    // Nest's own logger does; everything else to stdout.
    const stream =
      SEVERITY[level] <= SEVERITY.error ? process.stderr : process.stdout;
    stream.write(`${this.format(record)}\n`);
  }

  private format(record: Record<string, unknown>): string {
    if (this.json) {
      const line = this.safeJson(record);
      if (line.length <= MAX_META_CHARS) return line;
      // Drop the metadata rather than slicing the string: a truncated JSON line
      // is unparseable, so the log shipper would discard the whole record —
      // losing the message that mattered in order to keep detail that did not.
      return this.safeJson({ ...record, meta: '[truncated]' });
    }
    const parts = [
      String(record.ts),
      String(record.level).toUpperCase().padEnd(5),
      record.context ? `[${String(record.context)}]` : '',
      String(record.msg),
      record.requestId ? `req=${String(record.requestId)}` : '',
    ].filter(Boolean);
    const head = parts.join(' ');
    return record.stack ? `${head}\n${String(record.stack)}` : head;
  }

  private stringify(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message === null || message === undefined) return String(message);
    if (typeof message === 'object') return this.safeJson(this.redact(message));
    return String(message);
  }

  /**
   * Deep-copy with sensitive keys masked. Depth-limited and cycle-safe: a
   * logger that throws on a self-referential object turns a diagnostic call
   * into a new failure.
   */
  private redact(
    value: unknown,
    depth = 0,
    seen = new WeakSet<object>(),
  ): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 4) return '[Object]';
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v) => this.redact(v, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_PATTERN.test(key)
        ? REDACTED
        : this.redact(val, depth + 1, seen);
    }
    return out;
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value) ?? '{}';
    } catch {
      return JSON.stringify({
        ts: this.now().toISOString(),
        level: 'error',
        msg: 'log record could not be serialised',
      });
    }
  }
}

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextStore {
  requestId: string;
  /** Populated by the auth guard once the token is verified. */
  userId?: string;
  /** Route template, set by the metrics interceptor once routing is known. */
  route?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Request-scoped correlation via AsyncLocalStorage.
 *
 * WHY ALS AND NOT A REQUEST-SCOPED PROVIDER: request scope makes Nest
 * instantiate a fresh provider tree per request for every consumer in the
 * injection chain — a bad trade when the goal is printing an id. ALS costs
 * one context read.
 *
 * WHY A MIDDLEWARE (not an interceptor) OWNS `run()`: an interceptor returns
 * an Observable, and the handler body executes on subscription — *outside*
 * the interceptor's synchronous call frame, so an ALS context established
 * there does not reliably cover the handler. Express middleware calls
 * `next()` inside `run()`, so the whole downstream chain inherits the context.
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, fn: () => T): T {
    return storage.run(store, fn);
  },

  /** Current store, or undefined outside a request (workers, cron, boot). */
  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  /**
   * No-op outside a request rather than throwing: background jobs legitimately
   * log without a context, and observability code must never be the thing
   * that breaks them.
   */
  set(patch: Partial<RequestContextStore>): void {
    const store = storage.getStore();
    if (!store) return;
    Object.assign(store, patch);
  },
};

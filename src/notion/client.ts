import {
  Client,
  APIResponseError,
  RequestTimeoutError,
  UnknownHTTPResponseError,
} from '@notionhq/client';

export interface NotionClientOptions {
  token: string;
  notionVersion?: string;
}

// Wrap the SDK so every request gets a longer timeout, a global rate
// throttle, and automatic retry on transient failures. The default
// timeout is 60s; bumped to 120s because the deep canonical-DB scan
// can chain enough requests on a slow Notion that any one of them
// blows past 60s.
export function createNotionClient(opts: NotionClientOptions): Client {
  const client = new Client({
    auth: opts.token,
    notionVersion: opts.notionVersion ?? '2025-09-03',
    timeoutMs: 120_000,
  });

  // The SDK's typed methods (pages.retrieve, blocks.children.list,
  // search, etc.) all funnel through `client.request`. Patching it
  // once throttles + retries every HTTP call without double-wrapping.
  const origRequest = client.request.bind(client) as (args: unknown) => Promise<unknown>;
  (client as unknown as { request: typeof origRequest }).request = (args: unknown) =>
    withRetry(() => throttle(() => origRequest(args)));

  return client;
}

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
// Notion's rate-limit response says "try again in a few minutes" with
// no programmatic backoff hint exposed by the SDK. Cap rate-limit
// waits high enough to ride out the cooldown (3min) rather than burn
// through retries while still well under it.
const RATE_LIMIT_BASE_DELAY_MS = 30_000;
const RATE_LIMIT_MAX_DELAY_MS = 180_000;

// Notion's documented limit is "an average of 3 requests/second" per
// integration measured on a rolling window. Empirically a 400ms floor
// (2.5 req/s) still trips throttling on multi-database pulls that run
// 1000+ calls sustained, so we drop to 500ms (2 req/s) for headroom.
// The queue is global to the client so concurrent callers don't bypass it.
const MIN_REQUEST_INTERVAL_MS = 500;
let lastRequestAt = 0;
let requestChain: Promise<unknown> = Promise.resolve();

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const next = requestChain.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - now);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call rejects, so a single
  // failure doesn't poison every subsequent request.
  requestChain = next.catch(() => undefined);
  return next as Promise<T>;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt === MAX_ATTEMPTS) throw err;
      lastErr = err;
      const isRateLimited =
        err instanceof APIResponseError && err.code === 'rate_limited';
      const baseDelay = isRateLimited ? RATE_LIMIT_BASE_DELAY_MS : BASE_DELAY_MS;
      const maxDelay = isRateLimited ? RATE_LIMIT_MAX_DELAY_MS : MAX_DELAY_MS;
      const delay = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 1_000);
      // Make retries observable in CI logs so a slow/rate-limited
      // run doesn't look silently stuck.
      const code = (err as { code?: string }).code ?? (err as Error).name;
      console.error(
        `[notion-retry] attempt ${attempt}/${MAX_ATTEMPTS} failed (${code}); ` +
          `retrying in ${delay + jitter}ms`,
      );
      await sleep(delay + jitter);
    }
  }
  throw lastErr;
}

function isTransient(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return true;
  if (err instanceof APIResponseError) {
    if (TRANSIENT_HTTP_STATUSES.has(err.status)) return true;
    if (err.code === 'rate_limited') return true;
  }
  // 5xx responses without a JSON body (e.g. CDN 502/504) come through
  // as UnknownHTTPResponseError, not APIResponseError.
  if (err instanceof UnknownHTTPResponseError) {
    if (TRANSIENT_HTTP_STATUSES.has(err.status)) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

export function pageIdEquals(a: string, b: string): boolean {
  return normalizeId(a) === normalizeId(b);
}

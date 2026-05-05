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

// Wrap the SDK so every request gets a longer timeout and automatic
// retry on transient failures (timeouts, 5xx, 429). The default
// timeout is 60s; bumped to 120s because the deep canonical-DB scan
// can chain enough requests on a slow Notion that any one of them
// blows past 60s. Retry uses exponential backoff capped at 30s.
export function createNotionClient(opts: NotionClientOptions): Client {
  const client = new Client({
    auth: opts.token,
    notionVersion: opts.notionVersion ?? '2025-09-03',
    timeoutMs: 120_000,
  });

  // The SDK's typed methods (pages.retrieve, blocks.children.list,
  // search, etc.) all funnel through `client.request`. Patching it
  // once retries every HTTP call without double-wrapping.
  const origRequest = client.request.bind(client) as (args: unknown) => Promise<unknown>;
  (client as unknown as { request: typeof origRequest }).request = (args: unknown) =>
    withRetry(() => origRequest(args));

  return client;
}

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err) || attempt === MAX_ATTEMPTS) throw err;
      lastErr = err;
      const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 250);
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
